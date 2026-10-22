/**
 * Local AI offload (Context Density, Phase 4) — a small language
 * model running entirely in the browser via WebLLM/WebGPU, used for
 * ONE job: upgrading file summaries from extractive to abstractive.
 *
 * Design constraints, in order:
 *  1. OPTIONAL and off by default. Capability-gated on WebGPU; every
 *     failure mode degrades silently to the deterministic extractive
 *     summaries, which remain the floor everywhere.
 *  2. ZERO network requests to any model provider: inference is
 *     local; the only downloads are the runtime (pinned CDN build)
 *     and the model weights, fetched once and cached by the browser.
 *  3. Summaries stay PURE FUNCTIONS OF CONTENT (Phase 1 discipline):
 *     an abstractive summary is cached under the file's content hash,
 *     so it can never go stale and never depends on hidden state.
 */

export interface LocalModelOption {
  id: string;
  label: string;
  sizeNote: string;
  /** q4f16 builds need the WebGPU shader-f16 feature; q4f32 builds run on any adapter. */
  requiresF16: boolean;
}

export const LOCAL_MODELS: LocalModelOption[] = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1.5B', sizeNote: '~1.0 GB download · best summaries · desktop recommended', requiresF16: true },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1B', sizeNote: '~0.75 GB download · balanced', requiresF16: true },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 0.5B', sizeNote: '~0.4 GB download · lightest · phone friendly', requiresF16: true },
  { id: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 1.5B (compatibility)', sizeNote: '~1.0 GB download · runs without GPU float16 · slower', requiresF16: false },
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 · 1B (compatibility)', sizeNote: '~0.75 GB download · runs without GPU float16 · slower', requiresF16: false },
  { id: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC', label: 'Qwen 2.5 · 0.5B (compatibility)', sizeNote: '~0.4 GB download · runs without GPU float16 · phone friendly', requiresF16: false },
];

/* ---------------- adapter probe ----------------
 * Presence of navigator.gpu is NOT enough: many Android devices
 * expose the API but return no usable adapter, and the q4f16 model
 * builds additionally need the shader-f16 feature. Probe for the
 * real thing before offering to start anything. */

export interface AdapterInfo { hasAdapter: boolean; shaderF16: boolean }

let adapterInfo: AdapterInfo | null = null;

export async function probeLocalAiAdapter(): Promise<AdapterInfo> {
  if (adapterInfo) return adapterInfo;
  if (!localAiSupported()) {
    adapterInfo = { hasAdapter: false, shaderF16: false };
    return adapterInfo;
  }
  try {
    const gpu = (navigator as unknown as { gpu: { requestAdapter: () => Promise<{ features?: Set<string> } | null> } }).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      adapterInfo = { hasAdapter: false, shaderF16: false };
    } else {
      adapterInfo = { hasAdapter: true, shaderF16: !!adapter.features?.has?.('shader-f16') };
    }
  } catch {
    adapterInfo = { hasAdapter: false, shaderF16: false };
  }
  setState({ adapter: adapterInfo });
  return adapterInfo;
}

export function modelCompatible(option: LocalModelOption, adapter: AdapterInfo | null): boolean {
  if (!adapter) return true; // unknown yet — don't block
  if (!adapter.hasAdapter) return false;
  return !option.requiresF16 || adapter.shaderF16;
}

/** The requested model if it can run here, else its closest compatible sibling. */
export function pickCompatibleModel(requestedId: string, adapter: AdapterInfo | null): string {
  const requested = LOCAL_MODELS.find((option) => option.id === requestedId);
  if (!requested || !adapter || modelCompatible(requested, adapter)) return requestedId;
  const sibling = LOCAL_MODELS.find((option) => option.id === requestedId.replace('q4f16_1', 'q4f32_1'));
  if (sibling && modelCompatible(sibling, adapter)) return sibling.id;
  const anyCompatible = LOCAL_MODELS.find((option) => modelCompatible(option, adapter));
  return anyCompatible ? anyCompatible.id : requestedId;
}

/** Provider/runtime errors, translated into plain platform words. */
export function friendlyLocalAiError(raw: string): string {
  const message = raw || '';
  if (/compatible GPU|requestAdapter|no adapter|failed to get adapter/i.test(message)) {
    return "Your device's GPU can't run the local model — WebGPU found no usable adapter. Local AI stays off and everything else is unaffected. It may still work in desktop Chrome or on a newer device.";
  }
  if (/shader-f16|float16|f16/i.test(message)) {
    return "That model build needs GPU float16 support, which this device doesn't expose. Pick a (compatibility) build from the list — those run without it.";
  }
  if (/fetch|network|404|download/i.test(message)) {
    return "The local model files couldn't be downloaded. Check the connection and try again — nothing else is affected.";
  }
  return `The local model couldn't start (${message.slice(0, 160)}). Everything else works as before.`;
}
export const DEFAULT_LOCAL_MODEL = LOCAL_MODELS[0].id;

const WEBLLM_CDN: string = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';
const PREFS_KEY = 'openforge-workbench-local-ai';
const SUMMARY_CACHE_KEY = 'openforge-workbench-abstractive-summaries';
const SUMMARY_CACHE_CAP = 400;

/* ---------------- capability + preferences ---------------- */

export function localAiSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  } catch {
    return false;
  }
}

export type LocalAiTransport = 'webgpu' | 'server';

export interface LocalAiPrefs {
  enabled: boolean;
  modelId: string;
  transport: LocalAiTransport;
  serverUrl: string;
  serverToken: string;
  serverModel: string;
}

/** Server-side inference models (mirror agent/inference.mjs INFERENCE_MODELS). */
export const SERVER_MODELS: Array<{ id: string; label: string }> = [
  { id: 'qwen-1.5b', label: 'Qwen 2.5 · 1.5B (recommended) — ~1.1 GB on the server' },
  { id: 'llama-1b', label: 'Llama 3.2 · 1B — ~0.8 GB on the server' },
  { id: 'qwen-0.5b', label: 'Qwen 2.5 · 0.5B (lightest) — ~0.5 GB on the server' },
];
export const DEFAULT_SERVER_MODEL = 'qwen-1.5b';

// The companion's URL/token double as the inference server's — one
// machine, one token, two features — so prefill from its storage.
function companionPrefill(): { serverUrl: string; serverToken: string } {
  try {
    return {
      serverUrl: localStorage.getItem('openforge-companion-url') || '',
      serverToken: localStorage.getItem('openforge-companion-token') || '',
    };
  } catch {
    return { serverUrl: '', serverToken: '' };
  }
}

export function loadLocalAiPrefs(): LocalAiPrefs {
  const prefill = companionPrefill();
  const defaults: LocalAiPrefs = { enabled: false, modelId: DEFAULT_LOCAL_MODEL, transport: 'webgpu', serverUrl: prefill.serverUrl, serverToken: prefill.serverToken, serverModel: DEFAULT_SERVER_MODEL };
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as Partial<LocalAiPrefs> | null;
    if (parsed && typeof parsed === 'object') {
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
        modelId: typeof parsed.modelId === 'string' ? parsed.modelId : defaults.modelId,
        transport: parsed.transport === 'server' ? 'server' : 'webgpu',
        serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl ? parsed.serverUrl : defaults.serverUrl,
        serverToken: typeof parsed.serverToken === 'string' && parsed.serverToken ? parsed.serverToken : defaults.serverToken,
        serverModel: typeof parsed.serverModel === 'string' ? parsed.serverModel : defaults.serverModel,
      };
    }
  } catch { /* fall through */ }
  return defaults;
}

export function saveLocalAiSettings(patch: Partial<LocalAiPrefs>): LocalAiPrefs {
  const next = { ...loadLocalAiPrefs(), ...patch };
  saveLocalAiPrefs(next);
  return next;
}

function saveLocalAiPrefs(prefs: LocalAiPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* best-effort */ }
}

export function currentTransport(): LocalAiTransport {
  return loadLocalAiPrefs().transport;
}

/* ---------------- state machine ---------------- */

export type LocalAiStatus = 'unsupported' | 'no-gpu' | 'off' | 'available' | 'loading' | 'ready' | 'error';

export interface LocalAiState {
  status: LocalAiStatus;
  modelId: string;
  transport: LocalAiTransport;
  adapter: AdapterInfo | null;
  progress: number; // 0..1 while loading
  progressText: string;
  error: string | null;
  enriching: { done: number; total: number } | null;
}

const prefs = loadLocalAiPrefs();
let state: LocalAiState = {
  status: prefs.transport === 'server' ? (prefs.enabled ? 'available' : 'off') : !localAiSupported() ? 'unsupported' : prefs.enabled ? 'available' : 'off',
  modelId: prefs.transport === 'server' ? prefs.serverModel : prefs.modelId,
  adapter: null,
  transport: prefs.transport,
  progress: 0,
  progressText: '',
  error: null,
  enriching: null,
};

const listeners = new Set<() => void>();
export function subscribeLocalAi(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getLocalAiState(): LocalAiState {
  return state;
}
function setState(patch: Partial<LocalAiState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

/* ---------------- engine lifecycle ---------------- */

interface WebLLMEngine {
  chat: {
    completions: {
      create: (request: { messages: Array<{ role: string; content: string }>; temperature?: number; max_tokens?: number }) => Promise<{ choices: Array<{ message?: { content?: string | null } }> }>;
    };
  };
  unload: () => Promise<void>;
}
interface WebLLMModule {
  CreateMLCEngine: (modelId: string, options?: { initProgressCallback?: (report: { progress: number; text: string }) => void }) => Promise<WebLLMEngine>;
}

// Test seam: lets the suite substitute a fake runtime. Production
// code never calls this.
let webllmLoader: (() => Promise<WebLLMModule>) | null = null;
export function __setWebllmLoaderForTests(loader: (() => Promise<WebLLMModule>) | null): void {
  webllmLoader = loader;
}

async function loadWebllm(): Promise<WebLLMModule> {
  if (webllmLoader) return webllmLoader();
  const module = (await import(/* @vite-ignore */ WEBLLM_CDN)) as unknown as WebLLMModule;
  return module;
}

let engine: WebLLMEngine | null = null;
let engineModelId: string | null = null;
let enginePromise: Promise<WebLLMEngine> | null = null;

async function ensureEngine(): Promise<WebLLMEngine> {
  if (engine && engineModelId === state.modelId) return engine;
  if (enginePromise && engineModelId === state.modelId) return enginePromise;
  const modelId = state.modelId;
  engineModelId = modelId;
  enginePromise = (async () => {
    const webllm = await loadWebllm();
    const created = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        setState({ progress: report.progress, progressText: report.text });
      },
    });
    engine = created;
    return created;
  })();
  try {
    return await enginePromise;
  } catch (error) {
    enginePromise = null;
    engine = null;
    throw error;
  }
}

interface ServerInferenceStatus { enabled?: boolean; status?: string; progress?: number; detail?: string; model?: string }

async function fetchServerStatus(settings: LocalAiPrefs): Promise<ServerInferenceStatus> {
  const base = settings.serverUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/inference/status`, { headers: { 'x-openforge-token': settings.serverToken } });
  if (response.status === 401) throw new Error('The companion rejected the token. Use the token the companion printed at startup (or the one saved in Companion settings).');
  if (!response.ok) throw new Error(`The companion replied HTTP ${response.status} for /inference/status.`);
  return (await response.json()) as ServerInferenceStatus;
}

async function enableServerAi(requestedModel: string): Promise<void> {
  const settings = saveLocalAiSettings({ transport: 'server', serverModel: SERVER_MODELS.some((option) => option.id === requestedModel) ? requestedModel : DEFAULT_SERVER_MODEL, enabled: true });
  if (!settings.serverUrl || !settings.serverToken) {
    setState({ status: 'error', transport: 'server', modelId: settings.serverModel, error: 'Add your companion server URL and its token first, then enable. Start the companion with: node agent/server.mjs --inference' });
    return;
  }
  setState({ status: 'loading', transport: 'server', modelId: settings.serverModel, progress: 0, progressText: 'Contacting your companion…', error: null });
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    let status: ServerInferenceStatus;
    try {
      status = await fetchServerStatus(settings);
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      // Curated errors from fetchServerStatus start with "The companion";
      // anything else is a raw network failure and gets reachability guidance.
      const friendly = raw.startsWith('The companion') ? raw : 'Could not reach your companion. Is it running with --inference, and reachable from this browser (Tailscale HTTPS name or localhost on the same machine)?';
      setState({ status: 'error', error: friendly, progressText: '' });
      return;
    }
    if (status.enabled === false) {
      setState({ status: 'error', error: status.detail || 'That companion has inference off. Restart it with --inference.', progressText: '' });
      return;
    }
    if (status.status === 'ready') {
      setState({ status: 'ready', progress: 1, progressText: '', modelId: status.model || settings.serverModel });
      return;
    }
    if (status.status === 'error') {
      setState({ status: 'error', error: status.detail || 'Inference failed on the companion.', progressText: '' });
      return;
    }
    setState({ progress: status.progress || 0, progressText: status.detail || 'The companion is preparing the model…' });
    if (Date.now() > deadline) {
      setState({ status: 'error', error: 'The companion is still preparing the model after 15 minutes. Check its console output, then try again.', progressText: '' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export async function enableLocalAi(modelId: string): Promise<void> {
  if (currentTransport() === 'server') {
    await enableServerAi(modelId);
    return;
  }
  if (!localAiSupported()) {
    setState({ status: 'unsupported' });
    return;
  }
  const adapter = await probeLocalAiAdapter();
  if (!adapter.hasAdapter) {
    // Don't persist an enable that can never succeed on this device.
    saveLocalAiSettings({ enabled: false, modelId });
    setState({ status: 'no-gpu', modelId, error: null, progressText: '' });
    return;
  }
  const effectiveId = pickCompatibleModel(modelId, adapter);
  saveLocalAiSettings({ enabled: true, modelId: effectiveId });
  setState({
    status: 'loading',
    modelId: effectiveId,
    progress: 0,
    progressText: effectiveId !== modelId ? 'Starting the local model (compatibility build for your GPU)…' : 'Starting the local model…',
    error: null,
  });
  try {
    await ensureEngine();
    setState({ status: 'ready', progress: 1, progressText: '' });
  } catch (error) {
    setState({
      status: 'error',
      error: friendlyLocalAiError(error instanceof Error ? error.message : ''),
      progressText: '',
    });
  }
}

export async function disableLocalAi(): Promise<void> {
  saveLocalAiSettings({ enabled: false });
  const current = engine;
  engine = null;
  enginePromise = null;
  engineModelId = null;
  setState({ status: state.transport === 'server' ? 'off' : localAiSupported() ? 'off' : 'unsupported', progress: 0, progressText: '', error: null });
  try { await current?.unload(); } catch { /* already gone */ }
}

/* ---------------- abstractive summary cache ---------------- */

/** Stable content hash (FNV-1a over the full text + length). */
export function summaryContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

interface SummaryCacheEntry { summary: string; model: string; at: number }

function loadSummaryCache(): Record<string, SummaryCacheEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || '{}') as Record<string, SummaryCacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSummaryCache(cache: Record<string, SummaryCacheEntry>): void {
  const entries = Object.entries(cache);
  if (entries.length > SUMMARY_CACHE_CAP) {
    entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    cache = Object.fromEntries(entries.slice(entries.length - SUMMARY_CACHE_CAP));
  }
  try { localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(cache)); } catch { /* best-effort */ }
}

/** The cached abstractive summary for this exact content, or null. */
export function cachedAbstractiveSummary(content: string): string | null {
  const entry = loadSummaryCache()[summaryContentHash(content)];
  return entry?.summary || null;
}

export function buildSummaryPrompt(path: string, content: string): Array<{ role: string; content: string }> {
  const excerpt = content.length > 6000 ? `${content.slice(0, 4200)}\n…[middle omitted]…\n${content.slice(-1400)}` : content;
  return [
    { role: 'system', content: 'You summarize a single source file for a coding assistant. Reply with 2-3 plain sentences (max 70 words) covering: what the file is, its main exports/responsibilities, and anything notable (side effects, dependencies, generated code). No markdown, no preamble, no quotes.' },
    { role: 'user', content: `File: ${path}\n\n${excerpt}` },
  ];
}

export function sanitizeSummary(raw: string): string {
  let cleaned = (raw || '').trim().replace(/```[a-z]*|```/gi, '').trim();
  cleaned = cleaned.replace(/^summary\s*:\s*/i, '');
  if (cleaned.length >= 2 && ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, 460);
}

export async function generateAbstractiveSummary(path: string, content: string): Promise<string | null> {
  if (state.status !== 'ready') return null;
  try {
    let summary = '';
    if (state.transport === 'server') {
      const settings = loadLocalAiPrefs();
      const base = settings.serverUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/v1/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openforge-token': settings.serverToken },
        body: JSON.stringify({ path, content }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { summary?: string };
      summary = sanitizeSummary(data.summary || '');
    } else {
      const active = await ensureEngine();
      const reply = await active.chat.completions.create({
        messages: buildSummaryPrompt(path, content),
        temperature: 0.2,
        max_tokens: 140,
      });
      summary = sanitizeSummary(reply.choices?.[0]?.message?.content || '');
    }
    if (!summary) return null;
    const cache = loadSummaryCache();
    cache[summaryContentHash(content)] = { summary, model: state.transport === 'server' ? `server:${state.modelId}` : state.modelId, at: Date.now() };
    saveSummaryCache(cache);
    return summary;
  } catch {
    return null; // local inference is an enhancement; failure = extractive floor
  }
}

/**
 * Background enrichment: generate abstractive summaries for the
 * given (pre-filtered) files that don't have one yet. Sequential and
 * capped — this is a background nicety, never a blocking operation.
 */
export async function enrichSummaries(files: Array<{ path: string; content: string; blob?: unknown }>, cap = 40): Promise<void> {
  if (state.status !== 'ready' || state.enriching) return;
  const targets = files
    .filter((file) => !file.blob && file.content && file.content.length <= 60_000 && !cachedAbstractiveSummary(file.content))
    .slice(0, cap);
  if (!targets.length) return;
  setState({ enriching: { done: 0, total: targets.length } });
  let done = 0;
  for (const file of targets) {
    if (state.status !== 'ready') break; // disabled mid-run
    await generateAbstractiveSummary(file.path, file.content);
    done += 1;
    setState({ enriching: { done, total: targets.length } });
  }
  setState({ enriching: null });
}

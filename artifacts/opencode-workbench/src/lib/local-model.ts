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

interface LocalAiPrefs { enabled: boolean; modelId: string }

export function loadLocalAiPrefs(): LocalAiPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as LocalAiPrefs | null;
    if (parsed && typeof parsed.enabled === 'boolean' && typeof parsed.modelId === 'string') return parsed;
  } catch { /* fall through */ }
  return { enabled: false, modelId: DEFAULT_LOCAL_MODEL };
}

function saveLocalAiPrefs(prefs: LocalAiPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* best-effort */ }
}

/* ---------------- state machine ---------------- */

export type LocalAiStatus = 'unsupported' | 'no-gpu' | 'off' | 'available' | 'loading' | 'ready' | 'error';

export interface LocalAiState {
  status: LocalAiStatus;
  modelId: string;
  adapter: AdapterInfo | null;
  progress: number; // 0..1 while loading
  progressText: string;
  error: string | null;
  enriching: { done: number; total: number } | null;
}

const prefs = loadLocalAiPrefs();
let state: LocalAiState = {
  status: !localAiSupported() ? 'unsupported' : prefs.enabled ? 'available' : 'off',
  modelId: prefs.modelId,
  adapter: null,
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

export async function enableLocalAi(modelId: string): Promise<void> {
  if (!localAiSupported()) {
    setState({ status: 'unsupported' });
    return;
  }
  const adapter = await probeLocalAiAdapter();
  if (!adapter.hasAdapter) {
    // Don't persist an enable that can never succeed on this device.
    saveLocalAiPrefs({ enabled: false, modelId });
    setState({ status: 'no-gpu', modelId, error: null, progressText: '' });
    return;
  }
  const effectiveId = pickCompatibleModel(modelId, adapter);
  saveLocalAiPrefs({ enabled: true, modelId: effectiveId });
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
  saveLocalAiPrefs({ enabled: false, modelId: state.modelId });
  const current = engine;
  engine = null;
  enginePromise = null;
  engineModelId = null;
  setState({ status: localAiSupported() ? 'off' : 'unsupported', progress: 0, progressText: '', error: null });
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
    const active = await ensureEngine();
    const reply = await active.chat.completions.create({
      messages: buildSummaryPrompt(path, content),
      temperature: 0.2,
      max_tokens: 140,
    });
    const summary = sanitizeSummary(reply.choices?.[0]?.message?.content || '');
    if (!summary) return null;
    const cache = loadSummaryCache();
    cache[summaryContentHash(content)] = { summary, model: state.modelId, at: Date.now() };
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

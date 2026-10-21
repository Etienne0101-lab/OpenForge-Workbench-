// Direct-to-OpenRouter client for the static (GitHub Pages) build.
//
// The original Replit deployment proxied these calls through an Express
// server that held OPENROUTER_API_KEY and allowed free models only. GitHub
// Pages cannot run that server, so the static build calls OpenRouter
// straight from the browser using the visitor's own key, with the full
// model catalog. The key is stored only in this browser's localStorage and
// is sent only to openrouter.ai — it is never committed to the repo.

import { getMode } from './modes';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type ModelInfo = {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per token, as strings from the OpenRouter API; null when unknown. */
  promptPrice: string | null;
  completionPrice: string | null;
  isFree: boolean;
};

/** Back-compat alias (v1 name). */
export type FreeModel = ModelInfo;

export type ProjectFileContext = { path: string; content: string };

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const FREE_ROUTER_ID = 'openrouter/free';
const KEY_STORAGE_KEY = 'openforge-workbench-openrouter-key';
const MODEL_STORAGE_KEY = 'openforge-workbench-model';

/** Curated first, when present in the live catalog. */
export const RECOMMENDED_MODEL_IDS = [
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-opus-4.1',
  'openai/gpt-5',
  'openai/gpt-5-codex',
  'google/gemini-2.5-pro',
  'qwen/qwen3-coder',
  'deepseek/deepseek-chat',
  'moonshotai/kimi-k2',
  'x-ai/grok-4',
  'meta-llama/llama-4-maverick',
];

export function loadOpenRouterKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveOpenRouterKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE_KEY, key);
    else localStorage.removeItem(KEY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the key then lasts for the session only.
  }
}

export function loadModelId(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || FREE_ROUTER_ID;
  } catch {
    return FREE_ROUTER_ID;
  }
}

const MODEL_EXPLICIT_KEY = 'openforge-workbench-model-explicit';

export function saveModelId(id: string, explicit = false): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, id);
    if (explicit) localStorage.setItem(MODEL_EXPLICIT_KEY, '1');
  } catch {
    // session-only
  }
}

type UpstreamModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
};

export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_API}/models`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("OpenRouter's model catalog is temporarily unavailable.");
  }
  if (!response.ok) {
    throw new Error("OpenRouter's model catalog is temporarily unavailable.");
  }
  const payload = (await response.json()) as { data?: UpstreamModel[] };
  const models: ModelInfo[] = (Array.isArray(payload.data) ? payload.data : [])
    .filter(
      (model): model is UpstreamModel & { id: string; name: string } =>
        typeof model.id === 'string' && typeof model.name === 'string',
    )
    .map((model) => {
      const promptPrice = typeof model.pricing?.prompt === 'string' ? model.pricing.prompt : null;
      const completionPrice = typeof model.pricing?.completion === 'string' ? model.pricing.completion : null;
      const zeroPriced =
        (promptPrice === '0' || promptPrice === '0.0') && (completionPrice === '0' || completionPrice === '0.0');
      return {
        id: model.id,
        name: model.name,
        contextLength: typeof model.context_length === 'number' ? model.context_length : null,
        promptPrice,
        completionPrice,
        isFree: model.id.endsWith(':free') || zeroPriced,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      id: FREE_ROUTER_ID,
      name: 'OpenRouter Free (automatic routing)',
      contextLength: null,
      promptPrice: '0',
      completionPrice: '0',
      isFree: true,
    },
    ...models,
  ];
}

/** Back-compat alias (v1 name). */
export const fetchFreeModels = fetchModels;

export function formatModelMeta(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.contextLength) {
    parts.push(model.contextLength >= 1000 ? `${Math.round(model.contextLength / 1000)}k ctx` : `${model.contextLength} ctx`);
  }
  if (model.isFree) {
    parts.push('free');
  } else if (model.promptPrice) {
    const perMillion = Number.parseFloat(model.promptPrice) * 1_000_000;
    if (Number.isFinite(perMillion) && perMillion > 0) parts.push(`$${perMillion.toFixed(perMillion < 1 ? 2 : 1)}/M in`);
  }
  return parts.join(' · ');
}

const BASE_PROMPT = `You are the OpenForge Workbench assistant: a master coding assistant operating at senior system architect / principal engineer level, across any programming language, framework, and field — including advanced machine learning systems, data engineering, security, and platform engineering.

Working method:
- You are given a repo map of the whole project (paths, sizes, key symbols) and the contents of selected files. Reason from the actual code in front of you, not generic assumptions. If the code you need is not in context, say exactly which file you need and why — the user can include it.
- For anything non-trivial, start with a short plan (goal, approach, files touched, risks), then execute it. For simple questions, just answer.
- Be decisive: recommend one approach, name the main alternative and why you did not choose it. Quantify where it matters (complexity, latency, cost, memory).
- Write complete, runnable, production-quality code. No placeholder stubs, no "...rest of code here", no TODO left as the answer. Match the project's existing style, naming, and patterns.
- Explain the why behind significant decisions briefly; skip tutorial narration for things the code makes obvious.
- Flag correctness risks, security issues, and missing tests when you see them — even if not asked — in one or two lines each.
- Never claim you edited, ran, or tested anything. You propose changes; the user reviews and applies them in the workbench. If code cannot run as-is, say what is missing.
- CRITICAL — no tools exist here: you are inside a browser workbench with NO shell, NO bash, NO function calling, NO file system access, and NO internet. Never emit tool calls or tool-call markup of any kind (for example <|tool_call_start|>, [bash(command=...)], or JSON function calls), and never write as if you executed a step or are waiting for a tool result. You cannot look anything up; work from the project context provided and your own knowledge, and when information is genuinely missing, state exactly what you need the user to paste or include. Every answer is plain text plus the change blocks defined below.`;

const PROTOCOL_PROMPT = `Proposing changes — use these exact block formats (outside of prose, one block per file). The workbench turns them into a reviewable change set; the user accepts or rejects each one.

Full file (new file, or complete replacement of an existing file):
<<<FILE path/to/file.ext>>>
<complete file contents>
<<<END FILE>>>

Targeted patch (small change inside an existing file). Repeat FIND/REPLACE pairs inside one PATCH block for several edits to the same file:
<<<PATCH path/to/file.ext>>>
<<<FIND>>>
<exact text to find, copied character-for-character from the file>
<<<REPLACE>>>
<replacement text>
<<<END PATCH>>>

Delete a file:
<<<DELETE path/to/file.ext>>>

Rules: paths are relative to the project root. FIND text must match the current file exactly or the patch will not apply. Prefer PATCH for small edits and FILE for new or heavily changed files. Do not wrap change blocks in markdown code fences. Put explanation in prose outside the blocks, and keep prose focused: what changed, why, and what to verify.`;

export function buildSystemPrompt(modeId: string): string {
  const mode = getMode(modeId);
  return `${BASE_PROMPT}\n\n${mode.instructions}\n\n${PROTOCOL_PROMPT}`;
}

/** Remove agent-harness tool-call markup that some free models emit as text. */
export function sanitizeAssistantText(text: string): string {
  let cleaned = text
    .replace(/<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/g, '')
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '')
    .replace(/<\|[^|>]{1,80}\|>/g, '');
  const trimmed = cleaned.trim();
  // A response that is nothing but a bare bash() tool-call list has no prose value.
  if (/^\[?\s*bash\(command=[\s\S]*\]?$/.test(trimmed) && !trimmed.includes('\n\n')) {
    cleaned = '';
  }
  return cleaned;
}

/** True when a response carries no usable answer (empty, or tool-call noise). */
export function isUnusableResponse(raw: string, cleaned: string): boolean {
  if (!cleaned.trim()) return true;
  const toolish = /<\|tool_call|<\|tool_calls_section|\[bash\(command=/.test(raw);
  return toolish && cleaned.trim().length < 60;
}

const FREE_PREFERENCE: RegExp[] = [
  /qwen.*coder/i,
  /deepseek/i,
  /llama-3\.3-70b/i,
  /gemini-2\.0-flash/i,
  /mistral/i,
  /qwen/i,
  /llama/i,
  /gemma/i,
  /phi/i,
];

/** Ordered shortlist of the most reliable free chat/coding models in the catalog. */
export function pickFreeFallbacks(models: ModelInfo[], excludeId: string, limit = 3): string[] {
  const free = models.filter((model) => model.isFree && model.id !== FREE_ROUTER_ID && model.id !== excludeId);
  const picked: string[] = [];
  for (const pattern of FREE_PREFERENCE) {
    for (const model of free) {
      if (pattern.test(model.id) && !picked.includes(model.id)) {
        picked.push(model.id);
        if (picked.length >= limit) return picked;
      }
    }
  }
  for (const model of free) {
    if (!picked.includes(model.id)) {
      picked.push(model.id);
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

/** A sensible named free model to prefer over the random free router. */
export function preferredFreeDefault(models: ModelInfo[]): string | null {
  return pickFreeFallbacks(models, '', 1)[0] ?? null;
}

export function hasSavedModelChoice(): boolean {
  try {
    // A saved selection counts as a real choice only when the user picked
    // it explicitly, or when a previous smart default already chose a
    // named model. A stored free-router value alone may be an artifact
    // of an earlier build persisting the initial state — not a choice.
    if (localStorage.getItem(MODEL_EXPLICIT_KEY) === '1') return true;
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    return saved !== null && saved !== FREE_ROUTER_ID;
  } catch {
    return false;
  }
}

export async function streamOpenRouterChat(options: {
  apiKey: string;
  model: string;
  modeId: string;
  repoMap?: string;
  messages: ChatMessage[];
  files?: ProjectFileContext[];
  maxContextChars?: number;
  stallMs?: number;
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
}): Promise<string> {
  const { apiKey, model, modeId, repoMap, messages, files = [], signal, onDelta } = options;
  if (!apiKey) {
    throw new Error('Add your OpenRouter API key first — on this static site the key lives in your browser, not on a server.');
  }

  const maxContextChars = options.maxContextChars ?? 600_000;
  const totalFileBytes = files.reduce((total, file) => total + file.path.length + file.content.length, 0);
  if (totalFileBytes > maxContextChars) {
    throw new Error('Selected file context is too large for this request. Include fewer or smaller files, or pick a model with a larger context window.');
  }

  const contextParts: string[] = [];
  if (repoMap) {
    contextParts.push(`Project repo map (every file in the workspace, with key symbols):\n${repoMap}`);
  }
  if (files.length) {
    contextParts.push(
      `Project files supplied for context (read-only; propose changes with the change-block formats):\n${files
        .map((file) => `--- ${file.path} ---\n${file.content}`)
        .join('\n\n')}`,
    );
  }
  const contextMessage = contextParts.join('\n\n');

  // Stall watchdog: free models regularly hang mid-stream. If no data
  // arrives for stallMs, abort this attempt so the caller can fall back
  // to another model instead of spinning forever.
  const stallMs = options.stallMs ?? 45_000;
  const internal = new AbortController();
  let stalled = false;
  let lastActivity = Date.now();
  const onUserAbort = () => internal.abort();
  if (signal.aborted) internal.abort();
  else signal.addEventListener('abort', onUserAbort);
  const watchdog = window.setInterval(() => {
    if (Date.now() - lastActivity > stallMs) {
      stalled = true;
      internal.abort();
    }
  }, 1000);
  const stallError = () => new Error('That model stalled — no data arrived for 45 seconds, so the attempt was stopped.');

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'OpenForge Workbench',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        stream: true,
        messages: [
          { role: 'system', content: buildSystemPrompt(modeId) },
          ...messages,
          ...(contextMessage ? [{ role: 'user' as const, content: contextMessage }] : []),
        ],
      }),
      signal: internal.signal,
    });
  } catch (error) {
    window.clearInterval(watchdog);
    signal.removeEventListener('abort', onUserAbort);
    if (stalled) throw stallError();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('OpenRouter could not complete the request. Please try again.');
  }

  if (!upstream.ok) {
    window.clearInterval(watchdog);
    signal.removeEventListener('abort', onUserAbort);
    if (upstream.status === 401) {
      throw new Error('OpenRouter rejected that API key. Check it in the sidebar and try again.');
    }
    if (upstream.status === 404) {
      throw new Error('That model is not available on OpenRouter right now. Pick another model.');
    }
    if (upstream.status === 429) {
      throw new Error('This model is rate-limited right now. Try another model or wait a moment.');
    }
    if (upstream.status === 402) {
      throw new Error('OpenRouter reports insufficient credits for that model. Add credits or pick a free model.');
    }
    throw new Error('OpenRouter could not complete the request. The model may be unavailable; try another model.');
  }
  if (!upstream.body) throw new Error('OpenRouter returned an empty response.');

  const trackedDelta = (chunk: string) => {
    lastActivity = Date.now();
    onDelta(chunk);
  };
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let accumulated = '';
  let completed = false;

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      completed = true;
      return;
    }
    try {
      const event = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string | null } }>;
      };
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) {
        accumulated += content;
        trackedDelta(content);
      }
    } catch {
      // Ignore malformed upstream keepalive/partial events; the next chunk may complete them.
    }
  };

  try {
  while (!completed) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      processLine(line);
      if (completed) break;
    }
    if (done) {
      if (buffered) processLine(buffered);
      break;
    }
  }
  } catch (readError) {
    if (stalled) throw stallError();
    throw readError;
  } finally {
    window.clearInterval(watchdog);
    signal.removeEventListener('abort', onUserAbort);
  }
  reader.releaseLock();
  return accumulated;
}


/**
 * Agent-turn caller for Mission Mode: same streaming + stall watchdog as
 * the chat caller, but with a caller-supplied system prompt and no chat
 * context injection — the agent engine manages its own message history.
 */
export async function streamAgentChat(options: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta?: (chunk: string) => void;
  stallMs?: number;
  maxTokens?: number;
}): Promise<string> {
  const { apiKey, model, systemPrompt, messages, signal } = options;
  if (!apiKey) throw new Error('Add your OpenRouter API key first — on this static site the key lives in your browser, not on a server.');
  const stallMs = options.stallMs ?? 45_000;
  const internal = new AbortController();
  let stalled = false;
  let lastActivity = Date.now();
  const onUserAbort = () => internal.abort();
  if (signal.aborted) internal.abort();
  else signal.addEventListener('abort', onUserAbort);
  const watchdog = window.setInterval(() => {
    if (Date.now() - lastActivity > stallMs) { stalled = true; internal.abort(); }
  }, 1000);
  const cleanup = () => { window.clearInterval(watchdog); signal.removeEventListener('abort', onUserAbort); };
  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'OpenForge Workbench' },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 8192,
        stream: true,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
      signal: internal.signal,
    });
  } catch (error) {
    cleanup();
    if (stalled) throw new Error('That model stalled — no data arrived for 45 seconds, so the attempt was stopped.');
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('OpenRouter could not complete the request. Please try again.');
  }
  if (!upstream.ok) {
    cleanup();
    if (upstream.status === 401) throw new Error('OpenRouter rejected that API key. Check it in the sidebar and try again.');
    if (upstream.status === 404) throw new Error('That model is not available on OpenRouter right now. Pick another model.');
    if (upstream.status === 429) throw new Error('This model is rate-limited right now. Try another model or wait a moment.');
    if (upstream.status === 402) throw new Error('OpenRouter reports insufficient credits for that model. Add credits or pick a free model.');
    throw new Error('OpenRouter could not complete the request. The model may be unavailable; try another model.');
  }
  if (!upstream.body) { cleanup(); throw new Error('OpenRouter returned an empty response.'); }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let accumulated = '';
  let completed = false;
  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { completed = true; return; }
    try {
      const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) { accumulated += content; lastActivity = Date.now(); options.onDelta?.(content); }
    } catch { /* ignore malformed keepalive events */ }
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) { processLine(line); if (completed) break; }
      if (done) { if (buffered) processLine(buffered); break; }
    }
  } catch (readError) {
    if (stalled) throw new Error('That model stalled — no data arrived for 45 seconds, so the attempt was stopped.');
    throw readError;
  } finally {
    cleanup();
  }
  reader.releaseLock();
  return accumulated;
}

/** Back-compat alias (v1 name). */
export const streamChat = streamOpenRouterChat;

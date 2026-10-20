// Direct-to-OpenRouter client for the static (GitHub Pages) build.
//
// The original Replit deployment proxied these two calls through an Express
// server that held OPENROUTER_API_KEY. GitHub Pages cannot run that server,
// so the static build calls OpenRouter straight from the browser using the
// visitor's own key. The key is stored only in this browser's localStorage
// and is sent only to openrouter.ai — it is never committed to the repo.
//
// Behavior intentionally mirrors artifacts/api-server/src/routes/opencode.ts:
// free models only, the same system prompt, the same file-context limits.

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type FreeModel = { id: string; name: string; contextLength: number | null };
export type ProjectFileContext = { path: string; content: string };

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const FREE_ROUTER_ID = 'openrouter/free';
const KEY_STORAGE_KEY = 'openforge-workbench-openrouter-key';

const SYSTEM_PROMPT =
  'You are a careful coding assistant in a browser-based project workspace. The project files in context are read-only. Explain proposed changes and identify their target file. Do not claim you edited or executed anything. When suggesting a complete file replacement, use exactly this format: <<<FILE path/to/file>>> on its own line, then the complete file contents, then <<<END FILE>>> on its own line. Never suggest running destructive commands without explaining their impact.';

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

type UpstreamModel = { id?: unknown; name?: unknown; context_length?: unknown };

export async function fetchFreeModels(apiKey: string): Promise<FreeModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_API}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("OpenRouter's model list is temporarily unavailable.");
  }
  if (!response.ok) {
    throw new Error("OpenRouter's model list is temporarily unavailable.");
  }
  const payload = (await response.json()) as { data?: UpstreamModel[] };
  const freeModels = (Array.isArray(payload.data) ? payload.data : [])
    .filter(
      (model): model is UpstreamModel & { id: string; name: string } =>
        typeof model.id === 'string' &&
        model.id.endsWith(':free') &&
        typeof model.name === 'string',
    )
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: typeof model.context_length === 'number' ? model.context_length : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { id: FREE_ROUTER_ID, name: 'OpenRouter Free (automatic routing)', contextLength: null },
    ...freeModels,
  ];
}

export async function streamOpenRouterChat(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  files?: ProjectFileContext[];
  signal: AbortSignal;
  onDelta: (chunk: string) => void;
}): Promise<string> {
  const { apiKey, model, messages, files = [], signal, onDelta } = options;
  if (!apiKey) {
    throw new Error('Add your OpenRouter API key first — on this static site the key lives in your browser, not on a server.');
  }

  const totalFileBytes = files.reduce((total, file) => total + file.path.length + file.content.length, 0);
  if (totalFileBytes > 80_000) {
    throw new Error('Selected file context is too large. Include fewer or smaller files.');
  }

  const fileContext = files.length
    ? `\n\nProject files supplied for context (read-only; propose changes for the user to review):\n${files
        .map((file) => `--- ${file.path} ---\n${file.content}`)
        .join('\n\n')}`
    : '';

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_API}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'OpenCode Workbench',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages,
          ...(fileContext ? [{ role: 'user' as const, content: fileContext }] : []),
        ],
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('OpenRouter could not complete the request. Please try again.');
  }

  if (!upstream.ok) {
    if (upstream.status === 401) {
      throw new Error('OpenRouter rejected that API key. Check it in the sidebar and try again.');
    }
    if (upstream.status === 429) {
      throw new Error('This free model is rate-limited right now. Try another free model or wait a moment.');
    }
    throw new Error('OpenRouter could not complete the request. The model may be unavailable; try another free model.');
  }
  if (!upstream.body) throw new Error('OpenRouter returned an empty response.');

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
        onDelta(content);
      }
    } catch {
      // Ignore malformed upstream keepalive/partial events; the next chunk may complete them.
    }
  };

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
  reader.releaseLock();
  return accumulated;
}

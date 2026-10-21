import { dispatchWorkflow } from './actions';
import { ghPull, ghPush } from './github';

/**
 * Off-tab agent execution (v6). The agent engine ships as plain Node files
 * in this repo (agent/agent-core.mjs, agent/runner.mjs, agent/server.mjs)
 * plus a dispatch workflow. Two targets:
 *  - GitHub Actions: install the files into the user's repo, snapshot the
 *    project onto an openforge/agent-* branch, dispatch, watch, import.
 *  - Companion server: the same engine served from the user's own device
 *    by agent/server.mjs; the browser starts missions over HTTP (the model
 *    key travels with the request — the server stores nothing).
 */

export const AGENT_SOURCE_REPO = 'Etienne0101-lab/OpenForge-Workbench-';
export const AGENT_WORKFLOW_PATH = '.github/workflows/openforge-agent.yml';
export const AGENT_PATHS = ['agent/agent-core.mjs', 'agent/runner.mjs', 'agent/server.mjs', AGENT_WORKFLOW_PATH];

/** Fetch the agent bundle from the workbench's own repo (single source of truth). */
export async function fetchAgentBundle(token: string): Promise<Array<{ path: string; content: string }>> {
  if (!token) throw new Error('Installing the agent needs your GitHub token (GitHub sync) — the bundle is fetched from the workbench repo and committed to yours.');
  const pulled = await ghPull(AGENT_SOURCE_REPO, 'main', token);
  const files = pulled.files;
  const bundle = AGENT_PATHS.map((wanted) => {
    const found = files.find((file) => file.path === wanted && !file.blob);
    return found ? { path: wanted, content: found.content } : null;
  }).filter((entry): entry is { path: string; content: string } => entry !== null);
  if (bundle.length !== AGENT_PATHS.length) {
    const missing = AGENT_PATHS.filter((wanted) => !bundle.some((entry) => entry.path === wanted));
    throw new Error(`Could not fetch the full agent bundle (missing: ${missing.join(', ')}). Try again in a moment.`);
  }
  return bundle;
}

/** Commit the agent bundle into the user's repo on the given branch. */
export async function installAgentFiles(repo: string, branch: string, token: string): Promise<void> {
  const bundle = await fetchAgentBundle(token);
  await ghPush(repo, branch, token, bundle, 'Install the OpenForge off-tab agent (engine, Actions runner, companion server, workflow)');
}

/** Dispatch an agent mission run against a mission branch. */
export async function dispatchAgentRun(repo: string, branch: string, token: string, input: { goal: string; model: string; maxSteps: number; baseBranch: string }): Promise<void> {
  await dispatchWorkflow(repo, 'openforge-agent.yml', branch, token, {
    goal: input.goal.slice(0, 1000),
    model: input.model,
    max_steps: String(input.maxSteps),
    base_branch: input.baseBranch,
  });
}

/* ---------- Companion server client ---------- */

const COMPANION_URL_KEY = 'openforge-companion-url';
const COMPANION_TOKEN_KEY = 'openforge-companion-token';
export const loadCompanionUrl = (): string => { try { return localStorage.getItem(COMPANION_URL_KEY) || ''; } catch { return ''; } };
export const loadCompanionToken = (): string => { try { return localStorage.getItem(COMPANION_TOKEN_KEY) || ''; } catch { return ''; } };
export const saveCompanion = (url: string, token: string): void => {
  try {
    if (url) localStorage.setItem(COMPANION_URL_KEY, url); else localStorage.removeItem(COMPANION_URL_KEY);
    if (token) localStorage.setItem(COMPANION_TOKEN_KEY, token); else localStorage.removeItem(COMPANION_TOKEN_KEY);
  } catch { /* storage unavailable */ }
};

async function companionFetch<T>(serverUrl: string, token: string, route: string, init?: RequestInit): Promise<T> {
  const base = serverUrl.replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${route}`, { ...init, headers: { 'Content-Type': 'application/json', 'x-openforge-token': token, ...(init?.headers || {}) } });
  } catch {
    throw new Error(`Could not reach the companion server at ${base}. Is it running (node agent/server.mjs), and — if the page is HTTPS — is the server reachable over HTTPS (Tailscale HTTPS name or a tunnel)? Browsers block plain-HTTP calls to other hosts from a secure page.`);
  }
  if (response.status === 401) throw new Error('The companion server rejected the token. Copy the exact token it printed at startup.');
  if (!response.ok) {
    let message = `Companion server error (${response.status}).`;
    try { const data = (await response.json()) as { error?: string }; if (data.error) message = data.error; } catch { /* keep default */ }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export type CompanionMissionState = {
  id: string;
  status: string;
  report: string;
  changedFiles: string[];
  events: Array<{ at: string; type: string; text: string }>;
  eventCount: number;
};

export async function companionStart(serverUrl: string, token: string, payload: { goal: string; model: string; apiKey: string; maxSteps: number; files: Array<{ path: string; content: string }> }): Promise<{ id: string }> {
  return companionFetch(serverUrl, token, '/missions', { method: 'POST', body: JSON.stringify(payload) });
}

export async function companionStatus(serverUrl: string, token: string, id: string, since: number): Promise<CompanionMissionState> {
  return companionFetch(serverUrl, token, `/missions/${id}?since=${since}`);
}

export async function companionFiles(serverUrl: string, token: string, id: string): Promise<Array<{ path: string; content: string }>> {
  const data = await companionFetch<{ files: Array<{ path: string; content: string }> }>(serverUrl, token, `/missions/${id}/files`);
  return data.files;
}

export async function companionStop(serverUrl: string, token: string, id: string): Promise<void> {
  await companionFetch(serverUrl, token, `/missions/${id}/stop`, { method: 'POST', body: '{}' });
}

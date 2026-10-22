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
export const SCHEDULER_WORKFLOW_PATH = '.github/workflows/openforge-scheduler.yml';
export const AGENT_SWARM_WORKFLOW_PATH = '.github/workflows/openforge-swarm.yml';
export const AGENT_PATHS = ['agent/agent-core.mjs', 'agent/runner.mjs', 'agent/server.mjs', 'agent/inference.mjs', 'agent/gateway.mjs', 'agent/swarm-plan.mjs', 'agent/swarm-integrate.mjs', 'agent/provision.mjs', 'agent/model-router.mjs', 'agent/skills.mjs', 'agent/scheduler.mjs', 'agent/distill.mjs', 'agent/summaries.mjs', 'agent/quota.mjs', AGENT_WORKFLOW_PATH, AGENT_SWARM_WORKFLOW_PATH, SCHEDULER_WORKFLOW_PATH];
/** Seed skills: distributed on install only when the repo has no library yet — a repo's own learned index is never clobbered. */
export const AGENT_SEED_SKILL_PATHS = ['.openforge/skills/verify-before-claiming.md', '.openforge/skills/rate-limit-citizenship.md', '.openforge/skills/docs-must-match-reality.md'];

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

/** Fetch the seed skills from the workbench repo (installed only into repos without a library). */
export async function fetchSeedSkills(token: string): Promise<Array<{ path: string; content: string }>> {
  const pulled = await ghPull(AGENT_SOURCE_REPO, 'main', token);
  return AGENT_SEED_SKILL_PATHS.flatMap((wanted) => {
    const found = pulled.files.find((file) => file.path === wanted && !file.blob);
    return found ? [{ path: wanted, content: found.content }] : [];
  });
}

/** Commit the agent bundle into the user's repo on the given branch. */
export async function installAgentFiles(repo: string, branch: string, token: string): Promise<void> {
  const bundle = await fetchAgentBundle(token);
  let seeds: Array<{ path: string; content: string }> = [];
  try {
    const existing = await ghPull(repo, branch, token);
    if (!existing.files.some((file) => file.path === '.openforge/skills/index.json')) seeds = await fetchSeedSkills(token);
  } catch { /* if the check fails, install the engine without seeds */ }
  await ghPush(repo, branch, token, [...bundle, ...seeds], 'Install the OpenForge off-tab agent (engine, Actions runner, companion server, workflows, seed skills)');
}

export const ANDROID_WORKFLOW_FILE = 'openforge-android.yml';
export const ANDROID_WORKFLOW_PATH = '.github/workflows/openforge-android.yml';

/** Install the Android build workflow into the linked repo (user token — the GitHub App cannot write workflows). */
export async function installAndroidWorkflow(repo: string, branch: string, token: string): Promise<void> {
  if (!token) throw new Error('Installing the Android workflow needs your GitHub token (GitHub sync).');
  const pulled = await ghPull(AGENT_SOURCE_REPO, 'main', token);
  const template = pulled.files.find((file) => file.path === ANDROID_WORKFLOW_FILE && !file.blob);
  if (!template) throw new Error('Could not fetch the Android workflow template from the workbench repo. Try again in a moment.');
  await ghPush(repo, branch, token, [{ path: ANDROID_WORKFLOW_PATH, content: template.content }], 'Install the OpenForge Android build workflow');
}

export interface AndroidBuildOptions {
  pipeline: 'sparkfabrik' | 'gradle';
  projectPath: string;
  buildType: 'debug-apk' | 'release-apk' | 'release-aab';
  packageName: string;
  uploadPlay: boolean;
  playTrack: 'internal' | 'alpha' | 'beta' | 'production';
  uploadBrowserstack: boolean;
}

/** Dispatch an Android build run on the linked repo. */
export async function dispatchAndroidBuild(repo: string, branch: string, token: string, options: AndroidBuildOptions): Promise<void> {
  await dispatchWorkflow(repo, ANDROID_WORKFLOW_FILE, branch, token, {
    pipeline: options.pipeline,
    project_path: options.projectPath || '.',
    build_type: options.buildType,
    package_name: options.packageName,
    upload_play: String(options.uploadPlay),
    play_track: options.playTrack,
    upload_browserstack: String(options.uploadBrowserstack),
  });
}

export const AGENT_WORKFLOW_NAME = 'OpenForge Agent';
export const SWARM_WORKFLOW_NAME = 'OpenForge Swarm';

/** Dispatch a multi-agent swarm run: planner → parallel workers → integrator. */
export async function dispatchSwarmRun(repo: string, branch: string, token: string, input: { goal: string; model: string; maxSteps: number; workers: number; swarmId: string; baseBranch: string }): Promise<void> {
  await dispatchWorkflow(repo, 'openforge-swarm.yml', branch, token, {
    goal: input.goal.slice(0, 1000),
    model: input.model,
    max_steps: String(input.maxSteps),
    workers: String(input.workers),
    swarm_id: input.swarmId,
    base_branch: input.baseBranch,
  });
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


/* ---------- Scheduled automations (manifest in the repo) ---------- */

export interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'agent' | 'swarm';
  goal: string;
  model?: string;
  cadence?: string;
  cron?: string;
  workers?: number;
  maxSteps?: number;
  baseBranch?: string;
  createdAt?: string;
  lastRunAt?: string;
  runCount?: number;
  lastDecision?: string;
}

export interface ScheduleManifest {
  version: number;
  maxConcurrent?: number;
  entries: ScheduleEntry[];
}

export const SCHEDULE_PATH = '.openforge/schedule.json';

export async function readSchedule(repo: string, branch: string, token: string): Promise<ScheduleManifest | null> {
  const pulled = await ghPull(repo, branch, token);
  const found = pulled.files.find((file) => file.path === SCHEDULE_PATH && !file.blob);
  if (!found) return null;
  try {
    const parsed = JSON.parse(found.content) as ScheduleManifest;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSchedule(repo: string, branch: string, token: string, manifest: ScheduleManifest): Promise<void> {
  await ghPush(repo, branch, token, [{ path: SCHEDULE_PATH, content: JSON.stringify(manifest, null, 2) }], 'Update OpenForge automation schedule');
}

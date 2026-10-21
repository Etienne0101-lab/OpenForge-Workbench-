import { unzipSync } from 'fflate';
import { parseRepo } from './github';

/**
 * GitHub Actions from the browser — the platform's off-tab execution
 * plane. Everything goes through api.github.com with the user's GitHub
 * token (the same one GitHub sync stores; it needs Actions permission
 * for dispatch/logs). No server, no new credentials.
 */

const API = 'https://api.github.com';

export type GhWorkflow = { id: number; name: string; path: string; state: string };
export type GhRun = {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | …
  head_branch: string;
  event: string;
  created_at: string;
  html_url: string;
  workflow_id: number;
};

async function ghActions<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  } catch {
    throw new Error('Could not reach api.github.com.');
  }
  if (response.status === 404) throw new Error('Not found — check the repository, and for private repos that the token can see it.');
  if (response.status === 403 || response.status === 429) {
    throw new Error(token
      ? 'GitHub refused the request (403). For Actions the token needs the Actions permission (and Workflows permission to add workflow files).'
      : 'GitHub refused the request (403) — the anonymous rate limit. Add a GitHub token in GitHub sync to raise it.');
  }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}).`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function repoPath(repoInput: string): string {
  const parsed = parseRepo(repoInput);
  if (!parsed) throw new Error('Enter the repository as owner/name (or paste its GitHub URL).');
  return `/repos/${parsed.owner}/${parsed.repo}`;
}

export async function listWorkflows(repoInput: string, token: string): Promise<GhWorkflow[]> {
  const data = await ghActions<{ workflows: GhWorkflow[] }>(`${repoPath(repoInput)}/actions/workflows?per_page=100`, token);
  return (data.workflows || []).filter((workflow) => workflow.state === 'active');
}

export async function listRuns(repoInput: string, token: string, branch?: string): Promise<GhRun[]> {
  const query = branch ? `?branch=${encodeURIComponent(branch)}&per_page=20` : '?per_page=20';
  const data = await ghActions<{ workflow_runs: GhRun[] }>(`${repoPath(repoInput)}/actions/runs${query}`, token);
  return data.workflow_runs || [];
}

export async function getRun(repoInput: string, runId: number, token: string): Promise<GhRun> {
  return ghActions<GhRun>(`${repoPath(repoInput)}/actions/runs/${runId}`, token);
}

/** Trigger a workflow_dispatch run. The workflow file must declare `on: workflow_dispatch`. */
export async function dispatchWorkflow(repoInput: string, workflowPathOrId: string | number, ref: string, token: string): Promise<void> {
  await ghActions<void>(`${repoPath(repoInput)}/actions/workflows/${encodeURIComponent(String(workflowPathOrId))}/dispatches`, token, {
    method: 'POST',
    body: JSON.stringify({ ref }),
  });
}

export function isRunActive(run: GhRun): boolean {
  return run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'pending';
}

export function runBadge(run: GhRun): string {
  if (isRunActive(run)) return run.status.replace('_', ' ');
  return run.conclusion || run.status;
}

/**
 * Download a run's logs (a ZIP of per-job text files) and return the most
 * useful excerpt: logs of failed jobs first, capped. Logs are DATA from
 * CI — callers must treat them as untrusted content.
 */
export async function fetchRunLogsText(repoInput: string, runId: number, token: string, maxChars = 6000): Promise<string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${API}${repoPath(repoInput)}/actions/runs/${runId}/logs`, { headers });
  } catch {
    throw new Error('Could not reach api.github.com for the run logs.');
  }
  if (!response.ok) throw new Error(`Could not download run logs (${response.status}). The token may lack the Actions permission.`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const entries = unzipSync(archive);
  return summarizeLogEntries(entries, maxChars);
}

/** Pure summariser (unit-tested): failed jobs' logs first, then the rest, capped. */
export function summarizeLogEntries(entries: Record<string, Uint8Array>, maxChars = 6000): string {
  const decoder = new TextDecoder();
  const files = Object.keys(entries)
    .filter((name) => name.endsWith('.txt') && !name.endsWith('/'))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) return '(the log archive contained no job logs)';
  const failed = files.filter((name) => /fail/i.test(name));
  const ordered = [...failed, ...files.filter((name) => !failed.includes(name))];
  const parts: string[] = [];
  let used = 0;
  for (const name of ordered) {
    const text = decoder.decode(entries[name]);
    // Keep the tail of each log — that's where errors and summaries live.
    const tail = text.length > 2200 ? `…[log start truncated]…\n${text.slice(-2200)}` : text;
    const block = `--- ${name} ---\n${tail}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n') || '(logs were too large to excerpt)';
}

/**
 * A starter workflow users can commit into their repo from the CI panel:
 * detects Node or Python, installs, and runs the project's build/test.
 * Declares workflow_dispatch so the panel and Mission Mode can trigger it.
 */
export const STARTER_WORKFLOW_PATH = '.github/workflows/openforge-ci.yml';
export const STARTER_WORKFLOW = `name: OpenForge CI

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Detect project type
        id: detect
        run: |
          if [ -f package.json ]; then echo "kind=node" >> "$GITHUB_OUTPUT";
          elif [ -f requirements.txt ] || [ -f pyproject.toml ] || ls *.py >/dev/null 2>&1; then echo "kind=python" >> "$GITHUB_OUTPUT";
          else echo "kind=none" >> "$GITHUB_OUTPUT"; fi

      - name: Set up Node
        if: steps.detect.outputs.kind == 'node'
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install (Node)
        if: steps.detect.outputs.kind == 'node'
        run: |
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile;
          elif [ -f yarn.lock ]; then yarn install --frozen-lockfile;
          elif [ -f package-lock.json ]; then npm ci;
          else npm install; fi

      - name: Build (Node, if a build script exists)
        if: steps.detect.outputs.kind == 'node'
        run: |
          if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then npm run build; else echo "no build script — skipping"; fi

      - name: Test (Node, if a test script exists)
        if: steps.detect.outputs.kind == 'node'
        run: |
          if node -e "process.exit(require('./package.json').scripts?.test ? 0 : 1)"; then npm test; else echo "no test script — skipping"; fi

      - name: Set up Python
        if: steps.detect.outputs.kind == 'python'
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install (Python)
        if: steps.detect.outputs.kind == 'python'
        run: |
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
          pip install pytest

      - name: Test (Python, if tests exist)
        if: steps.detect.outputs.kind == 'python'
        run: |
          if ls test_*.py *_test.py tests >/dev/null 2>&1; then pytest -q; else echo "no tests found — skipping"; fi

      - name: Nothing to verify
        if: steps.detect.outputs.kind == 'none'
        run: echo "No Node or Python project detected — nothing to run."
`;

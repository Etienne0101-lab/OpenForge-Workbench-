// Two-way GitHub sync for a workspace, straight from the browser.
//
// Uses the GitHub REST API (CORS-enabled). A personal access token is
// stored only in this browser's localStorage and sent only to
// api.github.com. Public repositories can be pulled without a token;
// pushing always needs one (classic token with `repo` scope, or a
// fine-grained token with Contents read/write on the repo).

import { unzipSync } from 'fflate';

export type SyncFile = { path: string; content: string; blob?: Blob; mimeType?: string };

const TOKEN_KEY = 'openforge-workbench-github-token';
const API = 'https://api.github.com';

export function loadGithubToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function saveGithubToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // session-only
  }
}

export function parseRepo(input: string): { owner: string; repo: string } | null {
  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers });
  } catch {
    throw new Error('Could not reach api.github.com. Check your connection and try again.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message || '';
    } catch {
      // non-JSON error body
    }
    if (response.status === 401) throw new Error('GitHub rejected the access token. Check it, or create a new one with access to this repository.');
    if (response.status === 403) throw new Error(`GitHub refused the request (403)${detail ? `: ${detail}` : ''}. The token may lack permission for this repo, or you are rate-limited.`);
    if (response.status === 404) throw new Error('Repository or branch not found. Check the owner/repo and branch names — and for private repos, that the token can see them.');
    throw new Error(`GitHub request failed (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return response.json();
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const TEXT_PATH = /\.(txt|md|mdx|csv|tsv|json|jsonc|jsonl|js|jsx|mjs|cjs|ts|tsx|css|scss|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|log|sql|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|vue|svelte|astro|gradle|properties|gitignore|editorconfig|env|example|lock)$/i;

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ */
/* Pull                                                                */
/* ------------------------------------------------------------------ */

type TreeItem = { path: string; type: string; mode?: string; sha: string; size?: number };

/**
 * Primary pull path: the repo's zipball — ONE request for the whole tree,
 * which keeps even tokenless pulls of large repos inside GitHub's small
 * unauthenticated quota (60 requests/hour). Falls back to the per-file
 * git API below when the archive route fails.
 */
async function ghPullZipball(parsed: { owner: string; repo: string }, branch: string, token: string): Promise<{ files: SyncFile[]; sha: string; skipped: number }> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetch(`${API}/repos/${parsed.owner}/${parsed.repo}/zipball/${encodeURIComponent(branch)}`, { headers });
  } catch {
    throw new Error('Could not reach api.github.com for the archive download.');
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('Repository or branch not found. Check the owner/repo and branch names — and for private repos, that the token can see them.');
    if (response.status === 403 || response.status === 429) throw new Error('GitHub refused the archive request (rate limit). Add an access token above to raise the limit, or try again later.');
    throw new Error(`GitHub archive request failed (${response.status}).`);
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  const entries = unzipSync(archive);
  const files: SyncFile[] = [];
  let skipped = 0;
  const MAX_ENTRIES = 2000;
  const MAX_SIZE = 25_000_000;
  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) skipped += names.length - MAX_ENTRIES;
  for (const name of names.slice(0, MAX_ENTRIES)) {
    if (name.endsWith('/')) continue;
    // Archive paths are prefixed with "<owner>-<repo>-<sha>/".
    const path = name.split('/').slice(1).join('/');
    if (!path) continue;
    const bytes = entries[name];
    if (bytes.length > MAX_SIZE) { skipped += 1; continue; }
    if (TEXT_PATH.test(path)) files.push({ path, content: new TextDecoder().decode(bytes) });
    else files.push({ path, content: '', blob: new Blob([new Uint8Array(bytes)]) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  let sha = '';
  try {
    const branchInfo = (await gh(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, token)) as { commit: { sha: string } };
    sha = branchInfo.commit.sha;
  } catch {
    // sha is bookkeeping only — the pull itself succeeded
  }
  return { files, sha, skipped };
}

export async function ghPull(repoInput: string, branch: string, token: string): Promise<{ files: SyncFile[]; sha: string; skipped: number }> {
  const parsed = parseRepo(repoInput);
  if (!parsed) throw new Error('Enter the repository as owner/name (or paste its GitHub URL).');
  try {
    return await ghPullZipball(parsed, branch, token);
  } catch (zipError) {
    // Fall through to the per-file git API; if that also fails, surface its error.
    try {
      return await ghPullGitApi(parsed, branch, token);
    } catch {
      throw zipError;
    }
  }
}

async function ghPullGitApi(parsed: { owner: string; repo: string }, branch: string, token: string): Promise<{ files: SyncFile[]; sha: string; skipped: number }> {
  const branchInfo = (await gh(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, token)) as {
    commit: { sha: string; commit: { tree: { sha: string } } };
  };
  const tree = (await gh(`/repos/${parsed.owner}/${parsed.repo}/git/trees/${branchInfo.commit.commit.tree.sha}?recursive=1`, token)) as {
    tree: TreeItem[];
    truncated?: boolean;
  };
  const blobs = (tree.tree || []).filter((item) => item.type === 'blob' && item.mode !== '120000');
  const MAX_FILES = 300;
  const MAX_SIZE = 1_500_000;
  const included = blobs.filter((item) => (item.size ?? 0) <= MAX_SIZE).slice(0, MAX_FILES);
  const skipped = blobs.length - included.length + (tree.truncated ? 1 : 0);
  const files: SyncFile[] = [];
  await pool(included, 6, async (item) => {
    const blob = (await gh(`/repos/${parsed.owner}/${parsed.repo}/git/blobs/${item.sha}`, token)) as { content: string };
    const bytes = bytesFromBase64(blob.content);
    if (TEXT_PATH.test(item.path)) {
      files.push({ path: item.path, content: new TextDecoder().decode(bytes) });
    } else {
      files.push({ path: item.path, content: '', blob: new Blob([bytes.buffer as ArrayBuffer]) });
    }
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sha: branchInfo.commit.sha, skipped };
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

export async function ghPush(repoInput: string, branch: string, token: string, files: SyncFile[], message: string): Promise<{ sha: string }> {
  const parsed = parseRepo(repoInput);
  if (!parsed) throw new Error('Enter the repository as owner/name (or paste its GitHub URL).');
  if (!token) throw new Error('Pushing needs a GitHub access token — add one above first.');
  const branchInfo = (await gh(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, token)) as {
    commit: { sha: string; commit: { tree: { sha: string } } };
  };

  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  await pool(files, 6, async (file) => {
    let base64: string;
    if (file.blob) {
      base64 = base64FromBytes(new Uint8Array(await file.blob.arrayBuffer()));
    } else {
      base64 = base64FromBytes(new TextEncoder().encode(file.content));
    }
    const blob = (await gh(`/repos/${parsed.owner}/${parsed.repo}/git/blobs`, token, {
      method: 'POST',
      body: JSON.stringify({ content: base64, encoding: 'base64' }),
    })) as { sha: string };
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  });

  const newTree = (await gh(`/repos/${parsed.owner}/${parsed.repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: branchInfo.commit.commit.tree.sha, tree: treeItems }),
  })) as { sha: string };
  const commit = (await gh(`/repos/${parsed.owner}/${parsed.repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message: message || 'Update from OpenForge Workbench', tree: newTree.sha, parents: [branchInfo.commit.sha] }),
  })) as { sha: string };
  await gh(`/repos/${parsed.owner}/${parsed.repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });
  return { sha: commit.sha };
}

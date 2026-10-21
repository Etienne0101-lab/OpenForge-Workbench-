// Two-way GitHub sync for a workspace, straight from the browser.
//
// Uses the GitHub REST API (CORS-enabled). A personal access token is
// stored only in this browser's localStorage and sent only to
// api.github.com. Public repositories can be pulled without a token;
// pushing always needs one (classic token with `repo` scope, or a
// fine-grained token with Contents read/write on the repo).

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
 * Tokenless pull path for public repos: jsDelivr mirrors every public
 * GitHub repo — one request lists the whole tree, file contents come from
 * its CORS-open CDN, and there is no 60-requests/hour anonymous quota
 * (the per-file GitHub API path blows through it on any real repo).
 * The branch is first resolved to its head commit so the mirror serves
 * that exact tree. Private repos
 * and slash-containing branch names use the authenticated git API path.
 */
async function ghPullJsDelivr(parsed: { owner: string; repo: string }, branch: string): Promise<{ files: SyncFile[]; sha: string; skipped: number }> {
  // Resolve the branch to its current head sha with ONE GitHub API call,
  // then pull the mirror's copy of that exact commit: jsDelivr's @branch
  // cache can lag a push by days, while @<sha> is immutable and exact.
  let ref = branch;
  let sha = '';
  try {
    const branchInfo = (await gh(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`, '')) as { commit: { sha: string } };
    sha = branchInfo.commit.sha;
    if (sha) ref = sha;
  } catch {
    // Quota exhausted or offline mirror metadata — fall back to @branch.
  }
  let listing: { files?: Array<{ name: string; size?: number }> };
  try {
    const response = await fetch(`https://data.jsdelivr.com/v1/package/gh/${parsed.owner}/${parsed.repo}@${encodeURIComponent(ref)}/flat`);
    if (response.status === 404) throw new Error('Repository or branch not found on the public mirror. Check the names — private repositories need an access token (use the GitHub API path by adding one above).');
    if (!response.ok) throw new Error(`The public mirror refused the listing request (${response.status}).`);
    listing = (await response.json()) as { files?: Array<{ name: string; size?: number }> };
  } catch (error) {
    if (error instanceof Error && error.message.includes('mirror')) throw error;
    throw new Error('Could not reach the public mirror (data.jsdelivr.com).');
  }
  const entries = (listing.files ?? []).filter((entry) => entry.name && !entry.name.endsWith('/'));
  const MAX_ENTRIES = 2000;
  const MAX_SIZE = 20_000_000; // jsDelivr's per-file serving limit
  let skipped = Math.max(0, entries.length - MAX_ENTRIES);
  const wanted = entries.slice(0, MAX_ENTRIES).filter((entry) => {
    if ((entry.size ?? 0) > MAX_SIZE) { skipped += 1; return false; }
    return true;
  });
  const files: SyncFile[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < wanted.length) {
      const entry = wanted[cursor];
      cursor += 1;
      const path = entry.name.replace(/^\//, '');
      const url = `https://cdn.jsdelivr.net/gh/${parsed.owner}/${parsed.repo}@${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
      try {
        const response = await fetch(url);
        if (!response.ok) { skipped += 1; continue; }
        if (TEXT_PATH.test(path)) files.push({ path, content: await response.text() });
        else files.push({ path, content: '', blob: await response.blob() });
      } catch {
        skipped += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, () => worker()));
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error('The mirror listed the repository but no files could be downloaded.');
  return { files, sha, skipped };
}

export async function ghPull(repoInput: string, branch: string, token: string): Promise<{ files: SyncFile[]; sha: string; skipped: number }> {
  const parsed = parseRepo(repoInput);
  if (!parsed) throw new Error('Enter the repository as owner/name (or paste its GitHub URL).');
  if (token) return ghPullGitApi(parsed, branch, token);
  if (!branch.includes('/')) {
    try {
      return await ghPullJsDelivr(parsed, branch);
    } catch (mirrorError) {
      try {
        return await ghPullGitApi(parsed, branch, token);
      } catch {
        throw mirrorError;
      }
    }
  }
  return ghPullGitApi(parsed, branch, token);
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

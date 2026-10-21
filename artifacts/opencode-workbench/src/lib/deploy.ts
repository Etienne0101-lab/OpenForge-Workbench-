// One-click deploys from the browser to Netlify and Vercel.
//
// Netlify: the deploy API accepts a ZIP of the site — we build the archive
// in-page (fflate) and POST it; a site can be created on the fly.
// Vercel: the deployment API wants each file uploaded by its SHA-1 digest,
// then a deployment referencing those digests.
// Cloudflare Pages is covered by its own recommended route instead: Pages
// deploys automatically from a connected GitHub repository, which the
// workbench's GitHub sync already provides — the Deploy panel links there.
//
// Tokens are stored only in this browser's localStorage and sent only to
// the provider's API. IMPORTANT: these deploys publish the project as-is —
// for a workspace project, deploy the built/static files (e.g. an exported
// site's output), not raw monorepo source, unless the provider is set to
// build it.

import { zipSync } from 'fflate';

export type DeployFile = { path: string; content: string; blob?: Blob };
export type DeployResult = { url: string; detail: string; siteId?: string };

const NETLIFY_TOKEN_KEY = 'openforge-workbench-deploy-netlify-token';
const VERCEL_TOKEN_KEY = 'openforge-workbench-deploy-vercel-token';

function readToken(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeToken(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // session-only
  }
}

export const loadNetlifyToken = () => readToken(NETLIFY_TOKEN_KEY);
export const saveNetlifyToken = (value: string) => writeToken(NETLIFY_TOKEN_KEY, value);
export const loadVercelToken = () => readToken(VERCEL_TOKEN_KEY);
export const saveVercelToken = (value: string) => writeToken(VERCEL_TOKEN_KEY, value);

async function fileBytes(file: DeployFile): Promise<Uint8Array> {
  if (file.blob) return new Uint8Array(await file.blob.arrayBuffer());
  return new TextEncoder().encode(file.content);
}

async function providerError(response: Response, provider: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { message?: string; error?: { message?: string } };
    detail = body.error?.message || body.message || '';
  } catch {
    // non-JSON body
  }
  if (response.status === 401 || response.status === 403) {
    return new Error(`${provider} rejected the access token (${response.status})${detail ? `: ${detail}` : ''}. Check the token and its account access.`);
  }
  return new Error(`${provider} request failed (${response.status})${detail ? `: ${detail}` : ''}.`);
}

/* ------------------------------------------------------------------ */
/* Netlify                                                             */
/* ------------------------------------------------------------------ */

export async function deployNetlify(token: string, siteId: string, newSiteName: string, files: DeployFile[]): Promise<DeployResult> {
  if (!token) throw new Error('Add your Netlify access token first (Netlify → User settings → Applications → Personal access tokens).');
  if (!files.length) throw new Error('This workspace has no files to deploy.');
  let targetSiteId = siteId.trim();
  if (!targetSiteId) {
    const name = newSiteName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('Enter an existing Netlify site ID, or a name for a new site.');
    const createResponse = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!createResponse.ok) throw await providerError(createResponse, 'Netlify');
    const created = (await createResponse.json()) as { id: string; ssl_url?: string; name?: string };
    targetSiteId = created.id;
  }
  const archive: Record<string, Uint8Array> = {};
  for (const file of files) archive[file.path.replace(/^\/+/, '')] = await fileBytes(file);
  const zip = zipSync(archive, { level: 6 });
  const deployResponse = await fetch(`https://api.netlify.com/api/v1/sites/${targetSiteId}/deploys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: new Blob([new Uint8Array(zip)], { type: 'application/zip' }),
  });
  if (!deployResponse.ok) throw await providerError(deployResponse, 'Netlify');
  const deploy = (await deployResponse.json()) as { id: string; state?: string; ssl_url?: string; url?: string; deploy_ssl_url?: string };
  let state = deploy.state || 'processing';
  // Give Netlify a few seconds to finish processing small sites.
  for (let attempt = 0; attempt < 4 && state !== 'ready' && state !== 'error'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const poll = await fetch(`https://api.netlify.com/api/v1/sites/${targetSiteId}/deploys/${deploy.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.ok) state = ((await poll.json()) as { state?: string }).state || state;
  }
  const url = deploy.deploy_ssl_url || deploy.ssl_url || deploy.url || `https://app.netlify.com/sites/${targetSiteId}/deploys/${deploy.id}`;
  return {
    url,
    siteId: targetSiteId,
    detail: state === 'ready' ? 'Deploy is live.' : `Deploy accepted (state: ${state}) — Netlify may still be publishing; the URL resolves when it finishes.`,
  };
}

/* ------------------------------------------------------------------ */
/* Vercel                                                              */
/* ------------------------------------------------------------------ */

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deployVercel(token: string, projectName: string, files: DeployFile[]): Promise<DeployResult> {
  if (!token) throw new Error('Add your Vercel access token first (Vercel → Settings → Tokens).');
  const name = projectName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) throw new Error('Enter a Vercel project name.');
  if (!files.length) throw new Error('This workspace has no files to deploy.');

  const prepared: Array<{ file: string; sha: string; size: number; bytes: Uint8Array }> = [];
  for (const file of files) {
    const bytes = await fileBytes(file);
    prepared.push({ file: file.path.replace(/^\/+/, ''), sha: await sha1Hex(bytes), size: bytes.length, bytes });
  }

  const upload = async (item: (typeof prepared)[number]) => {
    const response = await fetch('https://api.vercel.com/v2/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-vercel-digest': item.sha, 'Content-Type': 'application/octet-stream' },
      body: new Blob([new Uint8Array(item.bytes)]),
    });
    if (!response.ok) throw await providerError(response, 'Vercel');
  };
  for (const item of prepared) await upload(item);

  const create = async () => {
    const response = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        target: 'production',
        files: prepared.map(({ file, sha, size }) => ({ file, sha, size })),
        projectSettings: { framework: null },
      }),
    });
    return response;
  };
  let response = await create();
  if (!response.ok) {
    const error = await providerError(response.clone(), 'Vercel');
    // Retry once if Vercel reports missing files (e.g. an upload raced).
    const bodyText = await response.text().catch(() => '');
    if (/missing/i.test(bodyText)) {
      for (const item of prepared) await upload(item);
      response = await create();
      if (!response.ok) throw await providerError(response, 'Vercel');
    } else {
      throw error;
    }
  }
  const deployment = (await response.json()) as { url?: string; readyState?: string };
  const host = deployment.url || `${name}.vercel.app`;
  return {
    url: `https://${host}`,
    detail: deployment.readyState === 'READY' ? 'Deploy is live.' : `Deployment created (state: ${deployment.readyState || 'QUEUED'}) — Vercel builds static deployments in seconds; the URL resolves when ready.`,
  };
}

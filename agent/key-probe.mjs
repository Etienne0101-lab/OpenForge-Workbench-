/**
 * OpenForge key probe — functional verification for the repo's API keys.
 *
 * Repo secrets are write-only: nothing can read their values back, so the
 * only honest test is to USE each key once, gently, from inside a workflow
 * run where the secrets exist as env vars. This probe does exactly one
 * read-only call per key and reports a verdict per secret NAME. Key values
 * are never printed (GitHub would mask them anyway; we don't rely on it).
 *
 * Checks:
 *   OPENROUTER_API_KEY..4 (+ _N aliases, + the assembled OPENROUTER_API_KEYS)
 *       GET /api/v1/key per key via quota.mjs — verdict + key label, tier,
 *       and the free-model daily counter/ceiling.
 *   OPENAI_API_KEY..3 (+ _N aliases)  GET {OPENAI_BASE_URL|api.openai.com/v1}/models per key
 *   MEGALLM_API_KEY   GET {MEGALLM_BASE_URL|api.megallm.io/v1}/models
 *       (MegaLLM is an OpenAI-compatible aggregator; base verified from its
 *       published examples, 2026-10-22.)
 *   QDRANT_API_KEY    with QDRANT_URL: GET {url}/collections (api-key
 *       header). Without it: tries the Qdrant Cloud management API
 *       (Authorization: apikey) — a database key scoped to one cluster
 *       cannot be verified without that cluster's URL, and the probe
 *       says so instead of guessing.
 *
 * Exit code is always 0: the log IS the report.
 */

import { parseKeyInfo } from './quota.mjs';

const TIMEOUT_MS = 12000;
const lines = [];
function report(name, verdict, detail = '') {
  lines.push(`${name}: ${verdict}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json = null;
  try { json = await response.json(); } catch { /* non-JSON reply */ }
  return { status: response.status, json };
}

async function probeOpenRouter() {
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const named = new Map();
  for (const name of ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY2', 'OPENROUTER_API_KEY3', 'OPENROUTER_API_KEY4', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3', 'OPENROUTER_API_KEY_4']) {
    const value = (process.env[name] || '').trim();
    if (value) named.set(name, value);
  }
  const pooled = (process.env.OPENROUTER_API_KEYS || '').split(/[\n,]/).map((key) => key.trim()).filter(Boolean);
  if (pooled.length) report('OPENROUTER_API_KEYS (assembled by the workflow)', 'INFO', `${pooled.length} key(s) arrived in the pool env`);
  const checkKey = async (name, key) => {
    try {
      const { status, json } = await getJson(`${base}/key`, { Authorization: `Bearer ${key}` });
      if (status === 200) {
        const info = parseKeyInfo(json);
        const tier = info.dailyLimit ? `${info.dailyLimit.toLocaleString()}/day tier` : info.isFreeTier === false ? 'unlocked tier' : info.isFreeTier === true ? '50/day tier' : 'tier unknown';
        const budget = info.dailyRemaining !== null ? `${info.dailyRemaining} free request(s) left today` : 'daily budget not reported';
        report(name, 'OK', `${info.label || 'unlabeled key'} · ${tier} · ${budget}`);
      } else if (status === 401 || status === 403) report(name, 'FAIL', `key rejected (HTTP ${status})`);
      else report(name, 'UNVERIFIED', `unexpected HTTP ${status} from /key`);
    } catch (error) { report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error)); }
  };
  const seen = new Set();
  for (const [name, key] of named) {
    if (seen.has(key)) { report(name, 'INFO', 'same value as an earlier key (alias spelling)'); continue; }
    seen.add(key);
    await checkKey(name, key);
  }
  for (const key of pooled) if (!seen.has(key)) { seen.add(key); await checkKey('OPENROUTER_API_KEYS (extra pool key)', key); }
  if (!named.size && !pooled.length) report('OPENROUTER_*', 'ABSENT', 'no OpenRouter secret is set');
}

async function probeModels(name, baseUrl) {
  const key = (process.env[name] || '').trim();
  if (!key) { report(name, 'ABSENT', 'secret is not set'); return; }
  try {
    const { status, json } = await getJson(`${baseUrl.replace(/\/$/, '')}/models`, { Authorization: `Bearer ${key}` });
    const count = Array.isArray(json?.data) ? json.data.length : null;
    if (status === 200) report(name, 'OK', count === null ? 'models endpoint reachable' : `${count} models listed`);
    else if (status === 401 || status === 403) report(name, 'FAIL', `key rejected (HTTP ${status})`);
    else report(name, 'UNVERIFIED', `unexpected HTTP ${status} from the models endpoint`);
  } catch (error) {
    report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error));
  }
}

async function probeQdrant() {
  const key = (process.env.QDRANT_API_KEY || '').trim();
  if (!key) { report('QDRANT_API_KEY', 'ABSENT', 'secret is not set'); return; }
  const url = (process.env.QDRANT_URL || '').trim().replace(/\/$/, '');
  if (url) {
    try {
      const { status, json } = await getJson(`${url}/collections`, { 'api-key': key });
      const collections = json?.result?.collections;
      if (status === 200) report('QDRANT_API_KEY', 'OK', `${Array.isArray(collections) ? collections.length : '?'} collection(s) on the cluster`);
      else if (status === 401 || status === 403) report('QDRANT_API_KEY', 'FAIL', `key rejected by the cluster (HTTP ${status})`);
      else report('QDRANT_API_KEY', 'UNVERIFIED', `unexpected HTTP ${status} from the cluster`);
    } catch (error) { report('QDRANT_API_KEY', 'UNREACHABLE', error instanceof Error ? error.message : String(error)); }
    return;
  }
  try {
    const { status, json } = await getJson('https://api.cloud.qdrant.io/api/v1/clusters', { Authorization: `apikey ${key}` });
    if (status === 200) {
      const clusters = json?.items || json?.clusters || [];
      report('QDRANT_API_KEY', 'OK', `valid Qdrant Cloud management key (${Array.isArray(clusters) ? clusters.length : '?'} cluster(s) visible)`);
    } else {
      report('QDRANT_API_KEY', 'UNVERIFIED', `not a cloud management key (HTTP ${status}). If this is a cluster database key, add a QDRANT_URL secret (https://<cluster>.cloud.qdrant.io:6333) so the probe can test it against the cluster.`);
    }
  } catch (error) { report('QDRANT_API_KEY', 'UNREACHABLE', error instanceof Error ? error.message : String(error)); }
}

async function probeOpenAiSeries() {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const seen = new Set();
  let any = false;
  for (const name of ['OPENAI_API_KEY', 'OPENAI_API_KEY2', 'OPENAI_API_KEY3', 'OPENAI_API_KEY_2', 'OPENAI_API_KEY_3']) {
    const value = (process.env[name] || '').trim();
    if (!value) continue;
    any = true;
    if (seen.has(value)) { report(name, 'INFO', 'same value as an earlier key (alias spelling)'); continue; }
    seen.add(value);
    try {
      const { status, json } = await getJson(`${base.replace(/\/$/, '')}/models`, { Authorization: `Bearer ${value}` });
      const count = Array.isArray(json?.data) ? json.data.length : null;
      if (status === 200) report(name, 'OK', count === null ? 'models endpoint reachable' : `${count} models listed`);
      else if (status === 401 || status === 403) report(name, 'FAIL', `key rejected (HTTP ${status})`);
      else report(name, 'UNVERIFIED', `unexpected HTTP ${status} from the models endpoint`);
    } catch (error) { report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error)); }
  }
  if (!any) report('OPENAI_API_KEY', 'ABSENT', 'no OpenAI secret is set');
}

await probeOpenRouter();
await probeOpenAiSeries();
await probeModels('MEGALLM_API_KEY', process.env.MEGALLM_BASE_URL || 'https://api.megallm.io/v1');
await probeQdrant();
console.log('=== OpenForge key probe ===');
for (const line of lines) console.log(line);
console.log('=== end of probe (values are never printed) ===');

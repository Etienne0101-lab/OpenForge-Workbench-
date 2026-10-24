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
 *   NVIDIABUILD       (NVIDIA Build / NIM, base integrate.api.nvidia.com/v1)
 *       GET /models, then — decisively — one tiny POST /chat/completions
 *       on a listed Nemotron model. The models list alone is NOT proof:
 *       new NVIDIA keys have been reported to list models yet 404 on
 *       chat calls, so only an answered completion earns an OK. Reports
 *       the Nemotron ids found, the completion's token usage, and any
 *       rate-limit headers the endpoint returns. NVIDIA_API_KEY is
 *       accepted as an alias env name for the same key.
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
      else if (status === 401 || status === 403) {
        // OpenAI's error code/type are diagnostic gold (invalid_api_key vs
        // account state). Never surface error.message: it echoes a fragment
        // of the provided key.
        const code = typeof json?.error?.code === 'string' ? json.error.code : '';
        const type = typeof json?.error?.type === 'string' ? json.error.type : '';
        report(name, 'FAIL', `key rejected (HTTP ${status}${code ? `, error code: ${code}` : ''}${type ? `, type: ${type}` : ''})`);
      }
      else report(name, 'UNVERIFIED', `unexpected HTTP ${status} from the models endpoint`);
    } catch (error) { report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error)); }
  }
  if (!any) report('OPENAI_API_KEY', 'ABSENT', 'no OpenAI secret is set');
}

async function probeNvidia() {
  const base = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
  const seen = new Set();
  let any = false;
  for (const name of ['NVIDIABUILD', 'NVIDIA_API_KEY']) {
    const key = (process.env[name] || '').trim();
    if (!key) continue;
    any = true;
    if (seen.has(key)) { report(name, 'INFO', 'same value as an earlier key (alias spelling)'); continue; }
    seen.add(key);
    const auth = { Authorization: `Bearer ${key}` };
    let ids = [];
    try {
      const models = await fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const modelsJson = await models.json().catch(() => null);
      if (models.status === 401 || models.status === 403) { report(name, 'FAIL', `key rejected by the models endpoint (HTTP ${models.status})`); continue; }
      if (models.status !== 200) { report(name, 'UNVERIFIED', `unexpected HTTP ${models.status} from the models endpoint`); continue; }
      ids = Array.isArray(modelsJson?.data) ? modelsJson.data.map((m) => m?.id).filter((id) => typeof id === 'string') : [];
    } catch (error) {
      report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error));
      continue;
    }
    const nemotron = ids.filter((id) => /nemotron/i.test(id));
    const preferred = nemotron.find((id) => /3\.5/i.test(id) && /lightning/i.test(id))
      || nemotron.find((id) => /3\.5/i.test(id))
      || nemotron[0];
    report(name, 'MODELS', `${ids.length} model(s) listed${nemotron.length ? ` · Nemotron ids: ${nemotron.slice(0, 5).join(', ')}${nemotron.length > 5 ? ` (+${nemotron.length - 5} more)` : ''}` : ' · no Nemotron model listed'}`);
    if (!preferred) { report(name, 'UNVERIFIED', 'models list OK but no Nemotron model to run the chat test on — chat test skipped'); continue; }
    // The decisive call: an answered completion, not just a list entry.
    try {
      const chat = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: preferred, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 8, temperature: 0 }),
        signal: AbortSignal.timeout(60000),
      });
      const chatJson = await chat.json().catch(() => null);
      const rateHeaders = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'retry-after']
        .map((h) => { const v = chat.headers.get(h); return v === null ? null : `${h}=${v}`; })
        .filter(Boolean)
        .join(', ');
      if (chat.status === 200) {
        const usage = chatJson?.usage;
        const usageText = usage ? `tokens prompt/completion/total ${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}/${usage.total_tokens ?? '?'}` : 'no usage block returned';
        report(name, 'OK', `chat completion answered on ${preferred} · ${usageText}${rateHeaders ? ` · rate headers: ${rateHeaders}` : ' · no rate-limit headers returned'}`);
      } else if (chat.status === 404) {
        report(name, 'UNVERIFIED', `models list OK but chat returned 404 for ${preferred} — known new-key failure mode (key lists models but cannot call them); regenerate or re-check the key in the NVIDIA dashboard`);
      } else if (chat.status === 429) {
        report(name, 'RATE-LIMITED', `key accepted but capped right now on ${preferred} (HTTP 429${rateHeaders ? ` · ${rateHeaders}` : ''})`);
      } else if (chat.status === 401 || chat.status === 403) {
        report(name, 'FAIL', `key rejected by chat completions (HTTP ${chat.status})`);
      } else {
        report(name, 'UNVERIFIED', `unexpected HTTP ${chat.status} from chat completions on ${preferred}`);
      }
    } catch (error) {
      report(name, 'UNREACHABLE', error instanceof Error ? error.message : String(error));
    }
  }
  if (!any) report('NVIDIABUILD', 'ABSENT', 'secret is not set');
}

await probeOpenRouter();
await probeOpenAiSeries();
await probeModels('MEGALLM_API_KEY', process.env.MEGALLM_BASE_URL || 'https://api.megallm.io/v1');
await probeNvidia();
await probeQdrant();
console.log('=== OpenForge key probe ===');
for (const line of lines) console.log(line);
console.log('=== end of probe (values are never printed) ===');

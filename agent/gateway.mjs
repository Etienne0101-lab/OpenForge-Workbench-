/**
 * The OpenForge gateway (self-hosted, OpenRouter-shaped).
 *
 * One OpenAI-compatible front door on the companion that routes to
 * whatever the user actually owns:
 *
 *   local/<alias>        -> the companion's llama.cpp / Ollama models
 *   openrouter/<model>   -> OpenRouter, through the user's own key
 *                           pool (rotation, cooldowns, quota-aware)
 *   <name>/<model>       -> any other OpenAI-compatible upstream the
 *                           user configures in ~/.openforge/gateway.json
 *                           (Groq, Together, OpenAI, DeepSeek, NVIDIA
 *                           Build, a vLLM box…) — keys referenced by
 *                           env var name. An upstream with no declared
 *                           models lists its own /models catalog, and
 *                           excluded models are filtered on every leg.
 *   auto                 -> the priority free-model pool with health
 *                           ordering and cross-model fallback
 *   <bare model id>      -> treated as an OpenRouter model id
 *
 * Fallback discipline: an explicitly named model retries across KEYS
 * only (a paid model is never silently swapped); `auto` and `:free`
 * requests may fall across models. Keys cool down on 429 (Retry-After
 * honored) and on 401/403. Every request is counted and appended to
 * ~/.openforge/gateway-usage.jsonl.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { INFERENCE_MODELS, DEFAULT_INFERENCE_MODEL } from './inference.mjs';
import { PRIORITY_MODELS, EXCLUDED_MODEL_PATTERNS } from './model-router.mjs';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function openRouterKeysFromEnv(env = process.env) {
  const keys = [];
  const push = (value) => { const key = (value || '').trim(); if (key && !keys.includes(key)) keys.push(key); };
  for (const part of (env.OPENROUTER_API_KEYS || '').split(',')) push(part);
  push(env.OPENROUTER_API_KEY);
  push(env.OPENROUTER_API_KEY2);
  push(env.OPENROUTER_API_KEY3);
  push(env.OPENROUTER_API_KEY_2);
  push(env.OPENROUTER_API_KEY_3);
  push(env.OPENROUTER_API_KEY4);
  push(env.OPENROUTER_API_KEY_4);
  return keys;
}

export function loadUpstreams(baseDir, env = process.env) {
  const upstreams = [{
    name: 'openrouter',
    baseUrl: OPENROUTER_BASE,
    keys: openRouterKeysFromEnv(env),
    models: [],
    builtin: true,
  }];
  const configPath = path.join(baseDir, 'gateway.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      for (const entry of config.upstreams || []) {
        if (!entry?.name || !entry?.baseUrl) continue;
        const keys = [];
        if (entry.keyEnv && env[entry.keyEnv]) keys.push(env[entry.keyEnv]);
        if (entry.keysEnv) for (const part of (env[entry.keysEnv] || '').split(',')) { const key = part.trim(); if (key) keys.push(key); }
        if (Array.isArray(entry.keys)) for (const key of entry.keys) { if (typeof key === 'string' && key) keys.push(key); }
        upstreams.push({ name: String(entry.name), baseUrl: String(entry.baseUrl).replace(/\/+$/, ''), keys, models: Array.isArray(entry.models) ? entry.models.map(String) : [], builtin: false });
      }
    } catch { /* a broken gateway.json leaves the built-ins standing */ }
  }
  return { upstreams, configPath };
}

const excluded = (model) => EXCLUDED_MODEL_PATTERNS.some((pattern) => pattern.test(model));

export function createGateway(options = {}) {
  const baseDir = options.baseDir || path.join(homedir(), '.openforge');
  const inference = options.inference || null;
  const log = options.log || (() => {});
  const fetchImpl = options.fetchImpl || fetch;
  const { upstreams, configPath } = loadUpstreams(baseDir, options.env || process.env);
  const byName = new Map(upstreams.map((upstream) => [upstream.name, upstream]));
  const keyState = new Map(); // `${upstream}:${index}` -> auth/global cooldown { cooldownUntil, failures }
  const modelKeyState = new Map(); // `${upstream}:${index}:${model}` -> 429 cooldowns (rate limits are per model+key)
  const keyCursor = new Map();
  const counters = { requests: 0, succeeded: 0, failed: 0, byUpstream: {} };
  let catalogCache = { at: 0, data: null };

  function keyHealth(upstream, index) {
    const state = keyState.get(`${upstream.name}:${index}`) || { cooldownUntil: 0, failures: 0 };
    return { cooling: state.cooldownUntil > Date.now(), cooldownUntil: state.cooldownUntil, failures: state.failures };
  }

  function modelCooling(upstream, index, model) {
    const state = modelKeyState.get(`${upstream.name}:${index}:${model}`);
    return !!state && state.cooldownUntil > Date.now();
  }

  function nextKey(upstream, model) {
    if (!upstream.keys.length) return null;
    const start = keyCursor.get(upstream.name) || 0;
    for (let step = 0; step < upstream.keys.length; step += 1) {
      const index = (start + step) % upstream.keys.length;
      if (!keyHealth(upstream, index).cooling && !modelCooling(upstream, index, model)) {
        keyCursor.set(upstream.name, (index + 1) % upstream.keys.length);
        return { key: upstream.keys[index], index };
      }
    }
    return null; // every key is cooling for this model
  }

  function coolKey(upstream, index, ms, reason, model = null) {
    if (model) {
      modelKeyState.set(`${upstream.name}:${index}:${model}`, { cooldownUntil: Date.now() + ms });
      log(`[gateway] key ${index} for ${upstream.name} cooling ${Math.round(ms / 1000)}s on ${model} (${reason})`);
      return;
    }
    const current = keyState.get(`${upstream.name}:${index}`) || { cooldownUntil: 0, failures: 0 };
    keyState.set(`${upstream.name}:${index}`, { cooldownUntil: Date.now() + ms, failures: current.failures + 1 });
    log(`[gateway] key ${index} for ${upstream.name} cooling ${Math.round(ms / 1000)}s (${reason})`);
  }

  function record(entry) {
    counters.requests += 1;
    if (entry.outcome === 'ok') counters.succeeded += 1; else counters.failed += 1;
    counters.byUpstream[entry.upstream] = (counters.byUpstream[entry.upstream] || 0) + 1;
    try { appendFileSync(path.join(baseDir, 'gateway-usage.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`); } catch { /* accounting is best-effort */ }
  }

  function resolveRoute(modelId) {
    const id = String(modelId || '');
    if (id === 'auto') {
      const openrouter = byName.get('openrouter');
      if (openrouter?.keys.length) return { kind: 'upstream', upstream: openrouter, chain: PRIORITY_MODELS.filter((model) => !excluded(model)), crossModel: true };
      if (inference) return { kind: 'local', alias: DEFAULT_INFERENCE_MODEL };
      return { error: 'auto routing needs OpenRouter keys (OPENROUTER_API_KEYS) or local inference (--inference).' };
    }
    if (id.startsWith('local/')) {
      const alias = id.slice('local/'.length);
      if (!INFERENCE_MODELS[alias]) return { error: `Unknown local model "${alias}". Known: ${Object.keys(INFERENCE_MODELS).join(', ')}.` };
      if (!inference) return { error: 'Local inference is not enabled on this companion. Restart it with --inference.' };
      return { kind: 'local', alias };
    }
    const slash = id.indexOf('/');
    if (slash > 0) {
      const upstream = byName.get(id.slice(0, slash));
      if (upstream && !upstream.builtin) return { kind: 'upstream', upstream, chain: [id.slice(slash + 1)], crossModel: false };
      if (upstream?.builtin) {
        const model = id.slice(slash + 1);
        const crossModel = model === 'openrouter/free' || model.endsWith(':free');
        return { kind: 'upstream', upstream, chain: crossModel ? [model, ...PRIORITY_MODELS.filter((candidate) => candidate !== model && !excluded(candidate))] : [model], crossModel };
      }
    }
    const openrouter = byName.get('openrouter');
    if (openrouter?.keys.length) {
      const crossModel = id === 'openrouter/free' || id.endsWith(':free');
      return { kind: 'upstream', upstream: openrouter, chain: crossModel ? [id, ...PRIORITY_MODELS.filter((candidate) => candidate !== id && !excluded(candidate))] : [id], crossModel };
    }
    for (const upstream of upstreams) {
      if (!upstream.builtin && upstream.keys.length && upstream.models.some((model) => id === model || id.startsWith(model))) {
        return { kind: 'upstream', upstream, chain: [id], crossModel: false };
      }
    }
    return { error: `No route for model "${id}". Prefix with local/, openrouter/, or a configured upstream name, and make sure that leg has keys.` };
  }

  async function attemptUpstream(upstream, model, body, stream) {
    const picked = nextKey(upstream, model);
    if (!picked) return { outcome: 'all-keys-cooling' };
    const response = await fetchImpl(`${upstream.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${picked.key}` },
      body: JSON.stringify({ ...body, model, stream }),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get?.('retry-after') || 0);
      coolKey(upstream, picked.index, retryAfter > 0 ? retryAfter * 1000 : 60_000, 'rate limited', model);
      return { outcome: 'rate-limited' };
    }
    if (response.status === 401 || response.status === 403) {
      coolKey(upstream, picked.index, 10 * 60_000, `auth HTTP ${response.status}`);
      return { outcome: 'auth-failed' };
    }
    if (response.status >= 500) return { outcome: `upstream-${response.status}` };
    return { outcome: 'responded', response, keyIndex: picked.index };
  }

  /**
   * Runs a chat completion. Returns either
   *   { status, json }                 — a completed JSON response, or
   *   { status, streamResponse }       — pipe streamResponse.body to the client.
   */
  async function handleChat(body) {
    const requestedModel = body?.model || 'auto';
    const stream = !!body?.stream;
    const route = resolveRoute(requestedModel);
    if (route.error) return { status: 400, json: { error: { message: route.error } } };
    if (route.kind === 'local') {
      if (!inference) return { status: 503, json: { error: { message: 'Local inference is not enabled.' } } };
      try {
        const result = await inference.chat(body.messages || [], { temperature: body.temperature, maxTokens: body.max_tokens, stream });
        if (stream) {
          record({ model: requestedModel, upstream: 'local', outcome: result?.ok === false ? 'error' : 'ok' });
          if (result && typeof result === 'object' && 'ok' in result) {
            if (!result.ok) return { status: result.status || 502, json: { error: { message: `Local runtime replied HTTP ${result.status}.` } } };
            return { status: 200, streamResponse: result };
          }
          return { status: 500, json: { error: { message: 'Local runtime did not provide a stream.' } } };
        }
        record({ model: requestedModel, upstream: 'local', outcome: 'ok' });
        return { status: 200, json: { id: `chatcmpl-local-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, message: { role: 'assistant', content: String(result || '') }, finish_reason: 'stop' }] } };
      } catch (error) {
        record({ model: requestedModel, upstream: 'local', outcome: 'error' });
        return { status: error.statusCode || 502, json: { error: { message: error instanceof Error ? error.message : String(error) } } };
      }
    }
    const { upstream, chain } = route;
    if (!upstream.keys.length) {
      record({ model: requestedModel, upstream: upstream.name, outcome: 'no-keys' });
      return { status: 503, json: { error: { message: `The ${upstream.name} leg has no keys configured.` } } };
    }
    let lastOutcome = 'no-attempt';
    for (const model of chain) {
      for (let keyAttempts = 0; keyAttempts < Math.max(1, upstream.keys.length); keyAttempts += 1) {
        let attempt;
        try {
          attempt = await attemptUpstream(upstream, model, body, stream);
        } catch (error) {
          lastOutcome = 'network-error';
          continue;
        }
        lastOutcome = attempt.outcome;
        if (attempt.outcome !== 'responded') continue;
        const { response } = attempt;
        if (stream) {
          record({ model: requestedModel, upstream: upstream.name, key: attempt.keyIndex, outcome: 'ok' });
          return { status: response.status, streamResponse: response };
        }
        const data = await response.json().catch(() => null);
        record({ model: requestedModel, upstream: upstream.name, key: attempt.keyIndex, outcome: response.ok ? 'ok' : `http-${response.status}`, promptTokens: data?.usage?.prompt_tokens, completionTokens: data?.usage?.completion_tokens });
        return { status: response.status, json: data || { error: { message: 'Upstream returned an unreadable response.' } } };
      }
      if (!route.crossModel) break;
    }
    record({ model: requestedModel, upstream: upstream.name, outcome: lastOutcome });
    return { status: 503, json: { error: { message: `All routes for "${requestedModel}" are unavailable right now (${lastOutcome}). Keys may be cooling down after rate limits — try again shortly.` } } };
  }

  // Upstream catalogs (per upstream, 10-minute cache): a configured
  // upstream that declares models lists exactly those; one that declares
  // none lists whatever its own /models endpoint reports. Either way the
  // platform's exclusion list applies — an upstream that serves an
  // excluded model (NVIDIA serves Gemma, for example) never exposes it
  // through this gateway, on any surface.
  const upstreamCatalogCache = new Map();
  async function upstreamCatalog(upstream) {
    if (upstream.models.length) {
      return upstream.models.filter((model) => !excluded(model)).map((model) => ({ id: `${upstream.name}/${model}`, object: 'model', owned_by: upstream.name }));
    }
    if (!upstream.keys.length) return [];
    const cached = upstreamCatalogCache.get(upstream.name);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.data;
    try {
      const response = await fetchImpl(`${upstream.baseUrl}/models`, { headers: { authorization: `Bearer ${upstream.keys[0]}` } });
      const payload = await response.json();
      const models = (Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => entry?.id)
        .filter((id) => typeof id === 'string' && !excluded(id))
        .map((id) => ({ id: `${upstream.name}/${id}`, object: 'model', owned_by: upstream.name }));
      upstreamCatalogCache.set(upstream.name, { at: Date.now(), data: models });
      return models;
    } catch {
      return [];
    }
  }

  async function listModels() {
    const data = [];
    if (inference) for (const alias of Object.keys(INFERENCE_MODELS)) data.push({ id: `local/${alias}`, object: 'model', owned_by: 'local' });
    const openrouter = byName.get('openrouter');
    if (openrouter?.keys.length) {
      if (catalogCache.data && Date.now() - catalogCache.at < 10 * 60_000) {
        data.push(...catalogCache.data);
      } else {
        try {
          const response = await fetchImpl(`${OPENROUTER_BASE}/models`, { headers: { authorization: `Bearer ${openrouter.keys[0]}` } });
          const payload = await response.json();
          const models = (payload.data || []).map((entry) => ({ id: `openrouter/${entry.id}`, object: 'model', owned_by: 'openrouter' }));
          catalogCache = { at: Date.now(), data: models };
          data.push(...models);
        } catch {
          for (const model of PRIORITY_MODELS) data.push({ id: `openrouter/${model}`, object: 'model', owned_by: 'openrouter' });
        }
      }
      data.push({ id: 'auto', object: 'model', owned_by: 'openforge' });
    }
    for (const upstream of upstreams) {
      if (upstream.builtin) continue;
      data.push(...await upstreamCatalog(upstream));
    }
    return { object: 'list', data };
  }

  function status() {
    return {
      configPath,
      inference: inference ? inference.state : { enabled: false, status: 'off' },
      upstreams: upstreams.map((upstream) => ({
        name: upstream.name,
        baseUrl: upstream.baseUrl,
        keyCount: upstream.keys.length,
        keys: upstream.keys.map((unused, index) => ({ index, ...keyHealth(upstream, index) })),
        declaredModels: upstream.models.length,
      })),
      counters,
    };
  }

  return { handleChat, listModels, status, resolveRoute };
}

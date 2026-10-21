/**
 * OpenForge model router — the learning layer over the model catalog.
 *
 * Three jobs:
 *  1. CATALOG: know every model the provider offers (fetched live), not a
 *     hardcoded handful.
 *  2. PRESSURE: track each model's recent rate-limit pressure and cool
 *     capped models down, so routing rotates AWAY from a model as it
 *     approaches its limit — proactively, not just after a 429 lands.
 *  3. LEARNING: online statistical selection (a UCB bandit over
 *     model × task-class arms, fed by every call's outcome and persisted
 *     to .openforge/model-stats.json). Models that prove themselves on a
 *     kind of task get picked for it more; unexplored models still get
 *     their exploration bonus, so the catalog keeps being discovered.
 *
 * Stats are plain JSON in the workspace, so they travel through git like
 * everything else: workers inherit the collective's experience, and the
 * swarm integrator merges per-worker stats back into one brain.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATS_PATH = '.openforge/model-stats.json';
export const COOLDOWN_MS = 120000;
const PRESSURE_WINDOW = 40;

/* ---------- Task classification (deterministic, testable) ---------- */

const CLASS_KEYWORDS = {
  tests: ['test', 'spec', 'coverage', 'jest', 'vitest', 'pytest', 'assert', 'fixture'],
  docs: ['readme', 'document', 'docs', 'guide', 'changelog', 'comment', 'jsdoc', 'tutorial'],
  data: ['csv', 'json data', 'dataset', 'etl', 'pipeline', 'sql', 'database', 'pandas', 'transform'],
  web: ['ui', 'page', 'component', 'css', 'style', 'layout', 'react', 'frontend', 'landing'],
  ops: ['deploy', 'ci', 'workflow', 'docker', 'config', 'infra', 'server', 'hosting', 'actions'],
  code: ['implement', 'function', 'bug', 'fix', 'refactor', 'api', 'endpoint', 'class', 'module', 'feature'],
};

export function classifyTask(text) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  let best = 'general';
  let bestScore = 0;
  for (const [taskClass, keywords] of Object.entries(CLASS_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) if (haystack.includes(keyword)) score += 1;
    if (score > bestScore) { best = taskClass; bestScore = score; }
  }
  return best;
}

/* ---------- Catalog ---------- */

export async function fetchFreeModelIds(baseUrl) {
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/$/, '')}/models`);
    if (!response.ok) return [];
    const data = await response.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    return models
      .filter((model) => model && model.id && (model.id.endsWith(':free') || (model.pricing && Number(model.pricing.prompt) === 0 && Number(model.pricing.completion) === 0)))
      .map((model) => model.id)
      .sort();
  } catch {
    return [];
  }
}

/* ---------- Stats ---------- */

export function emptyStats() {
  return { version: 1, updatedAt: 0, arms: {}, pressure: {} };
}

export async function loadStats(root) {
  try {
    const raw = await readFile(path.join(root, STATS_PATH), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.arms && parsed.pressure) return parsed;
  } catch { /* no stats yet — a fresh brain */ }
  return emptyStats();
}

export async function saveStats(root, stats) {
  stats.updatedAt = Date.now();
  await mkdir(path.join(root, '.openforge'), { recursive: true });
  await writeFile(path.join(root, STATS_PATH), JSON.stringify(stats, null, 2), 'utf8');
}

export function mergeStats(a, b) {
  const out = emptyStats();
  out.updatedAt = Math.max(a?.updatedAt || 0, b?.updatedAt || 0);
  const armKeys = new Set([...Object.keys(a?.arms || {}), ...Object.keys(b?.arms || {})]);
  for (const key of armKeys) {
    const x = a?.arms?.[key];
    const y = b?.arms?.[key];
    if (!x || !y) { out.arms[key] = { ...(x || y) }; continue; }
    const pulls = x.pulls + y.pulls;
    out.arms[key] = {
      pulls,
      ok: x.ok + y.ok,
      rl: x.rl + y.rl,
      err: x.err + y.err,
      latencyEmaMs: pulls ? Math.round(((x.latencyEmaMs || 0) * x.pulls + (y.latencyEmaMs || 0) * y.pulls) / pulls) : 0,
      lastUsedAt: Math.max(x.lastUsedAt || 0, y.lastUsedAt || 0),
      lastRateLimitAt: Math.max(x.lastRateLimitAt || 0, y.lastRateLimitAt || 0),
    };
  }
  const modelIds = new Set([...Object.keys(a?.pressure || {}), ...Object.keys(b?.pressure || {})]);
  for (const id of modelIds) {
    const window = [...(a?.pressure?.[id]?.window || []), ...(b?.pressure?.[id]?.window || [])]
      .sort((m, n) => m.at - n.at)
      .slice(-PRESSURE_WINDOW);
    out.pressure[id] = { window, cooldownUntil: Math.max(a?.pressure?.[id]?.cooldownUntil || 0, b?.pressure?.[id]?.cooldownUntil || 0) };
  }
  return out;
}

/* ---------- The router ---------- */

export class ModelRouter {
  constructor({ stats, catalogIds, pinnedModel, nowFn }) {
    this.stats = stats || emptyStats();
    this.catalog = catalogIds && catalogIds.length ? catalogIds : [];
    this.pinned = pinnedModel || null;
    this.now = nowFn || (() => Date.now());
  }

  arm(model, taskClass) {
    return this.stats.arms[`${model}|${taskClass}`] || { pulls: 0, ok: 0, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 };
  }

  /** Recent rate-limit ratio for a model (0 = calm, 1 = saturated). */
  pressureRatio(model) {
    const window = this.stats.pressure[model]?.window || [];
    if (!window.length) return 0;
    const recent = window.slice(-12);
    return recent.filter((entry) => entry.rl).length / recent.length;
  }

  inCooldown(model) {
    return (this.stats.pressure[model]?.cooldownUntil || 0) > this.now();
  }

  score(model, taskClass, totalPulls) {
    const arm = this.arm(model, taskClass);
    const successRate = (arm.ok + 1) / (arm.pulls + 2); // Laplace-smoothed
    const exploration = Math.sqrt((2 * Math.log(totalPulls + 2)) / (arm.pulls + 1)) * 0.35; // UCB bonus
    const pressurePenalty = this.pressureRatio(model) * 0.9;
    const latencyPenalty = Math.min((arm.latencyEmaMs || 0) / 120000, 0.15);
    return successRate + exploration - pressurePenalty - latencyPenalty;
  }

  /**
   * Ordered candidate list for the next call. The pinned (user-chosen)
   * model leads while it is healthy. `prefer` (the caller's current
   * model) stays first while calm — stickiness — but as its pressure
   * builds, the ranking takes over and the caller rotates proactively.
   */
  candidates(taskClass, prefer) {
    const universe = [...new Set([this.pinned, ...this.catalog].filter(Boolean))];
    const totalPulls = Object.values(this.stats.arms).reduce((sum, arm) => sum + arm.pulls, 0);
    const available = universe.filter((model) => !this.inCooldown(model));
    const pool = (available.length ? available : universe)
      .map((model) => ({ model, score: this.score(model, taskClass, totalPulls) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.model);
    if (this.pinned && pool.includes(this.pinned) && this.pressureRatio(this.pinned) < 0.5) {
      return [this.pinned, ...pool.filter((model) => model !== this.pinned)].slice(0, 10);
    }
    if (prefer && pool.includes(prefer) && this.pressureRatio(prefer) < 0.34 && !this.inCooldown(prefer)) {
      return [prefer, ...pool.filter((model) => model !== prefer)].slice(0, 10);
    }
    return pool.slice(0, 10);
  }

  record({ model, taskClass, ok, status, latencyMs }) {
    const key = `${model}|${taskClass}`;
    const arm = this.stats.arms[key] || (this.stats.arms[key] = { pulls: 0, ok: 0, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 });
    arm.pulls += 1;
    if (ok) arm.ok += 1;
    else if (status === 429) { arm.rl += 1; arm.lastRateLimitAt = this.now(); }
    else arm.err += 1;
    if (typeof latencyMs === 'number' && latencyMs > 0) {
      arm.latencyEmaMs = arm.latencyEmaMs ? Math.round(arm.latencyEmaMs * 0.7 + latencyMs * 0.3) : latencyMs;
    }
    arm.lastUsedAt = this.now();
    const pressure = this.stats.pressure[model] || (this.stats.pressure[model] = { window: [], cooldownUntil: 0 });
    pressure.window.push({ at: this.now(), rl: status === 429 });
    if (pressure.window.length > PRESSURE_WINDOW) pressure.window = pressure.window.slice(-PRESSURE_WINDOW);
    if (status === 429) pressure.cooldownUntil = this.now() + COOLDOWN_MS;
    this.stats.updatedAt = this.now();
  }

  /** One-line-per-model digest for mission reports. */
  digest(taskClass, limit = 5) {
    return this.candidates(taskClass).slice(0, limit).map((model) => {
      const arm = this.arm(model, taskClass);
      const rate = arm.pulls ? `${Math.round((arm.ok / arm.pulls) * 100)}% ok over ${arm.pulls} calls` : 'unexplored';
      const pressure = this.pressureRatio(model);
      return `${model} — ${rate}${pressure > 0.3 ? `, recent rate-limit pressure ${Math.round(pressure * 100)}%` : ''}`;
    });
  }
}

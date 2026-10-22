/**
 * Quota ledger (Context Density, Phase 2).
 *
 * OpenRouter's free-model budget is PER ACCOUNT: 20 requests/minute
 * and a daily ceiling (50/day, or 1,000/day once the account has
 * bought $10+ of credits lifetime) — and FAILED attempts count
 * against the day. This ledger keeps the workbench honest about that
 * budget:
 *
 *  - CALIBRATION: GET /api/v1/key reports the provider's own daily
 *    free-request counter and ceiling (free_model_daily_requests),
 *    the tier flag, and credit headroom. Ground truth wins over any
 *    local estimate whenever it is fresh.
 *  - COUNTING: every free-model request made from this browser is
 *    counted locally (failures included), so the meter keeps moving
 *    between calibrations.
 *  - PACING: a sliding 60-second window keeps free-model requests
 *    under the per-minute ceiling BY CONSTRUCTION — the caller waits
 *    for the next slot instead of discovering the cap via a 429.
 */

export interface QuotaCalibration {
  checkedAt: number;
  isFreeTier: boolean | null;
  dailyLimit: number | null;
  dailyUsed: number | null;
  dailyRemaining: number | null;
  limitRemaining: number | null;
}

interface QuotaState {
  day: string; // UTC day — the provider's usage day is UTC
  countedToday: number;
  recent: number[]; // timestamps (ms) of recent free-model requests
  calibration: QuotaCalibration | null;
}

const QUOTA_STORAGE_KEY = 'openforge-workbench-quota';
export const FREE_RPM_CEILING = 20;
const PACE_THRESHOLD = 18; // start pacing before the ceiling, not at it
const DEFAULT_DAILY_CAP = 50;
const UNLOCKED_DAILY_CAP = 1000;

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function emptyState(): QuotaState {
  return { day: utcDay(), countedToday: 0, recent: [], calibration: null };
}

export function loadQuota(): QuotaState {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUOTA_STORAGE_KEY) || 'null') as QuotaState | null;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    if (parsed.day !== utcDay()) {
      // New UTC day: the daily counter resets; calibration survives
      // (its ceiling still applies, its used-count is now stale).
      return { day: utcDay(), countedToday: 0, recent: [], calibration: parsed.calibration };
    }
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function saveQuota(state: QuotaState): void {
  try { localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(state)); } catch { /* best-effort */ }
}

/** Count one free-model request (call BEFORE sending; failures count against the provider's day too). */
export function noteFreeRequest(now = Date.now()): void {
  const state = loadQuota();
  state.countedToday += 1;
  state.recent = [...state.recent.filter((at) => now - at < 60_000), now];
  saveQuota(state);
}

/** Milliseconds until the next free-model request may go out under the RPM ceiling (0 = now). */
export function nextFreeSlotMs(now = Date.now()): number {
  const state = loadQuota();
  const recent = state.recent.filter((at) => now - at < 60_000);
  if (recent.length < PACE_THRESHOLD) return 0;
  const oldest = Math.min(...recent);
  return Math.max(0, oldest + 60_000 - now + 250);
}

/** Wait (abortably) until the RPM pacing window has a slot. Waits in
 * short slices and calls onWait between them, so callers can keep
 * their own liveness signals (stall watchdogs) honest while pacing. */
export async function paceFreeRequest(signal?: AbortSignal, onWait?: () => void): Promise<void> {
  let waitMs = nextFreeSlotMs();
  while (waitMs > 0) {
    const slice = Math.min(waitMs, 5000);
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const onAbort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = window.setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, slice);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    onWait?.();
    waitMs = nextFreeSlotMs();
  }
}

function pickNumber(source: Record<string, unknown> | null | undefined, names: string[]): number | null {
  if (!source) return null;
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Defensive parse of the GET /api/v1/key payload — field shapes vary across doc versions. */
export function parseKeyInfo(payload: unknown): QuotaCalibration {
  const data = (payload as { data?: Record<string, unknown> })?.data || {};
  const freeDaily = (data.free_model_daily_requests && typeof data.free_model_daily_requests === 'object')
    ? data.free_model_daily_requests as Record<string, unknown>
    : null;
  let dailyLimit = pickNumber(freeDaily, ['limit', 'ceiling', 'max', 'total']);
  let dailyUsed = pickNumber(freeDaily, ['used', 'count', 'requests', 'usage', 'value']);
  let dailyRemaining = pickNumber(freeDaily, ['remaining', 'remaining_requests']);
  if (typeof data.free_model_daily_requests === 'number') dailyRemaining = data.free_model_daily_requests;
  if (dailyLimit !== null && dailyUsed !== null && dailyRemaining === null) dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  if (dailyRemaining !== null && dailyLimit !== null && dailyUsed === null) dailyUsed = Math.max(0, dailyLimit - dailyRemaining);
  return {
    checkedAt: Date.now(),
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    dailyLimit,
    dailyUsed,
    dailyRemaining,
    limitRemaining: pickNumber(data, ['limit_remaining']),
  };
}

/** Calibrate the ledger against the provider. Best-effort: returns the calibration or null. */
export async function refreshQuota(apiKey: string): Promise<QuotaCalibration | null> {
  if (!apiKey) return null;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return null;
    const calibration = parseKeyInfo(await response.json());
    const state = loadQuota();
    state.calibration = calibration;
    saveQuota(state);
    return calibration;
  } catch {
    return null;
  }
}

export interface QuotaSnapshot {
  capPerDay: number;
  usedToday: number;
  remainingToday: number;
  tierLabel: string;
  calibratedAt: number | null;
  creditRemaining: number | null;
}

export function quotaSnapshot(): QuotaSnapshot {
  const state = loadQuota();
  const calibration = state.calibration;
  const calibratedToday = calibration && utcDay(calibration.checkedAt) === state.day;
  const capPerDay = calibration?.dailyLimit
    ?? (calibration?.isFreeTier === false ? UNLOCKED_DAILY_CAP : DEFAULT_DAILY_CAP);
  // Provider counter (when calibrated today) is ground truth; the
  // local count covers requests made since calibration.
  const usedToday = calibratedToday && calibration?.dailyUsed !== null && calibration.dailyUsed !== undefined
    ? Math.max(calibration.dailyUsed, state.countedToday)
    : state.countedToday;
  return {
    capPerDay,
    usedToday,
    remainingToday: Math.max(0, capPerDay - usedToday),
    tierLabel: calibration?.dailyLimit
      ? `${capPerDay.toLocaleString()}/day tier (provider-reported)`
      : calibration?.isFreeTier === false
        ? '1,000/day tier (unlocked)'
        : calibration?.isFreeTier === true
          ? '50/day tier'
          : 'tier not yet checked',
    calibratedAt: calibration?.checkedAt ?? null,
    creditRemaining: calibration?.limitRemaining ?? null,
  };
}

export function isFreeModelId(model: string): boolean {
  return model === 'openrouter/free' || model.endsWith(':free');
}

/**
 * Quota calibration for the agent plane (Context Density, Phase 2).
 *
 * OpenRouter's free-model budget is per account: 20 requests/minute
 * and a daily ceiling (50/day, or 1,000/day after $10+ lifetime
 * credits) — failed attempts count too. GET /api/v1/key reports the
 * provider's own daily free-request counter and ceiling
 * (free_model_daily_requests), the tier flag, and credit headroom.
 * Calibrating each key at mission start tells the operator exactly
 * which tier every key is on and lets the caller start on the key
 * with the most budget left.
 */

function pickNumber(source, names) {
  if (!source || typeof source !== 'object') return null;
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Defensive parse of the GET /api/v1/key payload (shapes vary across doc versions). */
export function parseKeyInfo(payload) {
  const data = payload?.data || {};
  const freeDaily = data.free_model_daily_requests && typeof data.free_model_daily_requests === 'object'
    ? data.free_model_daily_requests
    : null;
  let dailyLimit = pickNumber(freeDaily, ['limit', 'ceiling', 'max', 'total']);
  let dailyUsed = pickNumber(freeDaily, ['used', 'count', 'requests', 'usage', 'value']);
  let dailyRemaining = pickNumber(freeDaily, ['remaining', 'remaining_requests']);
  if (typeof data.free_model_daily_requests === 'number') dailyRemaining = data.free_model_daily_requests;
  if (dailyLimit !== null && dailyUsed !== null && dailyRemaining === null) dailyRemaining = Math.max(0, dailyLimit - dailyUsed);
  if (dailyRemaining !== null && dailyLimit !== null && dailyUsed === null) dailyUsed = Math.max(0, dailyLimit - dailyRemaining);
  return {
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    dailyLimit,
    dailyUsed,
    dailyRemaining,
    limitRemaining: pickNumber(data, ['limit_remaining']),
    label: typeof data.label === 'string' ? data.label : null,
  };
}

export async function fetchKeyInfo(baseUrl, apiKey, { timeoutMs = 6000 } = {}) {
  if (!apiKey) return null;
  try {
    const response = await fetch(`${baseUrl}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return parseKeyInfo(await response.json());
  } catch {
    return null; // calibration is best-effort; a mission never fails over it
  }
}

export async function calibrateKeys(baseUrl, apiKeys) {
  return Promise.all((apiKeys || []).filter(Boolean).map((key) => fetchKeyInfo(baseUrl, key)));
}

/** Index of the key with the most daily free budget left (unknown ranks below known-positive). */
export function pickStartKeyIndex(keyInfos) {
  let best = 0;
  let bestScore = -Infinity;
  (keyInfos || []).forEach((info, index) => {
    const score = info?.dailyRemaining ?? (info ? 0 : -1);
    if (score > bestScore) { bestScore = score; best = index; }
  });
  return best;
}

/** One human line per key for mission logs — the tier diagnostic. */
export function describeKeyInfo(info, index) {
  if (!info) return `Key ${index + 1}: budget check unavailable (continuing without calibration).`;
  const tier = info.dailyLimit ? `${info.dailyLimit.toLocaleString()}/day tier` : info.isFreeTier === false ? 'unlocked tier (1,000/day)' : info.isFreeTier === true ? '50/day tier' : 'tier unknown';
  const budget = info.dailyRemaining !== null ? `${info.dailyRemaining} free request(s) left today` : 'daily free budget not reported';
  const credit = info.limitRemaining !== null ? ` · $${Number(info.limitRemaining).toFixed(2)} credit headroom` : '';
  return `Key ${index + 1}: ${budget} (${tier})${credit}.`;
}

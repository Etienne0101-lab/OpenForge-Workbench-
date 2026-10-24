package com.openforge.workbench.data

/**
 * Priority-model router, ported from the web workbench's model-router.
 *
 * Rules, in order:
 *  1. An excluded model (Gemma, Lyria) is never a candidate, even if pinned.
 *  2. The user's selected model goes first when it is allowed and healthy.
 *  3. Otherwise the priority pool, in order, skipping models in cooldown.
 *  4. A 429 puts that model in an escalating cooldown (45s, then up to 300s);
 *     a mission never concludes on a rate limit — the caller rotates.
 */
class Router {
    private val stats = mutableMapOf<String, CallStat>()
    private val cooldownSteps = longArrayOf(45_000L, 120_000L, 300_000L)

    fun stat(model: String): CallStat = stats.getOrPut(model) { CallStat(model) }

    fun allStats(): List<CallStat> = ModelPool.allowed().map { stat(it) }

    fun orderedCandidates(selected: String, nowMs: Long = System.currentTimeMillis()): List<String> {
        val pool = ModelPool.allowed().toMutableList()
        val ordered = mutableListOf<String>()
        if (!ModelPool.isExcluded(selected) && pool.contains(selected)) {
            ordered.add(selected)
            pool.remove(selected)
        }
        ordered.addAll(pool)
        return ordered.filter { stat(it).cooldownUntilMs <= nowMs }
    }

    fun pick(selected: String): String? = orderedCandidates(selected).firstOrNull()

    fun recordSuccess(model: String) {
        val s = stat(model)
        s.ok += 1
        s.cooldownUntilMs = 0L
    }

    fun recordRateLimit(model: String) {
        val s = stat(model)
        s.rateLimited += 1
        val step = (s.rateLimited - 1).coerceIn(0, cooldownSteps.lastIndex)
        s.cooldownUntilMs = System.currentTimeMillis() + cooldownSteps[step]
    }

    fun recordFailure(model: String) {
        stat(model).failed += 1
    }
}

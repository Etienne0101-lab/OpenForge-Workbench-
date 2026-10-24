package com.openforge.workbench.data

data class CustomProvider(val name: String, val baseUrl: String, val model: String, val key: String)

/**
 * Generic API-key vault gate, ported from the parent repo (2026-10-24):
 * any provider, any endpoint — but only OpenAI-shape ones.
 *
 * The gate: the base URL must be https, must have no query string or
 * fragment, and the app will only ever call <base>/chat/completions and
 * <base>/models on it. Anything else is rejected at save time, before a
 * key is stored. Keys themselves are encrypted by SettingsStore; this
 * file never sees a stored key value, only the URL being checked.
 */
object ProviderVault {
    const val NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
    const val OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

    fun check(baseUrl: String): String? {
        val url = baseUrl.trim()
        if (url.isBlank()) return "Enter a base URL."
        if (!url.startsWith("https://")) return "Rejected: base URL must be https."
        if (url.contains("?") || url.contains("#")) return "Rejected: base URL must not contain a query or fragment."
        if (url.contains(" ")) return "Rejected: base URL must not contain spaces."
        return null
    }

    fun chatUrl(baseUrl: String): String = baseUrl.trim().trimEnd('/') + "/chat/completions"
    fun modelsUrl(baseUrl: String): String = baseUrl.trim().trimEnd('/') + "/models"
}

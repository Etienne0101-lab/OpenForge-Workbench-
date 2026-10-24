package com.openforge.workbench.data

import com.google.gson.JsonParser
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

sealed class ChatResult {
    data class Ok(
        val model: String,
        val content: String,
        val usage: String,
        val promptTokens: Int = 0,
        val completionTokens: Int = 0,
    ) : ChatResult()

    data class RateLimited(val model: String) : ChatResult()
    data class Error(val message: String) : ChatResult()
}

/**
 * OpenRouter (and companion-gateway) chat client.
 *
 * The key is sent only to https://openrouter.ai or to the user's own
 * gateway URL. When the gateway toggle is on, the request goes to
 * <gateway>/v1/chat/completions with the gateway token instead.
 * Non-streaming, with a 180s cap mirroring the web platform's callModel
 * timeout, so a hung call cannot stall a mission forever.
 */
class OpenRouterClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    fun chat(
        settings: SettingsStore,
        model: String,
        systemPrompt: String,
        messages: List<ChatMessage>,
    ): ChatResult {
        val gateway = settings.gatewayEnabled && settings.gatewayUrl.isNotBlank()
        val url = if (gateway) {
            settings.gatewayUrl.trimEnd('/') + "/v1/chat/completions"
        } else {
            "https://openrouter.ai/api/v1/chat/completions"
        }
        // v1.1.0 gateway namespaces: auto, local/<alias>,
        // openrouter/<model>, <upstream>/<model> — the gateway resolves
        // the id; the app must not substitute an OpenRouter id here.
        val effectiveModel = if (gateway && settings.gatewayModel.isNotBlank()) settings.gatewayModel else model
        val key = if (gateway) settings.gatewayToken else settings.openRouterKey
        if (key.isBlank() && !gateway) {
            return ChatResult.Error("No OpenRouter key saved. Add your own key on the Connect tab (BYOK — it stays on this device).")
        }
        return chatGeneric(url, key, effectiveModel, systemPrompt, messages, sendReferer = !gateway)
    }

    /**
     * v1.1.0 — one OpenAI-shape chat path for every provider: OpenRouter,
     * NVIDIA Build direct, the companion gateway, and vault providers.
     * The key goes only to the base URL passed in. NVIDIA and vault
     * providers get no OpenRouter referer headers.
     */
    fun chatGeneric(
        chatUrl: String,
        key: String,
        model: String,
        systemPrompt: String,
        messages: List<ChatMessage>,
        sendReferer: Boolean = false,
        maxTokens: Int? = null,
    ): ChatResult {
        if (key.isBlank()) return ChatResult.Error("No key saved for this provider. Add it on the Connect or Platform tab.")
        val bodyJson = buildJson(model, systemPrompt, messages, maxTokens)
        val builder = Request.Builder()
            .url(chatUrl)
            .addHeader("Authorization", "Bearer $key")
            .addHeader("Content-Type", "application/json")
        if (sendReferer) {
            builder.addHeader("HTTP-Referer", "https://etienne0101-lab.github.io/OpenForge-Workbench-/")
            builder.addHeader("X-Title", "OpenForge Workbench (Android)")
        }
        val request = builder.post(bodyJson.toRequestBody("application/json".toMediaType())).build()
        return try {
            http.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                when {
                    response.code == 429 -> ChatResult.RateLimited(model)
                    !response.isSuccessful -> ChatResult.Error("Model call failed (${response.code}): ${errorCodeOnly(text)}")
                    else -> parseResponse(model, text)
                }
            }
        } catch (e: Exception) {
            ChatResult.Error("Network error: ${e.message ?: "unknown"}")
        }
    }

    /** Error code/type only — never the provider message, which can echo key fragments (parent key-probe lesson). */
    private fun errorCodeOnly(text: String): String {
        return try {
            val root = JsonParser.parseString(text).asJsonObject
            val err = root.getAsJsonObject("error")
            val code = err?.get("code")?.asString ?: ""
            val type = err?.get("type")?.asString ?: ""
            listOf(code, type).filter { it.isNotBlank() }.joinToString(" / ").ifBlank { text.take(120) }
        } catch (e: Exception) {
            text.take(120)
        }
    }

    /** GET <base>/models — the catalog a provider actually serves. */
    fun fetchModels(baseUrl: String, key: String): Result<List<String>> {
        if (key.isBlank()) return Result.failure(Exception("No key saved for this provider."))
        return try {
            val request = Request.Builder()
                .url(ProviderVault.modelsUrl(baseUrl))
                .addHeader("Authorization", "Bearer $key")
                .build()
            http.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    Result.failure(Exception("Models list failed (${response.code}): ${errorCodeOnly(text)}"))
                } else {
                    val data = JsonParser.parseString(text).asJsonObject.getAsJsonArray("data")
                    val ids = mutableListOf<String>()
                    data?.forEach { item -> item.asJsonObject.get("id")?.asString?.let { ids.add(it) } }
                    Result.success(ids)
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Key probe, ported from the parent key-probe workflow: a models list
     * alone is not proof a key can call. For NVIDIA the probe also runs a
     * real tiny chat completion (max_tokens = 1) on a listed Nemotron
     * model, exactly as the parent's NVIDIA Build leg does.
     */
    fun probe(baseUrl: String, key: String, tinyChatModel: String? = null): String {
        val models = fetchModels(baseUrl, key)
        val list = models.getOrNull()
            ?: return "Probe FAILED: ${models.exceptionOrNull()?.message ?: "unknown"}"
        if (tinyChatModel == null) {
            return "Probe OK: ${list.size} models listed. (List-only: not proof a call works — run the tiny-chat probe for NVIDIA.)"
        }
        val tiny = chatGeneric(
            ProviderVault.chatUrl(baseUrl), key, tinyChatModel, "You are a probe.",
            listOf(ChatMessage("user", "Hi")), maxTokens = 1,
        )
        return when (tiny) {
            is ChatResult.Ok -> "Probe OK: ${list.size} models listed, tiny chat on $tinyChatModel succeeded."
            is ChatResult.RateLimited -> "Probe PARTIAL: ${list.size} models listed, but the tiny chat was rate-limited."
            is ChatResult.Error -> "Probe PARTIAL: ${list.size} models listed, tiny chat failed: ${tiny.message}"
        }
    }

    /** OpenRouter /key verdict: tier/limit/usage, never the key itself. */
    fun probeOpenRouterKey(key: String): String {
        if (key.isBlank()) return "No OpenRouter key saved."
        return try {
            val request = Request.Builder()
                .url("https://openrouter.ai/api/v1/key")
                .addHeader("Authorization", "Bearer $key")
                .build()
            http.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    "OpenRouter key probe FAILED (${response.code}): ${errorCodeOnly(text)}"
                } else {
                    val data = JsonParser.parseString(text).asJsonObject.getAsJsonObject("data")
                    val label = data?.get("label")?.asString ?: ""
                    val usage = data?.get("usage")?.asDouble
                    val limit = data?.get("limit")
                    val free = data?.get("is_free_tier")?.asBoolean
                    "OpenRouter key OK${if (label.isNotBlank()) " ($label)" else ""}: usage=$usage, limit=${limit ?: "none"}, free tier=$free."
                }
            }
        } catch (e: Exception) {
            "OpenRouter key probe failed: ${e.message}"
        }
    }

    /** Fetch a repo file (organism.json / schedule.json) via the GitHub contents API, tokenless when no token is saved. */
    fun fetchRepoFile(repo: String, path: String, branch: String, token: String): String {
        val url = "https://api.github.com/repos/$repo/contents/$path?ref=$branch"
        return try {
            val builder = Request.Builder().url(url).addHeader("Accept", "application/vnd.github+json")
            if (token.isNotBlank()) builder.addHeader("Authorization", "Bearer $token")
            http.newCall(builder.build()).execute().use { response ->
                val text = response.body?.string() ?: ""
                if (!response.isSuccessful) return "Fetch failed (${response.code}): ${errorCodeOnly(text)}"
                val encoded = JsonParser.parseString(text).asJsonObject.get("content")?.asString ?: ""
                val cleaned = encoded.replace("\n", "")
                String(android.util.Base64.decode(cleaned, android.util.Base64.DEFAULT), Charsets.UTF_8)
            }
        } catch (e: Exception) {
            "Fetch failed: ${e.message}"
        }
    }

    private fun parseResponse(model: String, text: String): ChatResult {
        return try {
            val root = JsonParser.parseString(text).asJsonObject
            val choice = root.getAsJsonArray("choices")?.get(0)?.asJsonObject
            val content = choice?.getAsJsonObject("message")?.get("content")?.asString ?: ""
            val usageObj = root.getAsJsonObject("usage")
            val usage = usageObj?.toString() ?: ""
            val promptTokens = usageObj?.get("prompt_tokens")?.asInt ?: 0
            val completionTokens = usageObj?.get("completion_tokens")?.asInt ?: 0
            if (content.isBlank()) {
                ChatResult.Error("The model returned an empty reply. Try again or pick another model.")
            } else {
                ChatResult.Ok(model, content, usage, promptTokens, completionTokens)
            }
        } catch (e: Exception) {
            ChatResult.Error("Could not read the model reply: ${e.message}")
        }
    }

    private fun esc(value: String): String = value
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")

    private fun buildJson(model: String, systemPrompt: String, messages: List<ChatMessage>, maxTokens: Int? = null): String {
        val sb = StringBuilder()
        sb.append("{\"model\":\"").append(esc(model)).append("\"")
        if (maxTokens != null) sb.append(",\"max_tokens\":").append(maxTokens)
        sb.append(",\"messages\":[")
        sb.append("{\"role\":\"system\",\"content\":\"").append(esc(systemPrompt)).append("\"}")
        for (m in messages) {
            sb.append(",{\"role\":\"").append(esc(m.role)).append("\",\"content\":\"").append(esc(m.content)).append("\"}")
        }
        sb.append("]}")
        return sb.toString()
    }
}

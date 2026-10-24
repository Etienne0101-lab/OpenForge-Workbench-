package com.openforge.workbench.data

import com.google.gson.JsonParser
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

sealed class ChatResult {
    data class Ok(val model: String, val content: String, val usage: String) : ChatResult()
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
        val key = if (gateway) settings.gatewayToken else settings.openRouterKey
        if (key.isBlank() && !gateway) {
            return ChatResult.Error("No OpenRouter key saved. Add your own key on the Connect tab (BYOK — it stays on this device).")
        }
        val bodyJson = buildJson(model, systemPrompt, messages)
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $key")
            .addHeader("Content-Type", "application/json")
            .addHeader("HTTP-Referer", "https://etienne0101-lab.github.io/OpenForge-Workbench-/")
            .addHeader("X-Title", "OpenForge Workbench (Android)")
            .post(bodyJson.toRequestBody("application/json".toMediaType()))
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""
                when {
                    response.code == 429 -> ChatResult.RateLimited(model)
                    !response.isSuccessful -> ChatResult.Error("Model call failed (${response.code}): ${text.take(300)}")
                    else -> parseResponse(model, text)
                }
            }
        } catch (e: Exception) {
            ChatResult.Error("Network error: ${e.message ?: "unknown"}")
        }
    }

    private fun parseResponse(model: String, text: String): ChatResult {
        return try {
            val root = JsonParser.parseString(text).asJsonObject
            val choice = root.getAsJsonArray("choices")?.get(0)?.asJsonObject
            val content = choice?.getAsJsonObject("message")?.get("content")?.asString ?: ""
            val usage = root.getAsJsonObject("usage")?.toString() ?: ""
            if (content.isBlank()) {
                ChatResult.Error("The model returned an empty reply. Try again or pick another model.")
            } else {
                ChatResult.Ok(model, content, usage)
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

    private fun buildJson(model: String, systemPrompt: String, messages: List<ChatMessage>): String {
        val sb = StringBuilder()
        sb.append("{\"model\":\"").append(esc(model)).append("\",\"messages\":[")
        sb.append("{\"role\":\"system\",\"content\":\"").append(esc(systemPrompt)).append("\"}")
        for (m in messages) {
            sb.append(",{\"role\":\"").append(esc(m.role)).append("\",\"content\":\"").append(esc(m.content)).append("\"}")
        }
        sb.append("]}")
        return sb.toString()
    }
}

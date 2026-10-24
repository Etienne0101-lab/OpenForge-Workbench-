package com.openforge.workbench.data

import android.util.Base64
import com.google.gson.JsonParser
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Minimal GitHub sync, ported from the web workbench's token GitHub sync:
 * push one project file to a repo/branch with the user's own token
 * (stored encrypted in SettingsStore). The token goes only to
 * api.github.com. No workflow files are written from here — the GitHub App
 * restriction that forces manual .github/workflows/ adds on the web side
 * applies to the app's token too, and this client never touches that path.
 */
class GitHubClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    fun pushFile(
        token: String,
        repo: String,
        branch: String,
        path: String,
        content: String,
        message: String,
    ): String {
        if (token.isBlank()) return "No GitHub token saved. Add one on the Connect tab first."
        val cleanPath = path.trimStart('/')
        val url = "https://api.github.com/repos/$repo/contents/$cleanPath"
        // Fetch the existing blob sha when updating, so the push does not 409.
        var sha: String? = null
        try {
            val get = Request.Builder()
                .url("$url?ref=$branch")
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept", "application/vnd.github+json")
                .addHeader("X-GitHub-Api-Version", "2022-11-28")
                .build()
            http.newCall(get).execute().use { response ->
                if (response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    sha = JsonParser.parseString(body).asJsonObject.get("sha")?.asString
                }
            }
        } catch (e: Exception) {
            // A missing file simply has no sha; the PUT below creates it.
        }
        val encoded = Base64.encodeToString(content.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        val json = buildString {
            append("{\"message\":\"").append(message.replace("\"", "\\\"")).append("\",")
            append("\"content\":\"").append(encoded).append("\",")
            append("\"branch\":\"").append(branch).append("\"")
            if (sha != null) append(",\"sha\":\"").append(sha).append("\"")
            append("}")
        }
        return try {
            val put = Request.Builder()
                .url(url)
                .addHeader("Authorization", "Bearer $token")
                .addHeader("Accept", "application/vnd.github+json")
                .addHeader("X-GitHub-Api-Version", "2022-11-28")
                .put(json.toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(put).execute().use { response ->
                val body = response.body?.string() ?: ""
                if (response.isSuccessful) "Pushed $cleanPath to $repo ($branch)." else "GitHub push failed (${response.code}): ${body.take(300)}"
            }
        } catch (e: Exception) {
            "GitHub push failed: ${e.message}"
        }
    }
}

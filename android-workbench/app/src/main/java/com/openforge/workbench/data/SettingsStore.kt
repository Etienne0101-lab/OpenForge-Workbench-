package com.openforge.workbench.data

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Settings where secrets never sit in plaintext on disk.
 *
 * The OpenRouter key, GitHub token and gateway token are encrypted with an
 * AES/GCM key held in the Android KeyStore and stored as ciphertext in
 * SharedPreferences. This is the native equivalent of the web workbench's
 * localStorage-only BYOK rule: keys are sent only to the service they belong
 * to (api.openrouter.ai, api.github.com, or the user's own gateway), never to
 * any other host, and never written to a log or an exported file.
 */
class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("openforge_settings", Context.MODE_PRIVATE)

    // Plain (non-secret) settings.
    var modelId: String
        get() = prefs.getString("model_id", ModelPool.DEFAULT_MODEL) ?: ModelPool.DEFAULT_MODEL
        set(value) = prefs.edit().putString("model_id", value).apply()
    var modeId: String
        get() = prefs.getString("mode_id", "general") ?: "general"
        set(value) = prefs.edit().putString("mode_id", value).apply()
    var projectName: String
        get() = prefs.getString("project_name", "my-project") ?: "my-project"
        set(value) = prefs.edit().putString("project_name", value).apply()
    var gatewayEnabled: Boolean
        get() = prefs.getBoolean("gateway_enabled", false)
        set(value) = prefs.edit().putBoolean("gateway_enabled", value).apply()
    var gatewayUrl: String
        get() = prefs.getString("gateway_url", "") ?: ""
        set(value) = prefs.edit().putString("gateway_url", value).apply()
    var workspaceFolderUri: String
        get() = prefs.getString("workspace_folder_uri", "") ?: ""
        set(value) = prefs.edit().putString("workspace_folder_uri", value).apply()
    var driveFolderUri: String
        get() = prefs.getString("drive_folder_uri", "") ?: ""
        set(value) = prefs.edit().putString("drive_folder_uri", value).apply()
    var githubRepo: String
        get() = prefs.getString("github_repo", "Etienne0101-lab/OpenForge-Workbench-") ?: ""
        set(value) = prefs.edit().putString("github_repo", value).apply()

    // Secrets, encrypted at rest.
    var openRouterKey: String
        get() = decrypt(prefs.getString("openrouter_key_enc", null))
        set(value) = prefs.edit().putString("openrouter_key_enc", encrypt(value)).apply()
    var githubToken: String
        get() = decrypt(prefs.getString("github_token_enc", null))
        set(value) = prefs.edit().putString("github_token_enc", encrypt(value)).apply()
    var gatewayToken: String
        get() = decrypt(prefs.getString("gateway_token_enc", null))
        set(value) = prefs.edit().putString("gateway_token_enc", encrypt(value)).apply()

    fun hasOpenRouterKey(): Boolean = openRouterKey.isNotBlank() || gatewayEnabled

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore")
        ks.load(null)
        val alias = "openforge_workbench_key"
        if (ks.containsAlias(alias)) {
            return ks.getKey(alias, null) as SecretKey
        }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(plain: String): String? {
        if (plain.isEmpty()) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val iv = cipher.iv
            val out = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            val combined = ByteArray(iv.size + out.size)
            System.arraycopy(iv, 0, combined, 0, iv.size)
            System.arraycopy(out, 0, combined, iv.size, out.size)
            Base64.encodeToString(combined, Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }

    private fun decrypt(encoded: String?): String {
        if (encoded.isNullOrEmpty()) return ""
        return try {
            val combined = Base64.decode(encoded, Base64.NO_WRAP)
            val iv = combined.copyOfRange(0, 12)
            val cipherText = combined.copyOfRange(12, combined.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(cipherText), Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
    }
}

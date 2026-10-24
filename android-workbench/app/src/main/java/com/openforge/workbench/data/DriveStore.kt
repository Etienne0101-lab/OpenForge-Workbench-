package com.openforge.workbench.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract

/**
 * Connected-folder access through the Storage Access Framework (SAF).
 *
 * This is how the app reaches Google Drive without an OAuth client id:
 * Drive is a DocumentsProvider, so when the user picks a Drive folder on the
 * Connect tab, Android grants this app a persisted URI permission for
 * exactly that folder. Reading and writing then go through the SAF
 * DocumentsContract API — no Drive API key, no background sync, and the
 * grant can be revoked any time in system Settings. The same picker also
 * covers device folders and other providers (Downloads, SD card, etc.).
 */
object DriveStore {

    fun takePersistablePermission(context: Context, treeUri: Uri) {
        try {
            context.contentResolver.takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            // Permission already held, or the provider declined it; the
            // persisted URI list below still records the user's choice.
        }
    }

    fun listChildren(context: Context, treeUri: Uri): List<String> {
        val out = mutableListOf<String>()
        try {
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, DocumentsContract.getTreeDocumentId(treeUri),
            )
            context.contentResolver.query(
                childrenUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null,
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    out.add(cursor.getString(0) ?: "(unnamed)")
                }
            }
        } catch (e: Exception) {
            out.add("Could not list this folder: ${e.message}")
        }
        return out
    }

    /** Write [content] as [fileName] into the granted folder. Returns true on success. */
    fun writeFile(context: Context, treeUri: Uri, fileName: String, content: String, mimeType: String = "text/plain"): Boolean {
        return try {
            val docUri = DocumentsContract.createDocument(
                context.contentResolver,
                DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri)),
                mimeType, fileName,
            ) ?: return false
            context.contentResolver.openOutputStream(docUri)?.use { stream ->
                stream.write(content.toByteArray(Charsets.UTF_8))
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    fun hasPersistedPermission(context: Context, treeUri: Uri): Boolean {
        return context.contentResolver.persistedUriPermissions.any {
            it.uri == treeUri && it.isReadPermission && it.isWritePermission
        }
    }
}

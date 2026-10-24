package com.openforge.workbench.data

import android.content.Context
import java.io.File

/**
 * On-device project workspace: <app files>/projects/<projectName>/.
 *
 * The web workbench's repo-map idea is ported as [repoMap]: a compact file
 * list with sizes and a ~tokens estimate (chars / 4), scaled so a mission
 * prompt stays inside the model's window. Nothing here leaves the device
 * except when the user explicitly pushes a file to GitHub or exports it.
 */
class Workspace(private val context: Context, private val settings: SettingsStore) {

    fun projectDir(): File {
        val safeName = settings.projectName.ifBlank { "my-project" }
            .replace(Regex("[^A-Za-z0-9._-]"), "-")
        return File(context.filesDir, "projects/$safeName").apply { mkdirs() }
    }

    fun listFiles(): List<ProjectFile> {
        val root = projectDir()
        val out = mutableListOf<ProjectFile>()
        root.walkTopDown().forEach { file ->
            if (file == root) return@forEach
            out.add(ProjectFile(file.relativeTo(root).path, if (file.isFile) file.length() else 0L, file.isDirectory))
        }
        return out.sortedBy { it.path }
    }

    fun readFile(relativePath: String): String {
        val file = resolve(relativePath) ?: return ""
        return if (file.isFile) file.readText() else ""
    }

    fun writeFile(relativePath: String, content: String): Boolean {
        val file = resolve(relativePath) ?: return false
        return try {
            file.parentFile?.mkdirs()
            file.writeText(content)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun deleteFile(relativePath: String): Boolean {
        val file = resolve(relativePath) ?: return false
        return try {
            if (file.isDirectory) file.deleteRecursively() else file.delete()
        } catch (e: Exception) {
            false
        }
    }

    fun applyScaffold(scaffold: Scaffold): Int {
        var count = 0
        for ((path, content) in scaffold.files) {
            if (writeFile(path, content)) count++
        }
        return count
    }

    fun repoMap(maxChars: Int = 6000): String {
        val files = listFiles().filter { !it.isDir }
        val sb = StringBuilder()
        var total = 0L
        for (f in files) {
            total += f.size
            sb.append(f.path).append(" (").append(f.size).append(" bytes)\n")
        }
        sb.append("Total: ").append(files.size).append(" files, ").append(total)
            .append(" bytes, ~").append(total / 4).append(" tokens\n")
        val text = sb.toString()
        return if (text.length > maxChars) text.substring(0, maxChars) else text
    }

    /** Reject paths that would escape the project directory. */
    private fun resolve(relativePath: String): File? {
        val clean = relativePath.trim().trimStart('/')
        if (clean.isEmpty() || clean.contains("..")) return null
        return File(projectDir(), clean)
    }
}

/** Parse ```openforge:file <path> ... ``` blocks out of a model reply. */
object ChangeSetParser {
    fun parse(reply: String): Pair<List<ChangeProposal>, String> {
        val proposals = mutableListOf<ChangeProposal>()
        val regex = Regex("```openforge:file\\s+([^\\n`]+)\\n([\\s\\S]*?)```")
        for (match in regex.findAll(reply)) {
            val path = match.groupValues[1].trim()
            val content = match.groupValues[2]
            if (path.isNotEmpty() && !path.contains("..")) {
                proposals.add(ChangeProposal(path, content))
            }
        }
        // The readable part of the reply, without the file blocks.
        val prose = regex.replace(reply, "").trim()
        return proposals to prose
    }
}

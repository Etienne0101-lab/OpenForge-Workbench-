package com.openforge.workbench.data

/**
 * Platform model pool, ported from the web workbench's router policy.
 *
 * Standing directive, not a preference: Gemma models are hard-excluded
 * everywhere in this app. The exclusion list is checked in Router.pickModel
 * as well as here, so a pool edit can never silently re-admit one.
 */
object ModelPool {
    const val DEFAULT_MODEL = "minimax/minimax-m3.1-flash:free"
    const val SECOND_MODEL = "nvidia/nemotron-3.5-lightning:free"

    val PRIORITY = listOf(
        "minimax/minimax-m3.1-flash:free",
        "nvidia/nemotron-3.5-lightning:free",
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "thinking-machines/inspiring-inkling:free",
        "nvidia/nemotron-3-super:free",
        "poolside/laguna-s:free",
        "recursive/flint:free",
        "thinking-machines/inspiring-inkling-small:free",
        "poolside/laguna-xs:free",
        "xingchen/xing4.0:free",
        "cohere/north-mini-code:free",
        "nvidia/nemotron-3-super-vl:free",
        "openrouter/free",
    )

    // Never candidates, even if a catalog or a gateway lists them.
    val EXCLUDED_SUBSTRINGS = listOf("gemma", "lyria")

    fun isExcluded(modelId: String): Boolean {
        val lower = modelId.lowercase()
        return EXCLUDED_SUBSTRINGS.any { lower.contains(it) }
    }

    fun allowed(): List<String> = PRIORITY.filterNot { isExcluded(it) }
}

/** The nine expert modes from the web workbench, including Android Architect. */
data class ExpertMode(val id: String, val name: String, val systemPrompt: String)

object ExpertModes {
    val ALL = listOf(
        ExpertMode(
            "general", "General Builder",
            "You are OpenForge, a browser-class AI coding assistant. Build complete, working software. Prefer small, verifiable steps and explain what changed.",
        ),
        ExpertMode(
            "web", "Web App",
            "You build complete web apps: semantic HTML, modern CSS, vanilla JS or a small framework, accessible and responsive. Ship a runnable index.html first.",
        ),
        ExpertMode(
            "android", "Android Architect",
            "You are the Android Architect. Target Kotlin 2.0.20, Compose BOM 2024.06, Material 3, AGP 8.5.2, Gradle 8.7, minSdk 24, targetSdk 34. " +
                "Never emit binary jars; the Gradle wrapper jar is absent by design and CI bootstraps it. Signing blocks are untouchable and env-guarded. " +
                "Use scoped storage and the Storage Access Framework for user files; never request all-files access silently.",
        ),
        ExpertMode(
            "api", "API & Backend",
            "You design HTTP APIs with explicit routes, request/response shapes, status codes and error handling. Prefer runnable server code with a health endpoint.",
        ),
        ExpertMode(
            "data", "Data & SQLite",
            "You design schemas, migrations and queries. SQL must be valid SQLite; show the schema, the query and what each result row means.",
        ),
        ExpertMode(
            "python", "Python",
            "You write dependency-light, runnable Python with a main entry point, clear functions and a small self-check the user can run.",
        ),
        ExpertMode(
            "node", "Node",
            "You write runnable Node.js with explicit entry points, no hidden build step, and a health or smoke check the user can run.",
        ),
        ExpertMode(
            "review", "Code Review",
            "You review code claim by claim: correctness, security, edge cases and tests. Never approve what you have not checked; name what is unverified.",
        ),
        ExpertMode(
            "docs", "Docs & Writing",
            "You write accurate documentation inside claim boundaries: state what is verified, what is planned, and what is still untested, in plain language.",
        ),
    )

    fun byId(id: String): ExpertMode = ALL.firstOrNull { it.id == id } ?: ALL[0]
}

data class ChatMessage(val role: String, val content: String)

data class ProjectFile(val path: String, val size: Long, val isDir: Boolean = false)

/**
 * Change-set protocol, ported from the web workbench.
 * The model proposes files; nothing is written until the user accepts.
 * Block format the model is instructed to use:
 *   ```openforge:file <relative/path>
 *   <file contents>
 *   ```
 */
data class ChangeProposal(
    val path: String,
    val content: String,
    var status: String = "pending", // pending | accepted | rejected
)

data class CallStat(
    val model: String,
    var ok: Int = 0,
    var failed: Int = 0,
    var rateLimited: Int = 0,
    var cooldownUntilMs: Long = 0L,
)

data class Scaffold(val id: String, val name: String, val files: Map<String, String>)

object Scaffolds {
    val ALL = listOf(
        Scaffold(
            "web-starter", "Web starter",
            mapOf(
                "index.html" to "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>OpenForge app</title></head><body><h1>Hello from OpenForge</h1><p>Edit this project in the Files tab, then preview it here.</p></body></html>\n",
                "README.md" to "# OpenForge web starter\n\nOpen index.html in the Preview tab.\n",
            ),
        ),
        Scaffold(
            "notes-app", "Notes app (web)",
            mapOf(
                "index.html" to "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Notes</title></head><body><h1>Notes</h1><textarea id=\"n\" rows=\"12\" cols=\"40\" placeholder=\"Write a note…\"></textarea><br><button onclick=\"localStorage.setItem('note', document.getElementById('n').value)\">Save on this device</button><script>document.getElementById('n').value = localStorage.getItem('note') || ''</script></body></html>\n",
            ),
        ),
        Scaffold(
            "api-starter", "API starter (Node)",
            mapOf(
                "server.js" to "const http = require('http');\nhttp.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, path: req.url })); }).listen(3000, () => console.log('http://localhost:3000/health'));\n",
                "README.md" to "# API starter\n\nRun: node server.js\n",
            ),
        ),
        Scaffold(
            "python-starter", "Python starter",
            mapOf(
                "main.py" to "def main():\n    print('Hello from OpenForge')\n\nif __name__ == '__main__':\n    main()\n",
            ),
        ),
        Scaffold(
            "android-starter", "Android starter (Kotlin)",
            mapOf(
                "README.md" to "# Android starter\n\nThis scaffold is a starting point for a Kotlin + Compose app. Generate the full Gradle project from the web workbench's Android template, or ask Android Architect mode to extend it.\n",
                "MainActivity.kt" to "// Kotlin + Compose starter sketch — see the web workbench Android template for the full project.\n",
            ),
        ),
        Scaffold(
            "sqlite-starter", "SQLite starter",
            mapOf(
                "schema.sql" to "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);\nINSERT INTO notes (title, body) VALUES ('Welcome', 'Run this schema in the Tools tab.');\n",
            ),
        ),
        Scaffold(
            "landing-page", "Landing page",
            mapOf(
                "index.html" to "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Landing</title><style>body{font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px}</style></head><body><h1>Your product, plainly explained</h1><p>Replace this copy with the real offer, the real price and the real next step.</p></body></html>\n",
            ),
        ),
    )
}

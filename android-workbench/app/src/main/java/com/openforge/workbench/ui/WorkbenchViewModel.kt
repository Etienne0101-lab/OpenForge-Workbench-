package com.openforge.workbench.ui

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.openforge.workbench.data.ChangeProposal
import com.openforge.workbench.data.ChangeSetParser
import com.openforge.workbench.data.ChatMessage
import com.openforge.workbench.data.ChatResult
import com.openforge.workbench.data.DriveStore
import com.openforge.workbench.data.ExpertModes
import com.openforge.workbench.data.GitHubClient
import com.openforge.workbench.data.ModelPool
import com.openforge.workbench.data.OpenRouterClient
import com.openforge.workbench.data.ProjectFile
import com.openforge.workbench.data.Router
import com.openforge.workbench.data.SettingsStore
import com.openforge.workbench.data.SqlWorkbench
import com.openforge.workbench.data.Workspace
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.TimeUnit

class WorkbenchViewModel(application: Application) : AndroidViewModel(application) {
    val settings = SettingsStore(application)
    private val workspace = Workspace(application, settings)
    private val router = Router()
    private val client = OpenRouterClient()
    private val github = GitHubClient()
    private val sql = SqlWorkbench(application)

    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var proposals by mutableStateOf<List<ChangeProposal>>(emptyList())
        private set
    var files by mutableStateOf<List<ProjectFile>>(emptyList())
        private set
    var status by mutableStateOf("Ready. Add your OpenRouter key on Connect, then run a mission.")
        private set
    var busy by mutableStateOf(false)
        private set
    var currentModel by mutableStateOf(settings.modelId)
        private set
    var currentMode by mutableStateOf(settings.modeId)
        private set
    var sqlResult by mutableStateOf("")
        private set
    var apiResult by mutableStateOf("")
        private set
    var githubResult by mutableStateOf("")
        private set
    var driveListing by mutableStateOf<List<String>>(emptyList())
        private set

    init {
        refreshFiles()
    }

    fun refreshFiles() {
        files = workspace.listFiles()
    }

    fun selectModel(model: String) {
        currentModel = model
        settings.modelId = model
    }

    fun selectMode(modeId: String) {
        currentMode = modeId
        settings.modeId = modeId
    }

    fun readFile(path: String): String = workspace.readFile(path)

    fun saveFile(path: String, content: String): Boolean {
        val ok = workspace.writeFile(path, content)
        if (ok) refreshFiles()
        return ok
    }

    fun deleteFile(path: String) {
        workspace.deleteFile(path)
        refreshFiles()
    }

    fun repoMap(): String = workspace.repoMap()

    fun modelStatsText(): String {
        val lines = router.allStats().joinToString("\n") { s ->
            val cooling = if (s.cooldownUntilMs > System.currentTimeMillis()) " (cooling down)" else ""
            "${s.model}: ${s.ok} ok, ${s.failed} failed, ${s.rateLimited} rate-limited$cooling"
        }
        return "Model health (this session):\n$lines\n\nExcluded everywhere: Gemma, Lyria."
    }

    /** Run one mission turn: send prompt + repo map, rotate models on 429. */
    fun runMission(goal: String) {
        if (goal.isBlank()) {
            status = "Type a mission goal first."
            return
        }
        if (busy) return
        busy = true
        status = "Running mission…"
        val mode = ExpertModes.byId(currentMode)
        val history = messages
        val prompt = buildString {
            append("Project: ").append(settings.projectName).append("\n")
            append("Repo map:\n").append(workspace.repoMap()).append("\n\n")
            append("Mission goal: ").append(goal).append("\n\n")
            append("Reply in prose, then propose any new or changed files as ```openforge:file <relative/path> blocks. ")
            append("Do not claim a step succeeded unless you did it; the app applies your proposals only after the user accepts them.")
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                var lastError = "No model was available."
                for (candidate in router.orderedCandidates(currentModel)) {
                    if (ModelPool.isExcluded(candidate)) continue
                    when (val r = client.chat(settings, candidate, mode.systemPrompt, history + ChatMessage("user", prompt))) {
                        is ChatResult.Ok -> {
                            router.recordSuccess(candidate)
                            return@withContext Triple(candidate, r.content, r.usage)
                        }
                        is ChatResult.RateLimited -> {
                            router.recordRateLimit(candidate)
                            lastError = "$candidate was rate-limited; rotating…"
                        }
                        is ChatResult.Error -> {
                            router.recordFailure(candidate)
                            lastError = r.message
                            // Auth/config errors will not be fixed by rotating; stop early.
                            if (r.message.contains("401") || r.message.contains("No OpenRouter key")) break
                        }
                    }
                }
                Triple("", "", lastError)
            }
            val (modelUsed, content, extra) = result
            if (modelUsed.isNotEmpty()) {
                val (parsedProposals, prose) = ChangeSetParser.parse(content)
                messages = messages + ChatMessage("user", goal) + ChatMessage("assistant", prose.ifBlank { content })
                proposals = parsedProposals
                status = if (parsedProposals.isEmpty()) {
                    "Done on $modelUsed. No file proposals in this reply."
                } else {
                    "Done on $modelUsed. ${parsedProposals.size} file proposal(s) awaiting your review below."
                }
            } else {
                messages = messages + ChatMessage("user", goal)
                status = "Mission failed: $extra"
            }
            busy = false
        }
    }

    fun acceptProposal(proposal: ChangeProposal) {
        if (workspace.writeFile(proposal.path, proposal.content)) {
            proposal.status = "accepted"
            proposals = proposals.toList()
            refreshFiles()
            status = "Accepted ${proposal.path}."
        } else {
            status = "Could not write ${proposal.path}."
        }
    }

    fun rejectProposal(proposal: ChangeProposal) {
        proposal.status = "rejected"
        proposals = proposals.toList()
    }

    fun applyScaffold(scaffoldId: String) {
        val scaffold = com.openforge.workbench.data.Scaffolds.ALL.firstOrNull { it.id == scaffoldId } ?: return
        val count = workspace.applyScaffold(scaffold)
        refreshFiles()
        status = "Scaffold '${scaffold.name}' created $count file(s) in ${settings.projectName}."
    }

    fun runSql(sqlText: String) {
        sqlResult = sql.run(sqlText)
    }

    fun runApi(method: String, url: String, body: String) {
        if (url.isBlank()) {
            apiResult = "Enter a URL first."
            return
        }
        viewModelScope.launch {
            apiResult = withContext(Dispatchers.IO) {
                try {
                    val http = OkHttpClient.Builder()
                        .connectTimeout(30, TimeUnit.SECONDS)
                        .readTimeout(60, TimeUnit.SECONDS)
                        .build()
                    val builder = Request.Builder().url(url)
                    val request = when (method.uppercase()) {
                        "POST", "PUT", "PATCH" -> builder.method(
                            method.uppercase(),
                            body.toRequestBody("application/json".toMediaType()),
                        ).build()
                        else -> builder.get().build()
                    }
                    http.newCall(request).execute().use { response ->
                        "HTTP ${response.code}\n${response.body?.string()?.take(4000) ?: ""}"
                    }
                } catch (e: Exception) {
                    "API call failed: ${e.message}"
                }
            }
        }
    }

    fun pushToGitHub(path: String, branch: String) {
        val content = workspace.readFile(path)
        if (content.isEmpty()) {
            githubResult = "Nothing to push: $path is empty or missing."
            return
        }
        viewModelScope.launch {
            githubResult = withContext(Dispatchers.IO) {
                github.pushFile(settings.githubToken, settings.githubRepo, branch, path, content, "OpenForge Android: update $path")
            }
        }
    }

    fun refreshDriveListing(context: Context) {
        val uriText = settings.driveFolderUri
        if (uriText.isBlank()) {
            driveListing = listOf("No folder connected yet. Pick a folder (Drive or device) on the Connect tab.")
            return
        }
        driveListing = DriveStore.listChildren(context, Uri.parse(uriText))
    }

    fun exportToConnectedFolder(context: Context, fileName: String, content: String) {
        val uriText = settings.driveFolderUri
        if (uriText.isBlank()) {
            status = "No connected folder yet. Pick one on the Connect tab first."
            return
        }
        val ok = DriveStore.writeFile(context, Uri.parse(uriText), fileName, content)
        status = if (ok) "Exported $fileName to the connected folder." else "Export failed — check the folder permission on the Connect tab."
    }
}

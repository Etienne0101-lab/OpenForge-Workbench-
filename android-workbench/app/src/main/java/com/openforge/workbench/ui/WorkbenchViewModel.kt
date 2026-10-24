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
import com.openforge.workbench.data.ProviderVault
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

    // v1.1.0 — lifted mission goal (so Organism can stage a proposal into
    // it), provider choice, quota, organism/scheduler, probes, swarm.
    var missionGoal by mutableStateOf("")
    var currentProvider by mutableStateOf(settings.defaultProvider)
        private set
    var organismText by mutableStateOf("")
        private set
    var scheduleText by mutableStateOf("")
        private set
    var probeText by mutableStateOf("")
        private set
    var swarmResults by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var platformStatus by mutableStateOf("")
        private set

    fun selectProvider(provider: String) {
        currentProvider = provider
        settings.defaultProvider = provider
    }

    fun quotaText(): String {
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        if (settings.quotaDate != today) return "Quota ledger (today): no calls yet."
        return "Quota ledger (today): ${settings.quotaPromptTokens} prompt tokens, ${settings.quotaCompletionTokens} completion tokens."
    }

    private fun recordUsage(promptTokens: Int, completionTokens: Int) {
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        if (settings.quotaDate != today) {
            settings.quotaDate = today
            settings.quotaPromptTokens = 0L
            settings.quotaCompletionTokens = 0L
        }
        settings.quotaPromptTokens += promptTokens
        settings.quotaCompletionTokens += completionTokens
    }

    /** Resolve the effective provider: NVIDIA only when its key is saved, else OpenRouter. */
    private fun effectiveProvider(): String {
        return if (currentProvider == "nvidia" && settings.nvidiaKey.isNotBlank()) "nvidia"
        else if (currentProvider.startsWith("custom:")) currentProvider
        else if (settings.gatewayEnabled && settings.gatewayUrl.isNotBlank() && currentProvider == "gateway") "gateway"
        else "openrouter"
    }

    fun fetchOrganism(branch: String = "main") {
        viewModelScope.launch {
            organismText = withContext(Dispatchers.IO) {
                client.fetchRepoFile(settings.githubRepo, ".openforge/organism.json", branch, settings.githubToken)
            }
        }
    }

    fun fetchSchedule(branch: String = "main") {
        viewModelScope.launch {
            scheduleText = withContext(Dispatchers.IO) {
                client.fetchRepoFile(settings.githubRepo, ".openforge/schedule.json", branch, settings.githubToken)
            }
        }
    }

    fun runProbe(kind: String) {
        viewModelScope.launch {
            probeText = withContext(Dispatchers.IO) {
                when (kind) {
                    "openrouter" -> client.probeOpenRouterKey(settings.openRouterKey)
                    "nvidia" -> {
                        val models = client.fetchModels(ProviderVault.NVIDIA_BASE_URL, settings.nvidiaKey).getOrNull()
                            ?: return@withContext "NVIDIA probe FAILED: ${client.fetchModels(ProviderVault.NVIDIA_BASE_URL, settings.nvidiaKey).exceptionOrNull()?.message ?: "unknown"}"
                        val nemotron = models.firstOrNull { it.contains("nemotron", ignoreCase = true) } ?: models.firstOrNull()
                        if (nemotron == null) "NVIDIA probe: key lists 0 models."
                        else client.probe(ProviderVault.NVIDIA_BASE_URL, settings.nvidiaKey, nemotron)
                    }
                    "gateway" -> {
                        if (!settings.gatewayEnabled || settings.gatewayUrl.isBlank()) "Gateway probe: gateway is off or has no URL."
                        else client.probe(settings.gatewayUrl.trimEnd('/') + "/v1", settings.gatewayToken)
                    }
                    else -> "Unknown probe."
                }
            }
        }
    }

    /** Swarm mission: the same goal on the top 3 priority models, results kept separate for the user to compare. */
    fun runSwarm(goal: String) {
        if (goal.isBlank() || busy) return
        busy = true
        platformStatus = "Running swarm…"
        val mode = ExpertModes.byId(currentMode)
        val prompt = "Mission goal: $goal\n\nReply in prose, then propose files as ```openforge:file <path> blocks."
        viewModelScope.launch {
            val results = withContext(Dispatchers.IO) {
                val out = mutableListOf<ChatMessage>()
                for (candidate in Router().orderedCandidates(currentModel).take(3)) {
                    if (ModelPool.isExcluded(candidate)) continue
                    when (val r = client.chat(settings, candidate, mode.systemPrompt, messages + ChatMessage("user", prompt))) {
                        is ChatResult.Ok -> {
                            recordUsage(r.promptTokens, r.completionTokens)
                            out.add(ChatMessage("assistant [$candidate]", r.content.take(2000)))
                        }
                        is ChatResult.RateLimited -> out.add(ChatMessage("assistant [$candidate]", "Rate-limited."))
                        is ChatResult.Error -> out.add(ChatMessage("assistant [$candidate]", r.message))
                    }
                }
                out
            }
            swarmResults = results
            platformStatus = "Swarm done: ${results.size} model replies. Compare them, then run the best one as a normal mission."
            busy = false
        }
    }

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
                // v1.1.0 provider routing: NVIDIA direct / vault providers
                // go through the generic OpenAI-shape path; OpenRouter keeps
                // its priority-pool rotation on 429.
                val provider = effectiveProvider()
                if (provider == "nvidia" || provider.startsWith("custom:")) {
                    val (baseUrl, key, configuredModel) = if (provider == "nvidia") {
                        Triple(ProviderVault.NVIDIA_BASE_URL, settings.nvidiaKey, settings.nvidiaModel)
                    } else {
                        val custom = settings.listCustomProviders().firstOrNull { "custom:${it.name}" == provider }
                            ?: return@withContext Triple("", "", "Custom provider not found. Re-save it on the Platform tab.")
                        Triple(custom.baseUrl, custom.key, custom.model)
                    }
                    val model = configuredModel.ifBlank {
                        val models = client.fetchModels(baseUrl, key).getOrNull()
                        models?.firstOrNull { it.contains("nemotron", ignoreCase = true) } ?: models?.firstOrNull() ?: ""
                    }
                    if (model.isBlank()) return@withContext Triple("", "", "No model available from $baseUrl. Run the key probe first.")
                    when (val r = client.chatGeneric(ProviderVault.chatUrl(baseUrl), key, model, mode.systemPrompt, history + ChatMessage("user", prompt))) {
                        is ChatResult.Ok -> {
                            recordUsage(r.promptTokens, r.completionTokens)
                            Triple("$provider/$model", r.content, r.usage)
                        }
                        is ChatResult.RateLimited -> Triple("", "", "$model was rate-limited.")
                        is ChatResult.Error -> Triple("", "", r.message)
                    }
                } else {
                    var lastError = "No model was available."
                    var outcome: Triple<String, String, String>? = null
                    for (candidate in router.orderedCandidates(currentModel)) {
                        if (ModelPool.isExcluded(candidate)) continue
                        when (val r = client.chat(settings, candidate, mode.systemPrompt, history + ChatMessage("user", prompt))) {
                            is ChatResult.Ok -> {
                                router.recordSuccess(candidate)
                                recordUsage(r.promptTokens, r.completionTokens)
                                outcome = Triple(candidate, r.content, r.usage)
                                break
                            }
                            is ChatResult.RateLimited -> {
                                router.recordRateLimit(candidate)
                                lastError = "$candidate was rate-limited; rotating…"
                            }
                            is ChatResult.Error -> {
                                router.recordFailure(candidate)
                                lastError = r.message
                                if (r.message.contains("401") || r.message.contains("No OpenRouter key")) break
                            }
                        }
                    }
                    outcome ?: Triple("", "", lastError)
                }
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

package com.openforge.workbench.ui

import android.webkit.WebView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openforge.workbench.data.ExpertModes
import com.openforge.workbench.data.ModelPool
import com.openforge.workbench.data.Scaffolds

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkbenchApp(viewModel: WorkbenchViewModel = viewModel()) {
    var tab by remember { mutableStateOf(0) }
    val tabs = listOf("Mission", "Files", "Preview", "Tools", "Connect", "Platform")
    // Galaxy S24: 6.2" 1080x2340, ~360dp wide in portrait, ~780dp in
    // landscape. Wide layouts only kick in at 600dp, so portrait stays
    // single-column (thumb-reachable) and landscape gets two panes.
    val isWide = LocalConfiguration.current.screenWidthDp >= 600

    Scaffold(
        topBar = { TopAppBar(title = { Text("OpenForge Workbench") }) },
        bottomBar = {
            NavigationBar {
                tabs.forEachIndexed { index, label ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        label = { Text(label) },
                        icon = { Text(label.take(1)) },
                    )
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (tab) {
                0 -> MissionScreen(viewModel, isWide)
                1 -> FilesScreen(viewModel, isWide)
                2 -> PreviewScreen(viewModel)
                3 -> ToolsScreen(viewModel)
                4 -> ConnectScreen(viewModel)
                5 -> PlatformScreen(viewModel, onGoToMission = { tab = 0 })
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MissionScreen(viewModel: WorkbenchViewModel, isWide: Boolean) {
    var modeExpanded by remember { mutableStateOf(false) }
    var modelExpanded by remember { mutableStateOf(false) }
    val mode = ExpertModes.byId(viewModel.currentMode)

    @Composable
    fun Composer() {
        Text("Mission", style = MaterialTheme.typography.titleLarge)
        Text(
            "Describe what to build. The model proposes files; nothing is written until you accept a proposal. " +
                "Provider: ${viewModel.currentProvider} (NVIDIA default in the parent repo wins only when an NVIDIA key is saved; otherwise OpenRouter MiniMax M3.1 Flash). " +
                "Gemma models are excluded from this app.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = viewModel.missionGoal,
            onValueChange = { viewModel.missionGoal = it },
            label = { Text("Mission goal") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                ExposedDropdownMenuBox(expanded = modeExpanded, onExpandedChange = { modeExpanded = !modeExpanded }) {
                    OutlinedTextField(
                        value = mode.name,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Expert mode") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modeExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth(),
                    )
                    ExposedDropdownMenu(expanded = modeExpanded, onDismissRequest = { modeExpanded = false }) {
                        ExpertModes.ALL.forEach { m ->
                            DropdownMenuItem(
                                text = { Text(m.name) },
                                onClick = { viewModel.selectMode(m.id); modeExpanded = false },
                            )
                        }
                    }
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                ExposedDropdownMenuBox(expanded = modelExpanded, onExpandedChange = { modelExpanded = !modelExpanded }) {
                    OutlinedTextField(
                        value = viewModel.currentModel.substringAfter("/").substringBefore(":"),
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Model") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = modelExpanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth(),
                    )
                    ExposedDropdownMenu(expanded = modelExpanded, onDismissRequest = { modelExpanded = false }) {
                        ModelPool.allowed().forEach { m ->
                            DropdownMenuItem(
                                text = { Text(m) },
                                onClick = { viewModel.selectModel(m); modelExpanded = false },
                            )
                        }
                    }
                }
            }
        }
        Button(
            onClick = { viewModel.runMission(viewModel.missionGoal) },
            enabled = !viewModel.busy,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (viewModel.busy) "Running…" else "Start mission") }
        if (viewModel.busy) CircularProgressIndicator()
        Text(viewModel.status, style = MaterialTheme.typography.bodyMedium)
        Text(viewModel.quotaText(), style = MaterialTheme.typography.bodySmall)
    }

    @Composable
    fun Results() {
        Text("Starter scaffolds", style = MaterialTheme.typography.titleMedium)
        Scaffolds.ALL.forEach { scaffold ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(scaffold.name, style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = { viewModel.applyScaffold(scaffold.id) }) { Text("Create") }
                }
            }
        }
        viewModel.proposals.forEach { proposal ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Proposal: ${proposal.path} [${proposal.status}]", style = MaterialTheme.typography.titleMedium)
                    Text(proposal.content.take(600), style = MaterialTheme.typography.bodySmall)
                    if (proposal.status == "pending") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { viewModel.acceptProposal(proposal) }) { Text("Accept") }
                            TextButton(onClick = { viewModel.rejectProposal(proposal) }) { Text("Reject") }
                        }
                    }
                }
            }
        }
        viewModel.messages.forEach { message ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(message.role, style = MaterialTheme.typography.labelMedium)
                    Text(message.content.take(1200), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }

    if (isWide) {
        // S24 landscape / wide: composer left, results right, each scrolling.
        Row(modifier = Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) { Composer() }
            Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) { Results() }
        }
    } else {
        // S24 portrait (~360dp): one thumb-reachable column, one scroll.
        Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Composer()
            Results()
        }
    }
}

@Composable
private fun FilesScreen(viewModel: WorkbenchViewModel, isWide: Boolean) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    var selectedPath by remember { mutableStateOf<String?>(null) }
    var editorText by remember { mutableStateOf("") }
    val context = LocalContext.current

    Text("Project: ${viewModel.settings.projectName}", style = MaterialTheme.typography.titleLarge)
    Text(
        "Files live in the app's private project folder. Use Connect to pick a device or Drive folder to export to.",
        style = MaterialTheme.typography.bodyMedium,
    )
    Text("Repo map", style = MaterialTheme.typography.titleMedium)
    Text(viewModel.repoMap(), style = MaterialTheme.typography.bodySmall)

    LazyColumn(modifier = Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(viewModel.files, key = { it.path }) { file ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(if (file.isDir) "${file.path}/" else "${file.path} (${file.size} bytes)")
                    if (!file.isDir) {
                        Row {
                            TextButton(onClick = { selectedPath = file.path; editorText = viewModel.readFile(file.path) }) { Text("Edit") }
                            TextButton(onClick = { viewModel.deleteFile(file.path) }) { Text("Delete") }
                        }
                    }
                }
            }
        }
    }

    selectedPath?.let { path ->
        Text("Editing: $path", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = editorText,
            onValueChange = { editorText = it },
            modifier = Modifier.fillMaxWidth(),
            minLines = 8,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { viewModel.saveFile(path, editorText) }) { Text("Save") }
            TextButton(onClick = { viewModel.exportToConnectedFolder(context, path.substringAfterLast('/'), editorText) }) { Text("Export to folder") }
            TextButton(onClick = { selectedPath = null }) { Text("Close") }
        }
        Text("GitHub push for this file is on the Tools tab.", style = MaterialTheme.typography.bodySmall)
    }
    }
}

@Composable
private fun PreviewScreen(viewModel: WorkbenchViewModel) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    val html = viewModel.readFile("index.html")
    Text("Live preview", style = MaterialTheme.typography.titleLarge)
    Text(
        "Sandboxed preview of index.html from this project. JavaScript runs in the preview only; " +
            "the preview cannot reach the app's stored keys or files.",
        style = MaterialTheme.typography.bodyMedium,
    )
    if (html.isBlank()) {
        Text("No index.html in this project yet. Create the Web starter scaffold on the Mission tab, or ask the model to build one.")
    } else {
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                }
            },
            update = { webView ->
                webView.loadDataWithBaseURL("https://localhost/", html, "text/html", "utf-8", null)
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
    }
    }
}

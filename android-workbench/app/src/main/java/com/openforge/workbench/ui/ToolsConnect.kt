package com.openforge.workbench.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.openforge.workbench.data.DriveStore

@Composable
fun ToolsScreen(viewModel: WorkbenchViewModel) {
    var sqlText by remember { mutableStateOf("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT);\nINSERT INTO notes (title, body) VALUES ('Welcome', 'SQLite runs on this device.');\nSELECT * FROM notes;") }
    var apiUrl by remember { mutableStateOf("https://openrouter.ai/api/v1/models") }
    var apiMethod by remember { mutableStateOf("GET") }
    var apiBody by remember { mutableStateOf("") }
    var pushPath by remember { mutableStateOf("index.html") }
    var pushBranch by remember { mutableStateOf("main") }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Tools", style = MaterialTheme.typography.titleLarge)
            Text("SQLite workbench, API tester, GitHub sync and model health — the web workbench's tool panes, native.", style = MaterialTheme.typography.bodyMedium)
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("SQLite workbench", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(value = sqlText, onValueChange = { sqlText = it }, modifier = Modifier.fillMaxWidth(), minLines = 4)
                    Button(onClick = { viewModel.runSql(sqlText) }, modifier = Modifier.fillMaxWidth()) { Text("Run SQL") }
                    if (viewModel.sqlResult.isNotBlank()) Text(viewModel.sqlResult, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("API tester", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(value = apiUrl, onValueChange = { apiUrl = it }, label = { Text("URL") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { apiMethod = "GET" }) { Text("GET") }
                        TextButton(onClick = { apiMethod = "POST" }) { Text("POST") }
                    }
                    OutlinedTextField(value = apiBody, onValueChange = { apiBody = it }, label = { Text("Body (POST)") }, modifier = Modifier.fillMaxWidth())
                    Button(onClick = { viewModel.runApi(apiMethod, apiUrl, apiBody) }, modifier = Modifier.fillMaxWidth()) { Text("Send request") }
                    if (viewModel.apiResult.isNotBlank()) Text(viewModel.apiResult.take(2000), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("GitHub sync", style = MaterialTheme.typography.titleMedium)
                    Text("Pushes one file with your token (saved encrypted on Connect). It never writes .github/workflows/ — that path still needs a manual add, as on the web workbench.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(value = pushPath, onValueChange = { pushPath = it }, label = { Text("Project file") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = pushBranch, onValueChange = { pushBranch = it }, label = { Text("Branch") }, modifier = Modifier.fillMaxWidth())
                    Button(onClick = { viewModel.pushToGitHub(pushPath, pushBranch) }, modifier = Modifier.fillMaxWidth()) { Text("Push file to GitHub") }
                    if (viewModel.githubResult.isNotBlank()) Text(viewModel.githubResult, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text("Model health", style = MaterialTheme.typography.titleMedium)
                    Text(viewModel.modelStatsText(), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
fun ConnectScreen(viewModel: WorkbenchViewModel) {
    val context = LocalContext.current
    var openRouterKey by remember { mutableStateOf("") }
    var nvidiaKey by remember { mutableStateOf("") }
    var nvidiaModel by remember { mutableStateOf(viewModel.settings.nvidiaModel) }
    var githubToken by remember { mutableStateOf("") }
    var gatewayUrl by remember { mutableStateOf(viewModel.settings.gatewayUrl) }
    var gatewayToken by remember { mutableStateOf("") }
    var gatewayEnabled by remember { mutableStateOf(viewModel.settings.gatewayEnabled) }
    var projectName by remember { mutableStateOf(viewModel.settings.projectName) }
    var githubRepo by remember { mutableStateOf(viewModel.settings.githubRepo) }
    var permissionNote by remember { mutableStateOf("") }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { grants ->
        permissionNote = if (grants.values.all { it }) "Permissions granted." else "Some permissions were declined. The app still works with its private project folder and any folder you pick below."
    }
    val folderLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri: Uri? ->
        if (uri != null) {
            DriveStore.takePersistablePermission(context, uri)
            viewModel.settings.workspaceFolderUri = uri.toString()
            viewModel.settings.driveFolderUri = uri.toString()
            viewModel.refreshDriveListing(context)
            permissionNote = "Folder connected: $uri. The grant covers only this folder and can be revoked in system Settings."
        }
    }

    fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Connect & permissions", style = MaterialTheme.typography.titleLarge)
            Text(
                "Everything here is opt-in and explained before it is asked. Keys are encrypted on this device and sent only to the service they belong to. " +
                    "No key is ever exported with a project.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Your keys (BYOK)", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(value = projectName, onValueChange = { projectName = it }, label = { Text("Project name") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = openRouterKey, onValueChange = { openRouterKey = it }, label = { Text("OpenRouter API key (leave blank if already saved)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = nvidiaKey, onValueChange = { nvidiaKey = it }, label = { Text("NVIDIA Build API key (leave blank if already saved) — v1.1.0 default provider") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = nvidiaModel, onValueChange = { nvidiaModel = it }, label = { Text("NVIDIA model (blank = pick a listed Nemotron model)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = githubToken, onValueChange = { githubToken = it }, label = { Text("GitHub token (leave blank if already saved)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = githubRepo, onValueChange = { githubRepo = it }, label = { Text("GitHub repo (owner/name)") }, modifier = Modifier.fillMaxWidth())
                    Button(
                        onClick = {
                            viewModel.settings.projectName = projectName
                            viewModel.settings.githubRepo = githubRepo
                            viewModel.settings.nvidiaModel = nvidiaModel
                            if (openRouterKey.isNotBlank()) viewModel.settings.openRouterKey = openRouterKey
                            if (nvidiaKey.isNotBlank()) viewModel.settings.nvidiaKey = nvidiaKey
                            if (githubToken.isNotBlank()) viewModel.settings.githubToken = githubToken
                            viewModel.refreshFiles()
                            permissionNote = "Saved. Keys are stored encrypted; blank fields left the previously saved key untouched."
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Save keys & project") }
                    Text(
                        if (viewModel.settings.hasOpenRouterKey()) "OpenRouter key: saved (or gateway enabled)." else "OpenRouter key: not saved yet.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Companion gateway (optional)", style = MaterialTheme.typography.titleMedium)
                    Text("Point the app at your own OpenForge companion gateway instead of OpenRouter directly. The gateway token is encrypted like the other keys.", style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(value = gatewayUrl, onValueChange = { gatewayUrl = it }, label = { Text("Gateway URL, e.g. http://192.168.1.10:8740") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = viewModel.settings.gatewayModel, onValueChange = { viewModel.settings.gatewayModel = it }, label = { Text("Gateway model id: auto, local/<alias>, openrouter/<model>, or <upstream>/<model>") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = gatewayToken, onValueChange = { gatewayToken = it }, label = { Text("Gateway token (leave blank if already saved)") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { gatewayEnabled = !gatewayEnabled; viewModel.settings.gatewayEnabled = gatewayEnabled }) {
                            Text(if (gatewayEnabled) "Gateway: ON" else "Gateway: OFF")
                        }
                        TextButton(onClick = {
                            viewModel.settings.gatewayUrl = gatewayUrl
                            if (gatewayToken.isNotBlank()) viewModel.settings.gatewayToken = gatewayToken
                            permissionNote = "Gateway settings saved."
                        }) { Text("Save gateway") }
                    }
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Device & file permissions", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Why each is asked: notifications for mission completion; media permissions so you can import images/audio into a project; " +
                            "folder access so you can save projects outside the app. The app works without all of them — its private project folder needs no permission at all.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text("Notifications: ${if (Build.VERSION.SDK_INT < 33 || isGranted(Manifest.permission.POST_NOTIFICATIONS)) "granted / not required" else "not granted"}", style = MaterialTheme.typography.bodySmall)
                    Text("Media (images/video/audio): ${if (isGranted(Manifest.permission.READ_MEDIA_IMAGES)) "granted" else "not granted"}", style = MaterialTheme.typography.bodySmall)
                    Text(
                        "All-files access: ${if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) "granted" else "not granted (optional; folder access below is the recommended path)"}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(
                        onClick = {
                            val wanted = mutableListOf<String>()
                            if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
                            if (Build.VERSION.SDK_INT >= 33) {
                                wanted.add(Manifest.permission.READ_MEDIA_IMAGES)
                                wanted.add(Manifest.permission.READ_MEDIA_VIDEO)
                                wanted.add(Manifest.permission.READ_MEDIA_AUDIO)
                            } else {
                                wanted.add(Manifest.permission.READ_EXTERNAL_STORAGE)
                            }
                            permissionLauncher.launch(wanted.toTypedArray())
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Request notifications & media permissions") }
                    Button(
                        onClick = {
                            if (Build.VERSION.SDK_INT >= 30) {
                                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${context.packageName}"))
                                context.startActivity(intent)
                                permissionNote = "Opened system Settings for all-files access. This step is optional — prefer the folder picker below."
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Open all-files access in Settings (optional)") }
                    Button(onClick = { folderLauncher.launch(null) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Pick a device or Google Drive folder")
                    }
                    Text(
                        "Picking a folder is how Drive works here: Google Drive appears in the picker as a location. " +
                            "Android then grants this app access to that folder only, and the grant persists until you revoke it.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    TextButton(onClick = { viewModel.refreshDriveListing(context) }) { Text("Refresh connected folder listing") }
                    if (permissionNote.isNotBlank()) Text(permissionNote, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(viewModel.driveListing, key = { it }) { name ->
            Text(name, style = MaterialTheme.typography.bodySmall)
        }
    }
}

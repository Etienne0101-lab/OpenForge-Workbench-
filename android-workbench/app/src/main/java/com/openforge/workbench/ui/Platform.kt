package com.openforge.workbench.ui

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
import androidx.compose.ui.unit.dp

/**
 * Platform tab — parent-repo features that arrived after v1.0.0, plus the
 * older organism/gateway/quota work that v1.0.0 had not ported yet:
 * generic API-key vault, NVIDIA default provider, key probe (models list
 * + tiny chat, never a key fragment in an error), organism + scheduler
 * state pulled from the repo, and swarm missions.
 */
@Composable
fun PlatformScreen(viewModel: WorkbenchViewModel, onGoToMission: () -> Unit) {
    var providerName by remember { mutableStateOf("") }
    var providerUrl by remember { mutableStateOf("https://") }
    var providerModel by remember { mutableStateOf("") }
    var providerKey by remember { mutableStateOf("") }
    var vaultNote by remember { mutableStateOf("") }
    var organismBranch by remember { mutableStateOf("main") }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Platform", style = MaterialTheme.typography.titleLarge)
            Text(
                "Parent-repo ports (2026-10-24): NVIDIA as default provider, generic API-key vault, NVIDIA Build key probe, " +
                    "organism/scheduler state, and swarm missions. Current provider for missions: ${viewModel.currentProvider}.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Provider for missions", style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { viewModel.selectProvider("nvidia") }) { Text("NVIDIA") }
                        Button(onClick = { viewModel.selectProvider("openrouter") }) { Text("OpenRouter") }
                        Button(onClick = { viewModel.selectProvider("gateway") }) { Text("Gateway") }
                    }
                    Text(
                        "NVIDIA wins only when an NVIDIA key is saved (Connect tab); otherwise the app falls back to OpenRouter. " +
                            "Gateway wins only when the gateway toggle is on and a URL is saved.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Text(viewModel.quotaText(), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Generic API-key vault", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Any provider, any endpoint — gated to OpenAI-shape only: https, no query/fragment, " +
                            "and the app only ever calls <base>/chat/completions and <base>/models. Keys are encrypted on this device.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedTextField(value = providerName, onValueChange = { providerName = it }, label = { Text("Provider name") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = providerUrl, onValueChange = { providerUrl = it }, label = { Text("Base URL, e.g. https://api.example.com/v1") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = providerModel, onValueChange = { providerModel = it }, label = { Text("Model (blank = pick from its /models list)") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(value = providerKey, onValueChange = { providerKey = it }, label = { Text("API key") }, modifier = Modifier.fillMaxWidth())
                    Button(
                        onClick = {
                            vaultNote = viewModel.settings.saveCustomProvider(providerName, providerUrl, providerModel, providerKey)
                            providerKey = ""
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Save provider to vault") }
                    if (vaultNote.isNotBlank()) Text(vaultNote, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(viewModel.settings.listCustomProviders(), key = { it.name }) { provider ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(provider.name, style = MaterialTheme.typography.titleMedium)
                        Text("${provider.baseUrl} — model: ${provider.model.ifBlank { "(from /models)" }}", style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = { viewModel.selectProvider("custom:${provider.name}") }) { Text("Use") }
                    TextButton(onClick = { viewModel.settings.deleteCustomProvider(provider.name) }) { Text("Delete") }
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Key probe", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "A models list alone is not proof a key can call. The NVIDIA probe also runs a real tiny chat (max_tokens = 1) " +
                            "on a listed Nemotron model, as the parent key-probe workflow does. Errors show code/type only, never a message that could echo a key fragment.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { viewModel.runProbe("openrouter") }) { Text("OpenRouter") }
                        Button(onClick = { viewModel.runProbe("nvidia") }) { Text("NVIDIA") }
                        Button(onClick = { viewModel.runProbe("gateway") }) { Text("Gateway") }
                    }
                    if (viewModel.probeText.isNotBlank()) Text(viewModel.probeText, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Organism & scheduler", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Pulled from ${viewModel.settings.githubRepo} on the branch below (tokenless when no GitHub token is saved). " +
                            "Organism state is the lifecycle engine's own record; the app never writes it from here.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedTextField(value = organismBranch, onValueChange = { organismBranch = it }, label = { Text("Branch") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { viewModel.fetchOrganism(organismBranch) }) { Text("Fetch organism") }
                        Button(onClick = { viewModel.fetchSchedule(organismBranch) }) { Text("Fetch schedule") }
                    }
                    if (viewModel.organismText.isNotBlank()) Text("organism.json:\n${viewModel.organismText.take(2000)}", style = MaterialTheme.typography.bodySmall)
                    if (viewModel.scheduleText.isNotBlank()) Text("schedule.json:\n${viewModel.scheduleText.take(2000)}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = {
                        viewModel.missionGoal = "Stage this organism proposal as a mission: ${viewModel.organismText.take(500)}"
                        onGoToMission()
                    }) { Text("Stage organism state as a mission →") }
                }
            }
        }
        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Swarm mission", style = MaterialTheme.typography.titleMedium)
                    Text("Same goal on the top 3 priority models, results kept separate so you can compare before running the winner as a normal mission.", style = MaterialTheme.typography.bodySmall)
                    Button(
                        onClick = { viewModel.runSwarm(viewModel.missionGoal) },
                        enabled = !viewModel.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (viewModel.busy) "Running swarm…" else "Run swarm on mission goal") }
                    if (viewModel.platformStatus.isNotBlank()) Text(viewModel.platformStatus, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        items(viewModel.swarmResults, key = { it.role + it.content.hashCode() }) { result ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(result.role, style = MaterialTheme.typography.labelMedium)
                    Text(result.content, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

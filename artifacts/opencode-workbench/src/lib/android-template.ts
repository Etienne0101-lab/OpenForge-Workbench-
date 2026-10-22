// Full-stack Android starter: a complete, buildable Kotlin/Jetpack
// Compose app plus its Node (Express) API in one repo. The Android
// half follows the platform contract — pinned AGP/Kotlin/Gradle
// versions, env-driven release signing pre-wired (same guarded block
// the Deploy > Android tab appends), BuildConfig API base URL — so a
// project created from this template builds in the OpenForge Android
// workflow with zero extra setup, and the assistant (Android
// Architect mode) extends it feature by feature.

import type { ProjectTemplate } from './templates';

export const ANDROID_TEMPLATE: ProjectTemplate = {
  id: 'android-fullstack',
  name: 'Full-Stack Android App (Kotlin + Compose + Node API)',
  description: 'Buildable Android app (Jetpack Compose, Retrofit, MVVM) plus its Express API — signing pre-wired, ready for the Android pipeline.',
  files: [
    {
      path: 'README.md',
      content: `# Full-Stack Android Starter

A complete, buildable Android app and its API in one repo:

- **app/** — Kotlin + Jetpack Compose client (MVVM, Retrofit, Material 3)
- **server/** — Node + Express API the app talks to (JSON-file store to start)

## Run the API

\`\`\`bash
cd server
npm install
npm start        # http://localhost:3000 — GET /health to verify
\`\`\`

## Run the app

Open the project in Android Studio, or build from the workbench
(Deploy → Android → Build now). The app reaches the API at
\`http://10.0.2.2:3000/\` by default — the emulator's alias for your
machine's localhost. For a physical device or a deployed API, change
\`API_BASE_URL\` in \`app/build.gradle.kts\` (buildConfigField).

## Build & ship

- Debug APK: no secrets needed.
- Release: signing is pre-wired to the \`SIGNING_*\` env vars (see the
  guarded block at the bottom of \`app/build.gradle.kts\`); the
  OpenForge Android workflow supplies them from repo secrets.
- Before a real Play release: change \`applicationId\` (and the
  package directories) from \`com.openforge.starter\` to your own,
  and bump \`versionCode\`/\`versionName\`.

## Grow it with the assistant

Switch the assistant to **Android Architect** mode and describe the
feature — it knows this stack, these versions, and the build
contract, and will extend the client and the API together.
`,
    },
    {
      path: 'settings.gradle.kts',
      content: `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "OpenForgeStarter"
include(":app")
`,
    },
    {
      path: 'build.gradle.kts',
      content: `// Top-level build file — plugin versions for the whole project.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
}
`,
    },
    {
      path: 'gradle.properties',
      content: `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
`,
    },
    {
      path: 'gradle/wrapper/gradle-wrapper.properties',
      content: `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
    },
    {
      path: '.gitignore',
      content: `*.iml
.gradle/
/local.properties
/.idea/
.DS_Store
/build/
/captures/
.externalNativeBuild/
.cxx/
app/build/
server/node_modules/
server/data.json
keystore.jks
`,
    },
    {
      path: 'app/build.gradle.kts',
      content: `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.openforge.starter"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.openforge.starter"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // The API base URL. 10.0.2.2 is the Android emulator's alias
        // for the host machine's localhost. Point this at your
        // deployed API for release builds on real devices.
        buildConfigField("String", "API_BASE_URL", "\\"http://10.0.2.2:3000/\\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

// >>> OpenForge Android signing (managed by the workbench) >>>
// Env-driven release signing for CI (GitHub Actions). The guard keeps
// local builds working: without SIGNING_KEY_STORE_PATH set, this block
// is inert and the project's own signing setup applies.
if (System.getenv("SIGNING_KEY_STORE_PATH") != null) {
    android {
        signingConfigs {
            create("release") {
                storeFile = file(System.getenv("SIGNING_KEY_STORE_PATH"))
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
        buildTypes {
            getByName("release") {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}
// <<< OpenForge Android signing (managed by the workbench) <<<
`,
    },
    {
      path: 'app/proguard-rules.pro',
      content: `# Starter proguard rules. Add keep rules for your models if you
# enable minification (Retrofit/Gson models usually need them).
`,
    },
    {
      path: 'app/src/main/AndroidManifest.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <!-- usesCleartextTraffic allows the local dev API over http.
         Remove it (and switch API_BASE_URL to https) for production. -->
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/Theme.OpenForgeStarter"
        android:usesCleartextTraffic="true">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`,
    },
    {
      path: 'app/src/main/res/values/strings.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">OpenForge Starter</string>
</resources>
`,
    },
    {
      path: 'app/src/main/res/values/colors.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1F6FEB</color>
</resources>
`,
    },
    {
      path: 'app/src/main/res/values/themes.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.OpenForgeStarter" parent="android:Theme.Material.Light.NoActionBar" />
</resources>
`,
    },
    {
      path: 'app/src/main/res/drawable/ic_launcher_foreground.xml',
      content: `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M54,26 L78,74 L64,74 L54,52 L44,74 L30,74 Z" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M38,80 L70,80 L70,86 L38,86 Z" />
</vector>
`,
    },
    {
      path: 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      content: `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`,
    },
  ],
};

ANDROID_TEMPLATE.files.push(
  {
    path: 'app/src/main/java/com/openforge/starter/MainActivity.kt',
    content: `package com.openforge.starter

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.openforge.starter.ui.StarterApp
import com.openforge.starter.ui.StarterTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            StarterTheme {
                StarterApp()
            }
        }
    }
}
`,
  },
  {
    path: 'app/src/main/java/com/openforge/starter/data/ItemsApi.kt',
    content: `package com.openforge.starter.data

import com.openforge.starter.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

/** One row of the starter's item list — mirrors the server's model. */
data class Item(
    val id: Long,
    val title: String,
    val notes: String,
    val done: Boolean,
    val createdAt: String,
)

data class CreateItemRequest(
    val title: String,
    val notes: String = "",
)

/** The REST contract with server/ — keep both sides in sync. */
interface ItemsApi {
    @GET("items")
    suspend fun listItems(): List<Item>

    @POST("items")
    suspend fun createItem(@Body body: CreateItemRequest): Item

    @DELETE("items/{id}")
    suspend fun deleteItem(@Path("id") id: Long): Item
}

object ApiClient {
    val items: ItemsApi by lazy {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BASIC
        }
        val client = OkHttpClient.Builder().addInterceptor(logging).build()
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(ItemsApi::class.java)
    }
}
`,
  },
  {
    path: 'app/src/main/java/com/openforge/starter/ui/AppViewModel.kt',
    content: `package com.openforge.starter.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openforge.starter.data.ApiClient
import com.openforge.starter.data.CreateItemRequest
import com.openforge.starter.data.Item
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AppUiState(
    val items: List<Item> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class AppViewModel : ViewModel() {
    private val _state = MutableStateFlow(AppUiState())
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            runCatching { ApiClient.items.listItems() }
                .onSuccess { items -> _state.update { it.copy(items = items, loading = false) } }
                .onFailure { failure ->
                    _state.update {
                        it.copy(
                            loading = false,
                            error = "Could not reach the API (\${failure.message}). Is the server running?",
                        )
                    }
                }
        }
    }

    fun addItem(title: String, notes: String) {
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty()) return
        viewModelScope.launch {
            runCatching { ApiClient.items.createItem(CreateItemRequest(cleanTitle, notes.trim())) }
                .onSuccess { created -> _state.update { it.copy(items = listOf(created) + it.items, error = null) } }
                .onFailure { failure -> _state.update { it.copy(error = "Add failed: \${failure.message}") } }
        }
    }

    fun deleteItem(item: Item) {
        viewModelScope.launch {
            runCatching { ApiClient.items.deleteItem(item.id) }
                .onSuccess { _state.update { current -> current.copy(items = current.items.filterNot { it.id == item.id }) } }
                .onFailure { failure -> _state.update { it.copy(error = "Delete failed: \${failure.message}") } }
        }
    }
}
`,
  },
  {
    path: 'app/src/main/java/com/openforge/starter/ui/StarterApp.kt',
    content: `package com.openforge.starter.ui

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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openforge.starter.data.Item

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StarterApp(viewModel: AppViewModel = viewModel()) {
    val state by viewModel.state.collectAsState()
    var title by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("OpenForge Starter") },
                actions = {
                    TextButton(onClick = { viewModel.refresh() }) { Text("Refresh") }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Add an item", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = { Text("Title") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = notes,
                        onValueChange = { notes = it },
                        label = { Text("Notes (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = {
                            viewModel.addItem(title, notes)
                            title = ""
                            notes = ""
                        },
                        enabled = title.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Add") }
                }
            }

            if (state.loading) {
                CircularProgressIndicator()
            }
            state.error?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error)
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.items, key = { it.id }) { item ->
                    ItemRow(item = item, onDelete = { viewModel.deleteItem(item) })
                }
            }
        }
    }
}

@Composable
private fun ItemRow(item: Item, onDelete: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(item.title, style = MaterialTheme.typography.titleMedium)
                if (item.notes.isNotBlank()) {
                    Text(item.notes, style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    if (item.done) "Done" else "Open",
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            TextButton(onClick = onDelete) { Text("Delete") }
        }
    }
}
`,
  },
  {
    path: 'app/src/main/java/com/openforge/starter/ui/Theme.kt',
    content: `package com.openforge.starter.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

@Composable
fun StarterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(),
        content = content,
    )
}
`,
  },
  {
    path: 'server/package.json',
    content: `{
  "name": "openforge-starter-api",
  "version": "1.0.0",
  "private": true,
  "description": "API for the OpenForge full-stack Android starter. Express + a JSON-file store — swap the store for a real database as the app grows.",
  "type": "commonjs",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
`,
  },
  {
    path: 'server/index.js',
    content: `// OpenForge starter API — the backend half of the full-stack
// Android starter. Express + a JSON-file store (data.json next to
// this file, created and seeded on first boot). The Android client's
// contract lives in app/.../data/ItemsApi.kt — keep them in sync.
//
//   GET    /health      -> { ok: true }
//   GET    /items       -> [Item] (newest first)
//   POST   /items       -> 201 Item   { title, notes? }
//   GET    /items/:id   -> Item | 404
//   PATCH  /items/:id   -> Item       { title?, notes?, done? }
//   DELETE /items/:id   -> the deleted Item | 404
//
// Item: { id, title, notes, done, createdAt }

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, 'data.json');

function seedItems() {
  const now = new Date().toISOString();
  return [
    { id: 2, title: 'Build the app in the workbench', notes: 'Deploy → Android → Build now', done: false, createdAt: now },
    { id: 1, title: 'Run this API', notes: 'npm install && npm start', done: true, createdAt: now },
  ];
}

function loadItems() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing or corrupt — reseed below */ }
  const seeded = seedItems();
  saveItems(seeded);
  return seeded;
}

function saveItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
}

let items = loadItems();
let nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;

const app = express();
app.use(express.json());
// Dev-friendly CORS: the Android app runs on devices/emulators, not a
// browser origin, but this keeps web test clients working too.
app.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

app.get('/health', (request, response) => response.json({ ok: true }));

app.get('/items', (request, response) => {
  response.json([...items].sort((a, b) => b.id - a.id));
});

app.post('/items', (request, response) => {
  const title = String(request.body?.title || '').trim();
  if (!title) return response.status(400).json({ error: 'title is required' });
  const item = {
    id: nextId++,
    title,
    notes: String(request.body?.notes || ''),
    done: false,
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  saveItems(items);
  response.status(201).json(item);
});

app.get('/items/:id', (request, response) => {
  const item = items.find((entry) => entry.id === Number(request.params.id));
  if (!item) return response.status(404).json({ error: 'item not found' });
  response.json(item);
});

app.patch('/items/:id', (request, response) => {
  const item = items.find((entry) => entry.id === Number(request.params.id));
  if (!item) return response.status(404).json({ error: 'item not found' });
  if (typeof request.body?.title === 'string') item.title = request.body.title;
  if (typeof request.body?.notes === 'string') item.notes = request.body.notes;
  if (typeof request.body?.done === 'boolean') item.done = request.body.done;
  saveItems(items);
  response.json(item);
});

app.delete('/items/:id', (request, response) => {
  const index = items.findIndex((entry) => entry.id === Number(request.params.id));
  if (index === -1) return response.status(404).json({ error: 'item not found' });
  const [removed] = items.splice(index, 1);
  saveItems(items);
  response.json(removed);
});

app.listen(PORT, () => {
  console.log(\`OpenForge starter API listening on http://localhost:\${PORT}\`);
});
`,
  },
  {
    path: 'server/README.md',
    content: `# Starter API

Express + JSON-file store (data.json, seeded on first boot).

\`\`\`bash
npm install
npm start          # PORT env or 3000
\`\`\`

Endpoints: \`GET /health\`, \`GET/POST /items\`, \`GET/PATCH/DELETE /items/:id\`.

The Android emulator reaches this server at \`http://10.0.2.2:3000/\`
(already the app's default \`API_BASE_URL\`). To deploy it (Render,
Railway, Fly, a VPS), the only contract is: Node ≥ 18, \`npm start\`,
and a \`PORT\` env — then set the app's \`API_BASE_URL\` to the public
https URL and remove \`usesCleartextTraffic\` from the manifest.
`,
  },
);

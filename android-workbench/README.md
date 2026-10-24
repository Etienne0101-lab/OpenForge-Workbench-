# OpenForge Workbench — Android (native)

A native Kotlin + Jetpack Compose port of the OpenForge Workbench's
operational core, in `app/` under this directory. Package:
`com.openforge.workbench`, minSdk 24, targetSdk 34.

## What is ported, natively

- **Mission loop** — mission composer, 9 expert modes (including Android
  Architect), repo-map context, and the web workbench's change-set
  protocol: the model proposes ` ```openforge:file <path> ` blocks and
  nothing is written until you tap Accept.
- **Model router** — MiniMax M3.1 Flash default, NVIDIA Nemotron 3.5
  Lightning second, then the rest of the approved free pool, with
  per-model health, escalating 429 cooldowns (45s → 300s) and rotation.
  **Gemma and Lyria are hard-excluded** in `ModelPool` and in the router.
- **BYOK keys** — your OpenRouter key, GitHub token and gateway token are
  encrypted with an Android KeyStore AES/GCM key. Keys go only to
  api.openrouter.ai, api.github.com, or your own gateway URL. Nothing is
  exported with a project.
- **Companion gateway** — optional toggle on the Connect tab, same
  `/v1/chat/completions` shape as the web workbench's gateway.
- **Project files** — on-device workspace, file browser, editor,
  7 starter scaffolds, repo map, and a sandboxed WebView preview of
  `index.html` (JavaScript on, file/content access off, so a preview
  cannot reach stored keys).
- **SQLite workbench** — real on-device SQLite (`workbench.db`), not a
  simulation.
- **API tester** — GET/POST against any URL, status + body shown.
- **GitHub sync** — push one project file per tap with your token. It
  never writes `.github/workflows/`; that path still needs a manual add,
  exactly as on the web workbench.
- **Permissions & connected services** — the Connect tab explains each
  permission before asking: notifications, media, optional all-files
  access via system Settings, and a Storage Access Framework folder
  picker. **Google Drive works through that picker**: Drive appears as a
  location in Android's file picker, and Android grants this app access
  to exactly the folder you pick, persisted until you revoke it. No
  OAuth client id is needed for that path, and no background Drive sync
  runs. Export a project file to the connected folder from the Files tab.

## What is deliberately not claimed

The web workbench's in-browser runtimes do not have a like-for-like
native equivalent inside one APK: WebContainers/Node-in-browser and
Pyodide do not run on Android this way. The Android app covers them
through the mission + gateway route instead: run a mission against the
companion gateway (which can run the agent, inference and gateway
services on your own machine) and pull the results back as files.
Do not treat the preview WebView as a Node/Python runtime — it renders
HTML/JS only.

## Build

Android Studio: open `android-workbench/` and run the app module.

CI: the repo's `openforge-android.yml` workflow can build this project
with `project_path: android-workbench` (debug-apk, release-apk or
release-aab pipelines; release signing comes from the `SIGNING_*`
secrets, and the signing block is env-guarded so local builds stay
inert without them).

Sandbox note: Gradle's daemon loopback is blocked in the Muse sandbox
by the runtime's `other_tcp` permission, so the APK delivered with this
branch was produced with the verified daemon-free path (aapt2 +
kotlinc with the Compose compiler plugin + d8 + zipalign + apksigner)
at the same pins as `app/build.gradle.kts`. The first CI dispatch on
this branch, or a local Gradle build outside the sandbox, exercises
the AGP path itself.

## Install

Install the debug APK on a device, open the Connect tab, save your
OpenRouter key, optionally pick a Drive/device folder, then run a
mission from the Mission tab.

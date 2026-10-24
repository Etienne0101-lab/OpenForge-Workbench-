# OpenForge Workbench — Android (native)

A native Kotlin + Jetpack Compose port of the OpenForge Workbench's
operational core, in `app/` under this directory. Package:
`com.openforge.workbench`, minSdk 24, targetSdk 34.

## v1.1.0 — parent-repo ports + Galaxy S24 (2026-10-24)

Parent-repo changes ported since v1.0.0 (branch point: main `ede5c2f7`):

- **NVIDIA as default provider** (parent, 2026-10-24): the app's default
  provider is now NVIDIA Build direct (`integrate.api.nvidia.com/v1`,
  BYOK). It wins only when an NVIDIA key is saved; otherwise missions
  fall back to OpenRouter, whose pool default stays MiniMax M3.1 Flash.
  Gateway namespaces are now honoured: `auto`, `local/<alias>`,
  `openrouter/<model>`, `<upstream>/<model>`.
- **Generic API-key vault** (parent, 2026-10-24): any provider, any
  endpoint, user-defined on the Platform tab — gated to OpenAI-shape
  only (https, no query/fragment, only `/chat/completions` + `/models`).
  Vault keys are encrypted like the other keys.
- **Key probe** (parent NVIDIA Build leg): models list plus a real tiny
  chat (`max_tokens = 1`) on a listed Nemotron model. A list alone is
  not proof a key can call. Errors show code/type only, never a message
  that could echo a key fragment.
- **Organism & scheduler state**: the Platform tab pulls
  `.openforge/organism.json` and `.openforge/schedule.json` from the
  repo (tokenless when no token is saved) and can stage organism state
  as a mission. The app never writes organism state from here.
- **Swarm missions**: the same goal on the top 3 priority models,
  results kept separate for comparison.
- **Quota ledger**: prompt/completion tokens from each reply are
  totalled per day and shown on Mission and Platform.

## Galaxy S24 deployment profile

Target device: Samsung Galaxy S24 — 6.2" Dynamic LTPO AMOLED 2X,
1080 x 2340, 120 Hz, Android 14 / One UI 6.1 at launch, Snapdragon 8
Gen 3 (US) / Exynos 2400 (international), 8 GB RAM, arm64. The app is
a universal APK (no native libraries), so it runs on either S24
chipset; targetSdk 34 matches the S24's launch Android version.

Optimizations for this device:

- Portrait (~360dp wide): single thumb-reachable column, one scroll.
  Landscape / wide (600dp+): Mission becomes two panes — composer
  left, scaffolds/proposals/messages right, each scrolling.
- `configChanges` for orientation/screenSize/density so a rotation
  does not restart a mission; state already lives in the ViewModel.
- Hardware acceleration on, resizeable activity for split-screen
  and DeX, edge-to-edge Compose Scaffold with window insets.
- No heavy background work: network calls are coroutine-scoped with
  30s connect / 60–180s read timeouts, and the quota ledger keeps
  token use visible instead of silent.

## Packaging for deployment

- Version 1.1.0, versionCode 2.
- Direct S24 install: the APK delivered with this branch is
  zipaligned and apksigner-verified, signed in the sandbox with the
  local debug keystore (the same key used for v1.0.0). It installs
  and runs on an S24 as-is; it is not Play-signed.
- Google Play: build via CI with `openforge-android.yml`
  (`project_path: android-workbench`, release-apk/release-aab) using
  the `SIGNING_*` repo secrets — the Gradle signing block is
  env-guarded, so local builds stay inert without them. A workflow
  file cannot be added from this branch via the GitHub App (it
  returns 403 on `.github/workflows/`), so the Play build uses the
  existing workflow already installed in the repo.

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

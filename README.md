# OpenForge Workbench

A browser coding workspace inspired by OpenCode: a project file explorer, an
editor, AI chat, and a safe code-change review workflow — powered by
OpenRouter and designed to work like a senior engineering team in a tab:
system architecture, production code in any language, advanced ML systems,
data engineering, security review, and platform work.

This repository hosts the project originally built in Replit as
**OpenCode Router** (app: *OpenCode Workbench*, `artifacts/opencode-workbench`)
and replicates it as a live site on GitHub Pages:

**Live site:** https://etienne0101-lab.github.io/OpenForge-Workbench-/

## How the GitHub Pages version works

GitHub Pages serves static files only, so the built site in `docs/` talks to
OpenRouter **directly from the browser** instead of through the Replit
Express server:

- Each visitor pastes their own OpenRouter API key once (sidebar or chat).
  The key is stored only in that browser's local storage and is sent only to
  OpenRouter. No key exists in this repository.
- Projects, files, and conversations live entirely in the browser
  (IndexedDB), with ZIP import/export and optional direct access to a local
  folder via the File System Access API — exactly as in the Replit version.

## What it can do

- **Every OpenRouter model.** The full live catalog — frontier models
  (Claude, GPT, Gemini, Grok), specialist coding models, and all free
  models — searchable from the chat header, with context sizes and
  per-million-token pricing shown. Curated recommendations are pinned at
  the top; the free router remains the default.
- **Expert modes.** Seven senior-level operating modes change how the
  assistant reasons: Senior Engineer, System Architect, ML Systems, Data
  Engineering, Security Review, DevOps / Platform, and Research & Frontier —
  each with a deep field-specific system prompt layered on a shared master
  prompt (`src/lib/modes.ts`).
- **Project intelligence.** Every request carries a repo map of the whole
  project (paths, sizes, extracted classes/functions/exports) plus file
  context auto-selected by relevance to your message and budgeted to the
  model's real context window (`src/lib/project-map.ts`). Files you pin as
  context always win; relevance ranking fills the rest.
- **Reviewable change sets.** The assistant explains its plan, then proposes
  changes in three forms: full files (`<<<FILE>>>`), targeted FIND/REPLACE
  patches (`<<<PATCH>>>`), and deletions (`<<<DELETE>>>`) — across many files
  at once. Each change is labeled (New file / Replace / Patch / Delete),
  previewed with syntax highlighting, and accepted or rejected individually
  or all at once. The assistant cannot edit files on its own.
- **Built for free-tier reality.** Free models fail in characteristic ways —
  empty streams, mid-response stalls, and agent-harness models answering with
  raw tool-call markup for tools that do not exist in a browser. The workbench
  counters all three: the system prompt forbids tool calls outright, a
  45-second stall watchdog kills hung streams, tool-call markup is stripped
  from responses, and when the chosen model is free, reliable named free
  models (Qwen Coder, DeepSeek, Llama, Gemini Flash…) are lined up as
  automatic fallbacks so a bad draw retries instead of dead-ending. Fresh
  sessions default to a named free model rather than the random free router.
- **Polished output & downloads.** Assistant answers render as real Markdown
  (headings, lists, task lists, tables, blockquotes, emphasis, links) with
  syntax-highlighted code blocks that carry copy/download buttons
  (`src/lib/markdown.tsx`). Every generated file is one click from your disk:
  a Download button on each proposed change (patches download the fully
  patched result), a download button on every file in the tree, a "Save .md"
  button on every response, plus the existing whole-project ZIP export.
- **Editor upgrades.** Line numbers, Tab indentation, and syntax
  highlighting in chat code blocks and change previews.
- **Starter scaffolds.** One-click complete projects
  (`src/lib/templates.ts`): a PyTorch ML training pipeline, a FastAPI ML
  inference service, a React + TypeScript app, a Python ETL data pipeline,
  and an Express + TypeScript API.

## v4 — Phase A: full-stack development

- **Live preview pane** (top bar -> Preview): renders the current project in a sandboxed iframe. React/TS projects are bundled in-browser with esbuild-wasm against a virtual filesystem (bare imports resolve via esm.sh import maps); plain HTML projects get their CSS/JS inlined and images embedded. Previewed code runs in an opaque origin and cannot touch the workbench's storage or keys.
- **Database workbench** (top bar -> database icon): real SQLite via sql.js (WebAssembly) — SQL editor, results tables, table list, load .sql files from the project, import/export .sqlite files. The database lives in the tab; export it to persist your work.
- **GitHub sync** (top bar -> sync icon): two-way sync with any GitHub repository via the REST API. Pull replaces the workspace (with confirmation; public repos need no token); push creates a real commit. The token is stored only in the browser's localStorage and sent only to api.github.com.
- **Full-Stack Web expert mode** plus two full-stack scaffolds: Express + SQLite (zero-build, sql.js) and FastAPI + React + Postgres (docker-compose).

## v4.1 — Phase B: run, test, ship

- **Python runner** (top bar -> terminal icon): real CPython via Pyodide (WebAssembly). Project files mount at /project before each run (cross-module imports and relative reads work); stdout/stderr/tracebacks render in a console. Extra packages install via micropip from inside Python. Runs share the tab's main thread — an infinite loop freezes the page, and the panel says so.
- **API tester** (top bar -> globe icon): method/URL/headers/body with timed responses, status chips, response headers, and pretty-printed JSON. Browser CORS rules apply — the error message explains when CORS is the blocker. The last request persists in the browser.
- **Deploy** (top bar -> rocket icon): Netlify (ZIP deploy API; can create the site) and Vercel (file-digest deploy API) publish the workspace's files with your own tokens, stored only in the browser. Cloudflare Pages uses its native git flow: push with GitHub sync, connect the repo in Cloudflare once, and every push auto-deploys — the panel walks through it.

## v4.2 — Phase C: WebContainer runtime

- **Node runtime panel** (top bar -> container icon): a real Node.js environment in the tab via StackBlitz WebContainers. The workspace mounts into the container; run `npm install`, dev servers, and builds; when a server starts, its live preview embeds in the panel. This closes the full-stack loop: the Express + SQLite template can serve its pages AND its /api from inside the browser.
- **Cross-origin isolation on Pages**: WebContainers need SharedArrayBuffer, which needs COOP/COEP headers GitHub Pages cannot set. The site ships `coi-serviceworker.js` (coi-serviceworker v0.1.7, MIT, by Guido Zuidhof) configured for credentialless COEP; it synthesizes the headers via a service worker and reloads the page once on first visit.
- **Licensing note**: the WebContainer API is free for personal and open-source use; commercial production products should review StackBlitz's licensing terms.
- Known limits: one runtime per page (boot is a singleton); container file edits do not flow back to the workspace (re-sync re-mounts); Chromium-based browsers give the most reliable runtime.

## Repository layout

- `docs/` — the built static site served by GitHub Pages (with `404.html` as
  the SPA fallback). Do not edit by hand; rebuild from source instead.
- `artifacts/opencode-workbench/` — the web app (Vite + React + TypeScript).
  The static-build adaptation and the overhaul live under `src/lib/`
  (`openrouter.ts`, `modes.ts`, `project-map.ts`, `templates.ts`) and
  `src/App.tsx`.
- `artifacts/api-server/` — the original Express API server (OpenRouter
  proxy, free models only). Not used by GitHub Pages; kept for reference or
  self-hosting, where it reads `OPENROUTER_API_KEY` from the environment.
- `artifacts/mockup-sandbox/` — the Replit mockup/prototype sandbox that
  shipped in the same workspace. Not part of the deployed site.
- `lib/` — shared packages: generated API client (`api-client-react`), API
  contract (`api-spec`, OpenAPI), validation schemas (`api-zod`), and the
  database package (`db` — an unused scaffold; the schema is empty and the
  app stores data in the browser).
- `scripts/` — workspace maintenance scripts.

Not carried over from the Replit export: `attached_assets/` (a PDF attachment,
not code) and the `screenshots/` image (binary; the connector used for this
push accepts text files only).

## Rebuilding the Pages site

```sh
corepack enable pnpm   # or install pnpm 10
pnpm install --frozen-lockfile
PORT=23699 BASE_PATH=/OpenForge-Workbench-/ NODE_ENV=production \
  pnpm --filter @workspace/opencode-workbench run build
# copy artifacts/opencode-workbench/dist/public/ into docs/,
# plus a copy of index.html as docs/404.html and an empty docs/.nojekyll
```

## Running the original full stack (as on Replit)

```sh
pnpm install
DATABASE_URL=... OPENROUTER_API_KEY=... \
  pnpm --filter @workspace/api-server run dev   # API on port 5000
pnpm --filter @workspace/opencode-workbench run dev
```

### v4.3 (infrastructure audit release)

- Preview pane device widths: desktop / tablet (768px) / phone (390px) toggles.
- GitHub pull rebuilt from stress-test findings: tokenless pulls of public repos go through the jsDelivr GitHub mirror pinned to the branch's head commit (one API call to resolve the commit, then CDN file fetches; files up to 20 MB, up to 2,000 entries). Token pulls keep the authenticated git API path, which also covers private repos. The old per-file anonymous path exhausted GitHub's 60-requests/hour quota on any real repo, and the zip archive endpoint is not readable from a browser (its CORS policy only allows github.com origins) — both dead ends were found by testing, not assumed away.

## v5.0 — Mission Mode (supervised agent)

A supervised in-browser agent that executes multi-step goals on a **copy** of the project: it plans (you approve the plan), reads/searches code, proposes changes in the platform's change-block format (you approve each one, or approve-and-remember per mission), and verifies web work with the preview builder. Design: one JSON action per model turn, validated against a tool registry with a repair loop — deliberately not dependent on provider-native tool calling, which free models emit unreliably. Safety: diff checkpoints with rewind, budgets (steps/repairs/minutes) per preset (Supervised 12/2/20, Careful 20/3/30), credential files are never readable by the agent, and the agent has **no** GitHub push or deploy tools — merging the mission copy back (with per-file conflict choices) is a human action. Full design: `openforge-mission-mode-design.md` (Stephen's files). v5.1 will add the verification loop tools (runtime commands, Python, SQL, API checks) and the Deep preset on this engine.

### v5.1 — LangGraph-architecture graph runtime + verification tools

Mission Mode's engine now runs on an explicit state graph (`src/lib/agent/graph.ts`) incorporating LangGraph's proven design natively — nodes (Plan → Act → Verify, Repair, Human Gate, Finalize) with conditional routing, append-only event/message channels, a checkpoint persisted after every superstep, and approval gates as graph interrupts whose resume value is the user's decision. (The literal LangGraph framework is Python/server software and cannot run in a static browser app; the separate JS port would have cost megabytes and the platform's persistence model. The full viability analysis lives with the design docs.) The Mission panel renders the graph live with the current node highlighted and a superstep counter. New agent tools, each with per-tool approval patterns (approve + remember is scoped per mission): `run_python` (first-use gate), `run_sql` (read-only SQL free, writes gated), `http_request` (gated per origin — including in Deep), `run_runtime` (gated per exact command, 120s cap, mission files mounted). The **Deep preset** is enabled: 40 steps, changes and tools auto-approved inside the mission copy only; HTTP origins still require a remembered approval.

### v5.2 — GitHub Actions: the off-tab execution plane

GitHub Actions is integrated three ways, all through the browser with the same GitHub token GitHub sync already stores (Actions permission; Workflows permission only for adding workflow files). **CI panel** (pulse icon in the top bar): list a repo's workflows and recent runs, dispatch a workflow on the project's branch, auto-refresh while runs are active, and read run logs (failed jobs' log tails first) without leaving the workbench; a button commits a **starter workflow** (`.github/workflows/openforge-ci.yml` — detects Node or Python, installs, runs build/test scripts when present, dispatchable) into the repo. **Mission tool `run_ci`**: the agent pushes its mission copy to a throwaway `openforge/mission-*` branch, dispatches the named workflow, waits for the result, and on failure receives the failing log excerpts as a repair observation — real Linux verification (full toolchains, real test suites) beyond what the in-tab runtimes can do. `run_ci` is approval-gated in every preset, remembered per workflow per mission. CI logs are treated as untrusted data, never instructions. This repo also has a CI workflow (typecheck + production build) ready at `.github/workflows/ci.yml` — it must be added once through the GitHub web UI because app integrations cannot write workflow files.

### v6 — Off-tab agent: one portable engine, three places to run

Mission Mode missions can now run **off-tab**. The agent engine was ported to a portable, zero-dependency Node package in `agent/` (`agent-core.mjs` — the same JSON-action protocol, tool registry, and budgets; `runner.mjs` — the GitHub Actions entry; `server.mjs` — the companion server). The Mission setup gains an **Execution target**: *This browser* (the supervised v5 experience), *GitHub Actions* (the workbench snapshots the project onto an `openforge/agent-*` branch, dispatches the OpenForge Agent workflow — `.github/workflows/openforge-agent.yml`, which needs the repo secret `OPENROUTER_API_KEY` — and imports the results back for review and merge when the run finishes; the runner also opens a PR with the full mission report), or *Companion server* (the same engine served from your own device by `node agent/server.mjs`; missions run with full local tool access, the browser key travels per-mission and is stored nowhere). The CI panel's flow also gained a Mission-panel **Install agent** button that fetches the agent bundle from this repo and commits it into the project repo (workflow file included — your token needs the Workflows permission). Off-tab runs have no human gates by design: the throwaway branch / dedicated workspace directory is the safety boundary, `ask_user` becomes a recorded question plus a stated assumption, and everything returns through the same review-and-merge flow.

### v7 — Swarm mode: multi-agent missions + real droplets

Mission Mode grows a **multi-agent architecture**. With execution target *GitHub Actions* and **Swarm mode** checked (2–4 workers), one goal becomes a coordinated team: a **planner** agent decomposes the goal into independent, non-overlapping tasks; a **matrix of worker agents** executes them **in parallel**, each on its own branch (`openforge/swarm-<id>/w<N>`) — the parallel jobs are ephemeral cloud runners spun up per task, so there are no servers to run or pay for; an **integrator** job then merges the worker branches in order — bookkeeping collisions resolve automatically, real content conflicts get an integrator-agent resolution pass, and a worker whose branch cannot be integrated is skipped with its branch preserved. The swarm produces one integrated branch (`openforge/swarm-<id>/final`), one combined swarm report, and one pull request; the workbench imports the final branch back into the normal review-and-merge flow. New pieces: `agent/swarm-plan.mjs`, `agent/swarm-integrate.mjs`, `.github/workflows/openforge-swarm.yml` (matrix fan-out: plan → work → integrate).

And when a mission truly needs a **real cloud micro-server**, `agent/provision.mjs` provisions one on demand: `DIGITALOCEAN_TOKEN=… node agent/provision.mjs` creates the smallest DigitalOcean droplet with a cloud-init that installs Node 20, clones this repo, and boots the companion server — the command prints the `{ url, token }` to paste into the workbench's companion settings, and `--destroy <id>` tears it down. The same cloud-init works unchanged on Hetzner/Vultr VMs and hand-created Oracle Cloud Always Free instances.

### v7.1 — Multi-layer redundancy: rate limits can't kill a mission

The fallback chain grew from a single pre-flight check into a layered resilience system around one stateful **resilient caller** (`createResilientCaller` in `agent/agent-core.mjs`):

1. **Retries with backoff** — each (model, key) combination retries transient failures (429 / 5xx / network) with exponential backoff + jitter, honoring `Retry-After`, absorbing short rate windows in place.
2. **Key rotation** — rate limits are per key: add `OPENROUTER_API_KEY_2` / `_3` secrets and the caller rotates keys on the same model before abandoning it. Swarm workers each start on a different key (matrix index) and worker starts are staggered 20s apart to avoid burst caps.
3. **Mid-mission model fallback** — the fallback pool (now six models across five providers: Gemma, MiniMax, Cohere, NVIDIA, Poolside, + the free router) can take over at ANY step, not just before the first reply; the JSON action protocol is model-agnostic, so the mission continues on the new model with its history intact. The browser engine's fallback shortlist and depth (5) were widened to match.
4. **Checkpoint commits** — the runner commits + pushes after steps that change files, so a worker killed mid-mission leaves its partial work on the branch for the integrator instead of losing it.
5. **Swarm-level tolerance** (from v7) — the integrator runs even when workers fail, merges what exists, and reports per-worker status honestly.

Verified headlessly against a scripted failure stub: missions completed through injected 429 storms, a model dying mid-mission, and a permanently invalid first key — each via the intended layer.

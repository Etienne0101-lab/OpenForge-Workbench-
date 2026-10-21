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

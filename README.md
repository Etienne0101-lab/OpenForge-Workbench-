# OpenForge Workbench

A browser coding workspace inspired by OpenCode: a project file explorer, an
editor, AI chat, and a safe code-change review workflow powered by OpenRouter
free models.

This repository hosts the project originally built in Replit as
**OpenCode Router** (app: *OpenCode Workbench*, `artifacts/opencode-workbench`)
and replicates it as a live site on GitHub Pages:

**Live site:** https://etienne0101-lab.github.io/OpenForge-Workbench-/

## How the GitHub Pages version works

GitHub Pages serves static files only, so the built site in `docs/` talks to
OpenRouter **directly from the browser** instead of through the Replit
Express server:

- Model list and streaming chat call `https://openrouter.ai/api/v1` from the
  browser (free models only — the `openrouter/free` router or any `:free`
  model), with the same system prompt, file-context limits, and
  `<<<FILE ...>>>` suggestion format the server used.
- Each visitor pastes their own OpenRouter API key once. The key is stored
  only in that browser's local storage and is sent only to OpenRouter. No key
  exists in this repository.
- Projects, files, and conversations live entirely in the browser
  (IndexedDB), with ZIP import/export and optional direct access to a local
  folder via the File System Access API — exactly as in the Replit version.

## Repository layout

- `docs/` — the built static site served by GitHub Pages (with `404.html` as
  the SPA fallback). Do not edit by hand; rebuild from source instead.
- `artifacts/opencode-workbench/` — the web app (Vite + React + TypeScript).
  The static-build adaptation lives in `src/lib/openrouter.ts`.
- `artifacts/api-server/` — the original Express API server (OpenRouter
  proxy). Not used by GitHub Pages; kept for reference or self-hosting, where
  it reads `OPENROUTER_API_KEY` from the environment.
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

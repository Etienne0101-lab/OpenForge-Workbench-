/**
 * Companion inference (Context Density, Phase 4 server transport).
 *
 * Supervises a local model runtime so the workbench can get
 * abstractive file summaries from the user's own machine instead of
 * the browser's GPU:
 *
 *   1. llama.cpp (primary): the companion downloads the llama-server
 *      binary (pinned release, linux/macOS) and a GGUF model into
 *      ~/.openforge/ on first use, then runs it on loopback only.
 *   2. Ollama (fallback): if llama-server is unavailable but an
 *      Ollama daemon is already running, it is used as-is (the model
 *      must already be pulled — the status says exactly what to run).
 *   3. A fake runtime exists for tests (OPENFORGE_INFERENCE_FAKE=1).
 *
 * The summary prompt and output sanitizer MIRROR src/lib/local-model.ts
 * (buildSummaryPrompt / sanitizeSummary): summaries must read the
 * same regardless of which transport produced them, and they stay
 * pure functions of content (the browser caches them by content hash).
 */
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const INFERENCE_MODELS = {
  'qwen-1.5b': {
    label: 'Qwen 2.5 · 1.5B (recommended)',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    bytes: 1117320736,
    ollama: 'qwen2.5:1.5b',
  },
  'qwen-0.5b': {
    label: 'Qwen 2.5 · 0.5B (lightest)',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    bytes: 491400032,
    ollama: 'qwen2.5:0.5b',
  },
  'llama-1b': {
    label: 'Llama 3.2 · 1B',
    file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    bytes: 807694464,
    ollama: 'llama3.2:1b',
  },
};
export const DEFAULT_INFERENCE_MODEL = 'qwen-1.5b';

const LLAMA_RELEASE = 'b11804';
const LLAMA_ASSETS = {
  'linux-x64': 'llama-b11804-bin-ubuntu-x64.tar.gz',
  'linux-arm64': 'llama-b11804-bin-ubuntu-arm64.tar.gz',
  'darwin-arm64': 'llama-b11804-bin-macos-arm64.tar.gz',
  'darwin-x64': 'llama-b11804-bin-macos-x64.tar.gz',
};

/* ---- mirrors of the browser's summary prompt + sanitizer ---- */

export function buildSummaryPrompt(filePath, content) {
  const excerpt = content.length > 6000 ? `${content.slice(0, 4200)}\n…[middle omitted]…\n${content.slice(-1400)}` : content;
  return [
    { role: 'system', content: 'You summarize a single source file for a coding assistant. Reply with 2-3 plain sentences (max 70 words) covering: what the file is, its main exports/responsibilities, and anything notable (side effects, dependencies, generated code). No markdown, no preamble, no quotes.' },
    { role: 'user', content: `File: ${filePath}\n\n${excerpt}` },
  ];
}

export function sanitizeSummary(raw) {
  let cleaned = String(raw || '').trim().replace(/```[a-z]*|```/gi, '').trim();
  cleaned = cleaned.replace(/^summary\s*:\s*/i, '');
  if (cleaned.length >= 2 && ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, 460);
}

/* ---- downloads ---- */

async function downloadToFile(url, destination, onProgress) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  const temporary = `${destination}.part`;
  const writer = createWriteStream(temporary);
  // The error handler must exist from the first write: an unhandled
  // WriteStream 'error' event crashes the whole process, and a bare
  // catch later would leave the real reason invisible.
  const writerFailed = new Promise((resolve, reject) => { writer.once('error', reject); });
  writerFailed.catch(() => { /* surfaced via the race below */ });
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (onProgress && total > 0) onProgress(received / total);
      if (!writer.write(chunk)) await Promise.race([new Promise((resolve) => writer.once('drain', resolve)), writerFailed]);
    }
    writer.end();
    await Promise.race([new Promise((resolve) => writer.once('finish', resolve)), writerFailed]);
  } catch (error) {
    try { writer.destroy(); } catch { /* ignore */ }
    try { rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  renameSync(temporary, destination);
}

async function findLlamaServer(binDir) {
  const candidates = [process.env.LLAMA_SERVER_BIN, path.join(binDir, 'llama-server'), path.join(binDir, 'llama-b11804', 'llama-server')].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const { stdout } = await execFileAsync('which', ['llama-server']);
    const found = stdout.trim();
    if (found) return found;
  } catch { /* not on PATH */ }
  return null;
}

async function installLlamaServer(binDir, onProgress) {
  const asset = LLAMA_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) return null;
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${asset}`;
  const tarball = path.join(binDir, asset);
  await downloadToFile(url, tarball, onProgress);
  await execFileAsync('tar', ['-xzf', tarball, '-C', binDir]);
  rmSync(tarball, { force: true });
  return findLlamaServer(binDir);
}

async function ollamaReady(model) {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { running: false, hasModel: false };
    const data = await response.json();
    const names = (data.models || []).map((entry) => entry.name);
    return { running: true, hasModel: names.some((name) => name === model.ollama || name.startsWith(`${model.ollama}:`)) };
  } catch {
    return { running: false, hasModel: false };
  }
}

/* ---- manager ---- */

export function createInferenceManager(options = {}) {
  const alias = INFERENCE_MODELS[options.model] ? options.model : DEFAULT_INFERENCE_MODEL;
  const model = INFERENCE_MODELS[alias];
  const port = options.port || 8740;
  const baseDir = options.baseDir || path.join(homedir(), '.openforge');
  const modelsDir = path.join(baseDir, 'models');
  const binDir = path.join(baseDir, 'bin');
  const log = options.log || ((line) => console.log(line));
  const fake = process.env.OPENFORGE_INFERENCE_FAKE === '1';

  const state = { enabled: true, status: 'off', model: alias, runtime: null, progress: 0, detail: 'Not started.' };
  let child = null;
  let chatImpl = null;
  let stopped = false;

  async function start() {
    if (fake) {
      state.runtime = 'fake';
      state.status = 'ready';
      state.detail = 'Fake inference runtime (tests).';
      chatImpl = async () => 'This file is handled by the fake inference runtime used in tests.';
      return;
    }
    try {
      mkdirSync(modelsDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      state.status = 'starting';
      state.detail = 'Looking for a model runtime…';
      let binary = await findLlamaServer(binDir);
      if (!binary) {
        state.detail = 'Downloading the llama.cpp runtime (one-time)…';
        let installError = null;
        binary = await installLlamaServer(binDir, (fraction) => { state.progress = fraction; }).catch((error) => { installError = error; return null; });
        if (!binary && installError) log(`[inference] llama.cpp install failed: ${installError instanceof Error ? installError.message : installError}`);
        if (!binary) state.detail = `llama.cpp install failed (${installError instanceof Error ? installError.message : 'unknown error'}); checking for Ollama…`;
      }
      if (binary) {
        state.runtime = 'llama.cpp';
        const modelPath = path.join(modelsDir, model.file);
        if (!existsSync(modelPath) || statSync(modelPath).size < model.bytes * 0.98) {
          state.status = 'downloading';
          state.detail = `Downloading ${model.label} (one-time)…`;
          await downloadToFile(model.url, modelPath, (fraction) => { state.progress = fraction; });
        }
        state.status = 'starting';
        state.detail = 'Starting the model server…';
        state.progress = 0;
        child = spawn(binary, ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '8192'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrTail = '';
        child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-600); });
        child.on('exit', (code) => {
          if (!stopped && state.status === 'ready') {
            state.status = 'error';
            state.detail = `The model server exited (code ${code}). Restart the companion to retry.`;
          }
        });
        const deadline = Date.now() + 90000;
        for (;;) {
          if (Date.now() > deadline) throw new Error(`llama-server did not become healthy. ${stderrTail.slice(-200)}`);
          try {
            const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
            if (health.ok) break;
          } catch { /* not up yet */ }
          if (child.exitCode !== null) throw new Error(`llama-server exited early. ${stderrTail.slice(-200)}`);
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
        chatImpl = async (messages, options = {}) => {
          const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 140, stream: !!options.stream }),
          });
          if (options.stream) return response;
          if (!response.ok) throw new Error(`llama-server replied HTTP ${response.status}`);
          const data = await response.json();
          return data.choices?.[0]?.message?.content || '';
        };
        state.status = 'ready';
        state.detail = `Serving ${model.label} via llama.cpp on 127.0.0.1:${port}.`;
        log(`[inference] ready: ${state.detail}`);
        return;
      }
      const ollama = await ollamaReady(model);
      if (ollama.running) {
        state.runtime = 'ollama';
        if (!ollama.hasModel) {
          state.status = 'error';
          state.detail = `Ollama is running but the model is not pulled. Run: ollama pull ${model.ollama}`;
          return;
        }
        chatImpl = async (messages, options = {}) => {
          const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: model.ollama, messages, stream: false, options: { temperature: options.temperature ?? 0.2, num_predict: options.maxTokens ?? 140 } }),
          });
          if (!response.ok) throw new Error(`Ollama replied HTTP ${response.status}`);
          const data = await response.json();
          return data.message?.content || '';
        };
        state.status = 'ready';
        state.detail = `Serving ${model.label} via Ollama.`;
        log(`[inference] ready: ${state.detail}`);
        return;
      }
      state.status = 'error';
      state.detail = 'No model runtime available: llama.cpp could not be installed (unsupported platform or download failed) and Ollama is not running. Install llama.cpp (llama-server on PATH or LLAMA_SERVER_BIN) or start Ollama, then restart the companion.';
    } catch (error) {
      state.status = 'error';
      state.detail = error instanceof Error ? error.message : String(error);
      log(`[inference] failed: ${state.detail}`);
    }
  }

  /** General chat against the local runtime (the gateway's local leg). */
  async function chat(messages, options = {}) {
    if (state.status !== 'ready' || !chatImpl) {
      const error = new Error(`Local inference is not ready (${state.status}): ${state.detail}`);
      error.statusCode = 503;
      throw error;
    }
    return chatImpl(messages, options);
  }

  async function summarize(filePath, content) {
    if (state.status !== 'ready' || !chatImpl) {
      const error = new Error(`Inference is not ready (${state.status}): ${state.detail}`);
      error.statusCode = 503;
      throw error;
    }
    const raw = await chatImpl(buildSummaryPrompt(filePath, String(content || '')));
    const summary = sanitizeSummary(raw);
    if (!summary) throw new Error('The local model returned an empty summary.');
    return { summary, model: alias, runtime: state.runtime };
  }

  function stop() {
    stopped = true;
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    child = null;
  }

  return { state, start, summarize, chat, stop };
}

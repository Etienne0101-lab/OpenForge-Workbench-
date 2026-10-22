#!/usr/bin/env node
/**
 * OpenForge companion server — run the agent on YOUR OWN hardware.
 *
 *   node agent/server.mjs [--port 8737] [--host 127.0.0.1] [--token <token>]
 *
 * Zero dependencies. Missions run in ./openforge-workspaces/<id>/ on this
 * machine with full local tool access (shell, python3, network). The
 * workbench talks to it over HTTP with a shared token header; the model
 * API key is supplied per-mission by the browser (BYOK — the server stores
 * nothing). Bind to 127.0.0.1 for local use; to reach it from your phone's
 * browser, put the machine on your Tailscale network (serve it over the
 * tailnet HTTPS name) or use a Cloudflare Tunnel — see the v6 notes.
 */

import { createServer } from 'node:http';
import { createInferenceManager } from './inference.mjs';
import { createGateway } from './gateway.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMission, walkFiles } from './agent-core.mjs';

const args = process.argv.slice(2);
const argValue = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const PORT = Number(argValue('--port', process.env.OPENFORGE_PORT || 8737));
const HOST = argValue('--host', process.env.OPENFORGE_HOST || '127.0.0.1');
const TOKEN = argValue('--token', process.env.OPENFORGE_TOKEN || randomUUID());
const INFERENCE_MODEL = argValue('--inference', process.env.OPENFORGE_INFERENCE_MODEL || '');
const inference = INFERENCE_MODEL ? createInferenceManager({ model: INFERENCE_MODEL === 'on' ? undefined : INFERENCE_MODEL, log: (line) => console.log(line) }) : null;
if (inference) void inference.start();
const gateway = createGateway({ inference, log: (line) => console.log(line) });
const ROOT = path.resolve(argValue('--root', path.join(process.cwd(), 'openforge-workspaces')));

const missions = new Map();

function send(response, status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-openforge-token, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  response.end(text);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') { send(response, 204, ''); return; }
  if (url.pathname === '/health') { send(response, 200, { ok: true, service: 'openforge-companion', missions: missions.size, inference: inference ? inference.state.status : 'off' }); return; }
  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (request.headers['x-openforge-token'] !== TOKEN && bearer !== TOKEN) { send(response, 401, { error: 'Missing or wrong token (x-openforge-token header or Authorization: Bearer).' }); return; }
  try {
    if (request.method === 'GET' && url.pathname === '/') { send(response, 200, { service: 'openforge-companion', root: ROOT, hint: 'POST /missions { goal, model, apiKey, files? }' }); return; }
    if (request.method === 'GET' && url.pathname === '/gateway/status') { send(response, 200, gateway.status()); return; }
    if (request.method === 'GET' && url.pathname === '/v1/models') { send(response, 200, await gateway.listModels()); return; }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const payload = await readBody(request).catch(() => null);
      if (!payload?.messages) { send(response, 400, { error: { message: 'Expected an OpenAI chat completions body { model, messages }.' } }); return; }
      const result = await gateway.handleChat(payload);
      if (result.streamResponse) {
        response.writeHead(result.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-openforge-token, authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
        try { for await (const chunk of result.streamResponse.body) response.write(chunk); } catch { /* client went away */ }
        response.end();
        return;
      }
      send(response, result.status, result.json);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/inference/status') {
      send(response, 200, inference ? inference.state : { enabled: false, status: 'off', detail: 'Inference is not enabled on this companion. Restart it with --inference to turn it on.' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/summarize') {
      if (!inference) { send(response, 503, { error: 'Inference is not enabled on this companion. Restart it with --inference.' }); return; }
      const payload = await readBody(request).catch(() => null);
      if (!payload?.path || typeof payload.content !== 'string') { send(response, 400, { error: 'Expected { path, content }.' }); return; }
      try {
        const result = await inference.summarize(payload.path, payload.content);
        send(response, 200, result);
      } catch (error) {
        send(response, error.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/missions') {
      const body = await readBody(request);
      const missionKeys = [...(Array.isArray(body.apiKeys) ? body.apiKeys : []), body.apiKey].map((key) => String(key || '').trim()).filter(Boolean);
      if (!body.goal || !missionKeys.length || !body.model) { send(response, 400, { error: 'goal, model, and apiKey (or apiKeys) are required.' }); return; }
      const id = randomUUID().slice(0, 8);
      const workspace = path.join(ROOT, id, 'workspace');
      await mkdir(workspace, { recursive: true });
      if (Array.isArray(body.files)) {
        for (const file of body.files) {
          const rel = path.posix.normalize(String(file.path || '')).replace(/^(\.\.\/)+/, '');
          const abs = path.join(workspace, rel);
          if (!abs.startsWith(workspace) || typeof file.content !== 'string') continue;
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, file.content, 'utf8');
        }
      }
      const mission = { id, status: 'running', goal: String(body.goal), events: [], report: '', changedFiles: [], stopRequested: false, createdAt: new Date().toISOString() };
      missions.set(id, mission);
      runMission({
        root: workspace,
        goal: mission.goal,
        model: String(body.model),
        apiKeys: missionKeys,
        baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
        maxSteps: Number(body.maxSteps || 25),
        maxMinutes: Number(body.maxMinutes || 50),
        onEvent: (event) => mission.events.push(event),
        shouldStop: () => mission.stopRequested,
      }).then((result) => {
        mission.status = mission.stopRequested ? 'stopped' : result.status;
        mission.report = result.report;
        mission.changedFiles = result.changedFiles;
      }).catch((error) => {
        mission.status = 'failed';
        mission.report = error instanceof Error ? error.message : 'Mission crashed.';
      });
      send(response, 201, { id, status: mission.status });
      return;
    }
    const missionMatch = /^\/missions\/([a-z0-9-]+)(\/files|\/stop)?$/.exec(url.pathname);
    if (missionMatch) {
      const mission = missions.get(missionMatch[1]);
      if (!mission) { send(response, 404, { error: 'No such mission.' }); return; }
      if (request.method === 'POST' && missionMatch[2] === '/stop') { mission.stopRequested = true; send(response, 200, { id: mission.id, status: mission.status }); return; }
      if (request.method === 'GET' && missionMatch[2] === '/files') {
        const workspace = path.join(ROOT, mission.id, 'workspace');
        const names = await walkFiles(workspace);
        const files = [];
        for (const rel of names) {
          const content = await readFile(path.join(workspace, rel), 'utf8').catch(() => null);
          if (content !== null && !content.includes('\0')) files.push({ path: rel, content });
        }
        // walkFiles skips .openforge by design — but the learning artifacts
        // (model stats, skill library) MUST travel back to the browser or
        // the persistent-memory loop breaks on the companion path.
        const learningPaths = ['.openforge/model-stats.json', '.openforge/skills/index.json'];
        try {
          const skillFiles = await readdir(path.join(workspace, '.openforge', 'skills'));
          for (const name of skillFiles) if (name.endsWith('.md')) learningPaths.push(`.openforge/skills/${name}`);
        } catch { /* no library yet */ }
        for (const rel of learningPaths) {
          if (files.some((file) => file.path === rel)) continue;
          const content = await readFile(path.join(workspace, rel), 'utf8').catch(() => null);
          if (content !== null) files.push({ path: rel, content });
        }
        send(response, 200, { id: mission.id, files });
        return;
      }
      if (request.method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0);
        send(response, 200, { id: mission.id, status: mission.status, goal: mission.goal, report: mission.report, changedFiles: mission.changedFiles, events: mission.events.slice(since), eventCount: mission.events.length });
        return;
      }
    }
    send(response, 404, { error: 'Unknown route.' });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : 'Server error.' });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { inference?.stop(); } catch { /* ignore */ } process.exit(0); });
}
server.listen(PORT, HOST, () => {
  console.log(`OpenForge companion listening on http://${HOST}:${PORT}`);
  console.log(`Workspaces: ${ROOT}`);
  console.log(`Token (paste into the workbench Companion settings): ${TOKEN}`);
});

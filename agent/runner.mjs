#!/usr/bin/env node
/**
 * OpenForge agent — GitHub Actions runner.
 *
 * Invoked by .github/workflows/openforge-agent.yml on a mission branch.
 * Runs the mission in the checkout, writes the report into .openforge/,
 * commits everything back to the same branch, and (best effort) opens a
 * pull request to the base branch so a human can review and merge.
 *
 * Env: MISSION_GOAL (required), OPENROUTER_API_KEY (required, from repo
 * secrets), AGENT_MODEL, AGENT_MAX_STEPS, AGENT_MAX_MINUTES,
 * AGENT_BASE_BRANCH (PR target, default main), OPENROUTER_BASE_URL.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMission } from './agent-core.mjs';

function sh(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: process.cwd(), shell: false, timeout: 120000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const goal = process.env.MISSION_GOAL;
// Multi-key redundancy: OPENROUTER_API_KEYS (comma/newline separated) or
// the single OPENROUTER_API_KEY. Rate limits are per key, so the resilient
// caller rotates keys before it ever switches models.
const apiKeys = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '').split(/[\n,]/).map((key) => key.trim()).filter(Boolean);
const explicitKeyIndex = process.env.AGENT_KEY_INDEX !== undefined ? Number(process.env.AGENT_KEY_INDEX) : null;
if (!goal) { console.error('MISSION_GOAL is required.'); process.exit(2); }
if (!apiKeys.length) { console.error('OPENROUTER_API_KEY secret is not set for this repository.'); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
console.log(`OpenForge agent mission in ${root}`);
console.log(`Goal: ${goal}`);

// Quota calibration (Phase 2): ask OpenRouter what budget each key
// actually has left today, log the tiers, and — unless a start key was
// pinned (swarm stagger) — begin on the key with the most budget.
const { calibrateKeys, describeKeyInfo, pickStartKeyIndex } = await import('./quota.mjs');
const keyInfos = await calibrateKeys(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', apiKeys);
keyInfos.forEach((info, index) => console.log(`[quota] ${describeKeyInfo(info, index)}`));
const keyIndex = explicitKeyIndex ?? pickStartKeyIndex(keyInfos);

const branch = process.env.AGENT_BRANCH || process.env.GITHUB_REF_NAME || '';
let checkpointedFiles = 0;
let checkpointBusy = false;
const result = await runMission({
  root,
  goal,
  model: process.env.AGENT_MODEL || 'minimax/minimax-m3.1-flash:free',
  apiKeys,
  keyIndex,
  baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  context: process.env.AGENT_CONTEXT || undefined,
  maxSteps: Number(process.env.AGENT_MAX_STEPS || 25),
  maxMinutes: Number(process.env.AGENT_MAX_MINUTES || 50),
  onEvent: (event) => console.log(`[${event.type}] ${event.text}`),
  // Checkpoint commits: if this job is killed, timed out, or rate-capped
  // to death mid-mission, the work already done is on the branch for the
  // integrator (or a human) instead of dying with the runner.
  onCheckpoint: async ({ changedFiles }) => {
    if (!branch || checkpointBusy || changedFiles.length <= checkpointedFiles) return;
    checkpointBusy = true;
    try {
      await sh('git', ['add', '-A']);
      const commit = await sh('git', ['commit', '-m', `OpenForge checkpoint: ${changedFiles.length} file(s) changed (mission in progress)`]);
      if (commit.code === 0) {
        await sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], 120000);
        checkpointedFiles = changedFiles.length;
        console.log(`[checkpoint] committed ${changedFiles.length} changed file(s)`);
      }
    } catch { /* a failed checkpoint is retried at the next step */ }
    checkpointBusy = false;
  },
});

await mkdir(path.join(root, '.openforge'), { recursive: true });
await writeFile(path.join(root, '.openforge', 'mission-report.md'), result.report, 'utf8');
await writeFile(path.join(root, '.openforge', 'mission-state.json'), JSON.stringify({ status: result.status, changedFiles: result.changedFiles, verifications: result.verifications, events: result.events.slice(-200) }, null, 2), 'utf8');
console.log(`Mission ${result.status}. Changed files: ${result.changedFiles.length}`);

await sh('git', ['config', 'user.name', 'OpenForge Agent']);
await sh('git', ['config', 'user.email', 'agent@openforge.local']);
await sh('git', ['add', '-A']);
const commit = await sh('git', ['commit', '-m', `OpenForge agent mission: ${goal.slice(0, 72)}`]);
console.log(commit.stdout || commit.stderr);
const push = await sh('git', ['push', 'origin', 'HEAD:refs/heads/' + branch]);
console.log(push.stdout || push.stderr);
if (push.code !== 0) { console.error('git push failed — results remain in the run workspace only.'); process.exit(1); }

const baseBranch = process.env.AGENT_BASE_BRANCH || 'main';
if (process.env.AGENT_NO_PR === '1') {
  console.log('AGENT_NO_PR=1 — skipping pull request (a coordinator will integrate this branch).');
} else if (branch && branch !== baseBranch) {
  const pr = await sh('gh', ['pr', 'create', '--title', `OpenForge mission: ${goal.slice(0, 60)}`, '--body-file', path.join(root, '.openforge', 'mission-report.md'), '--base', baseBranch, '--head', branch], { env: { ...process.env } });
  console.log(pr.code === 0 ? `Pull request opened: ${pr.stdout.trim()}` : `PR not opened (gh said: ${(pr.stderr || pr.stdout).trim().slice(0, 200)}). The mission branch is pushed; open the PR from GitHub or import the branch in the workbench.`);
}
process.exit(0);

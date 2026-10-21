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
const apiKey = process.env.OPENROUTER_API_KEY;
if (!goal) { console.error('MISSION_GOAL is required.'); process.exit(2); }
if (!apiKey) { console.error('OPENROUTER_API_KEY secret is not set for this repository.'); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
console.log(`OpenForge agent mission in ${root}`);
console.log(`Goal: ${goal}`);

const result = await runMission({
  root,
  goal,
  model: process.env.AGENT_MODEL || 'google/gemma-4-26b-a4b-it:free',
  apiKey,
  baseUrl: process.env.OPENROUTER_BASE_URL || undefined,
  maxSteps: Number(process.env.AGENT_MAX_STEPS || 25),
  maxMinutes: Number(process.env.AGENT_MAX_MINUTES || 50),
  onEvent: (event) => console.log(`[${event.type}] ${event.text}`),
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
const push = await sh('git', ['push', 'origin', 'HEAD']);
console.log(push.stdout || push.stderr);
if (push.code !== 0) { console.error('git push failed — results remain in the run workspace only.'); process.exit(1); }

const baseBranch = process.env.AGENT_BASE_BRANCH || 'main';
const branch = process.env.GITHUB_REF_NAME || '';
if (branch && branch !== baseBranch) {
  const pr = await sh('gh', ['pr', 'create', '--title', `OpenForge mission: ${goal.slice(0, 60)}`, '--body-file', path.join(root, '.openforge', 'mission-report.md'), '--base', baseBranch, '--head', branch], { env: { ...process.env } });
  console.log(pr.code === 0 ? `Pull request opened: ${pr.stdout.trim()}` : `PR not opened (gh said: ${(pr.stderr || pr.stdout).trim().slice(0, 200)}). The mission branch is pushed; open the PR from GitHub or import the branch in the workbench.`);
}
process.exit(0);

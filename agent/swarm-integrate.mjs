#!/usr/bin/env node
/**
 * OpenForge swarm integrator — the coordinator.
 *
 * Runs after the worker matrix finishes, on a checkout of the swarm base
 * branch. Discovers the worker branches (openforge/swarm-<id>/w<N>),
 * merges them one by one, and — when a merge conflicts and a model key
 * is available — gives an integrator agent one pass at resolving the
 * conflict in place. Writes a combined swarm report, pushes the result
 * to openforge/swarm-<id>/final, and opens a single pull request.
 *
 * Env: SWARM_ID (required), SWARM_GOAL, AGENT_BASE_BRANCH (PR target,
 * default main), OPENROUTER_API_KEY + AGENT_MODEL (conflict pass),
 * OPENROUTER_BASE_URL, GH_TOKEN (PR creation).
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runMission } from './agent-core.mjs';
import { loadStats, mergeStats, saveStats } from './model-router.mjs';
import { rebuildSkillsIndex } from './skills.mjs';

const swarmId = process.env.SWARM_ID;
if (!swarmId) { console.error('SWARM_ID is required.'); process.exit(2); }
const root = process.cwd();
const baseBranch = process.env.AGENT_BASE_BRANCH || 'main';

function sh(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: root, timeout: 300000, maxBuffer: 8_000_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const git = (...args) => sh('git', args);

await git('config', 'user.name', 'OpenForge Swarm');
await git('config', 'user.email', 'swarm@openforge.local');
await git('fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*');

const remote = await git('ls-remote', '--heads', 'origin');
const prefix = `openforge/swarm-${swarmId}/w`;
const workerBranches = remote.stdout.split('\n')
  .map((line) => line.split('\t')[1]?.replace('refs/heads/', '') || '')
  .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
  .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
console.log(`Worker branches: ${workerBranches.join(', ') || '(none)'}`);

// Snapshot the base learning state BEFORE merging: afterwards the tree
// holds whichever worker won the bookkeeping auto-resolve, and seeding
// from it would double-count that worker.
const preMergeStats = await loadStats(root);
const outcomes = [];
for (const branch of workerBranches) {
  let missionState = null;
  const stateRead = await git('show', `origin/${branch}:.openforge/mission-state.json`);
  if (stateRead.code === 0) { try { missionState = JSON.parse(stateRead.stdout); } catch { /* state optional */ } }
  const summary = {
    branch,
    status: missionState?.status || 'unknown',
    changedFiles: missionState?.changedFiles || [],
    verifications: (missionState?.verifications || []).length,
  };
  const merge = await git('merge', '--no-edit', `origin/${branch}`);
  if (merge.code === 0) {
    outcomes.push({ ...summary, merge: 'merged cleanly' });
    console.log(`✓ ${branch} merged cleanly`);
    continue;
  }
  const allConflicted = (await git('diff', '--name-only', '--diff-filter=U')).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  // Bookkeeping files (.openforge/*) collide by design — every worker writes
  // its own state to the same path. The report reads worker state from the
  // branches themselves, so take the incoming worker's version and move on.
  const stateConflicts = allConflicted.filter((file) => file.startsWith('.openforge/'));
  for (const file of stateConflicts) { await git('checkout', '--theirs', '--', file); await git('add', '--', file); }
  const conflicted = allConflicted.filter((file) => !file.startsWith('.openforge/'));
  if (!conflicted.length) {
    const commit = await git('commit', '--no-edit');
    outcomes.push({ ...summary, merge: 'merged (bookkeeping files auto-resolved)' });
    console.log(`✓ ${branch} merged — only bookkeeping conflicts, auto-resolved (${commit.code})`);
    continue;
  }
  console.log(`✗ ${branch} conflicts in: ${conflicted.join(', ')}`);
  if (process.env.OPENROUTER_API_KEY && conflicted.length) {
    console.log('  Running the integrator agent on the conflict…');
    const goal = `Resolve the git merge conflicts left by merging branch ${branch} into the swarm integration branch. The conflicted files contain <<<<<<< / ======= / >>>>>>> markers. Produce the correct combined content for each conflicted file: keep BOTH sides' intended changes where they are compatible; when they truly conflict, prefer the version that keeps the codebase working and note the decision. Verify no conflict markers remain (search_code for "<<<<<<<") and, if the project has an obvious check (npm test / build), run it.`;
    const result = await runMission({ root, goal, model: process.env.AGENT_MODEL || 'nvidia/nemotron-3.5-lightning:free', apiKey: process.env.OPENROUTER_API_KEY, baseUrl: process.env.OPENROUTER_BASE_URL || undefined, maxSteps: 14, maxMinutes: 20, onEvent: (event) => console.log(`  [integrator:${event.type}] ${event.text}`) });
    // Staging is what marks a written file as "conflict resolved" in git.
    await git('add', '-A');
    const markers = await sh('grep', ['-rl', '<<<<<<<', '--exclude-dir=.git', '--exclude-dir=node_modules', '.']);
    if (!markers.stdout.trim()) {
      const commit = await git('commit', '--no-edit');
      outcomes.push({ ...summary, merge: `conflict resolved by the integrator agent (${result.status})` });
      console.log(`  ✓ conflict resolved and committed (${commit.code})`);
      continue;
    }
    console.log('  Integrator could not fully resolve the conflict — aborting this worker merge.');
  }
  await git('merge', '--abort');
  outcomes.push({ ...summary, merge: 'SKIPPED — merge conflict could not be resolved; the worker branch is preserved for manual review' });
}

// v8: merge the swarm's collective learning — model statistics from every
// worker branch combined into one brain, and the skills index rebuilt
// from the merged library so the final branch is self-consistent.
try {
  let mergedStats = preMergeStats;
  for (const branch of workerBranches) {
    const read = await git('show', `origin/${branch}:.openforge/model-stats.json`);
    if (read.code === 0) { try { mergedStats = mergeStats(mergedStats, JSON.parse(read.stdout)); } catch { /* partial stats are fine */ } }
  }
  await saveStats(root, mergedStats);
  await rebuildSkillsIndex(root);
  console.log('Learning merged: model statistics combined across workers; skills index rebuilt.');
} catch { /* learning merge is best-effort */ }

const mergedCount = outcomes.filter((outcome) => outcome.merge.startsWith('merged') || outcome.merge.startsWith('conflict resolved')).length;
const report = [
  '# Swarm report', '',
  `**Goal:** ${process.env.SWARM_GOAL || '(not recorded)'}`,
  `**Workers:** ${outcomes.length} · **Integrated:** ${mergedCount}`, '',
  '## Worker outcomes', '',
  ...outcomes.flatMap((outcome) => [
    `### ${outcome.branch}`,
    `- Mission status: ${outcome.status}`,
    `- Merge: ${outcome.merge}`,
    `- Verifications recorded: ${outcome.verifications}`,
    `- Files changed: ${outcome.changedFiles.length ? outcome.changedFiles.join(', ') : '(none)'}`,
    '',
  ]),
  outcomes.some((outcome) => outcome.merge.startsWith('SKIPPED')) ? 'Workers marked SKIPPED kept their branches — review and merge them manually if their work is wanted.' : 'All worker results were integrated into this branch.',
].join('\n');
await git('rm', '-q', '--ignore-unmatch', '.openforge/mission-state.json');
await mkdir(path.join(root, '.openforge'), { recursive: true });
await writeFile(path.join(root, '.openforge', 'swarm-report.md'), report, 'utf8');
console.log(report);
await git('add', '-A');
await git('commit', '-m', `OpenForge swarm ${swarmId}: integrate ${mergedCount}/${outcomes.length} workers`);
const finalBranch = `openforge/swarm-${swarmId}/final`;
const push = await git('push', 'origin', `HEAD:refs/heads/${finalBranch}`);
console.log(push.stdout || push.stderr);
if (push.code !== 0) { console.error('Push of the final branch failed.'); process.exit(1); }
const pr = await sh('gh', ['pr', 'create', '--title', `OpenForge swarm: ${(process.env.SWARM_GOAL || swarmId).slice(0, 60)}`, '--body-file', path.join(root, '.openforge', 'swarm-report.md'), '--base', baseBranch, '--head', finalBranch]);
console.log(pr.code === 0 ? `Pull request opened: ${pr.stdout.trim()}` : `PR not opened (gh said: ${(pr.stderr || pr.stdout).trim().slice(0, 200)}). The final branch ${finalBranch} is pushed.`);

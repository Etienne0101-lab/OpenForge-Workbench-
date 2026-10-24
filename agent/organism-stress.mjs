#!/usr/bin/env node
/**
 * OpenForge organism stress test — grow/reproduce widening (2026-10-24).
 *
 * Run: node agent/organism-stress.mjs
 *
 * Covers, in order:
 *  1. Scheduler-safe cycle: grow writes directives (organism.json +
 *     directives.json mirror) and reproduce writes immutable replication
 *     files — while model-stats.json and the shared skill library are
 *     byte-identical before/after (the old code wrote both).
 *  2. Directives actually steer the router (+0.12 for a priority model
 *     in a directed class, from organism files alone, stats.organism
 *     absent).
 *  3. Replications are visible to the next mission: listSkills and
 *     searchSkills return them, and recordSkillOutcomes bumps their
 *     manifest counters without touching index.json.
 *  4. Idempotence: a second cycle adds no duplicate proposals and no
 *     duplicate replication files; cycle and history advance.
 *  5. Dormancy: under rate pressure grow/reproduce stand down; when
 *     pressure clears the cycle wakes and reproduces.
 *  6. mergeOrganismState + the merge-state CLI: two divergent organism
 *     states union proposals, history, and replications with no loss.
 *  7. Real git: a scheduler tick (organism paths only) and a mission
 *     branch (stats + skills only) merge with zero conflicts and zero
 *     data loss; a divergent organism.json conflict is resolved by
 *     merge-state and also loses nothing.
 *
 * Exits non-zero on the first failed assertion, printing the check name.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrganism, loadOrganismDirectives, mergeOrganismState, runOrganismCycle } from './organism.mjs';
import { ModelRouter, PRIORITY_MODELS } from './model-router.mjs';
import { listOrganismReplications, listSkills, recordSkillOutcomes, searchSkills } from './skills.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MINI = PRIORITY_MODELS[0];
const NEMO = PRIORITY_MODELS[1];
let passed = 0;
function check(name, condition, extra = '') {
  if (!condition) { console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ''}`); process.exit(1); }
  passed += 1;
  console.log(`ok ${passed}. ${name}`);
}
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const hashTree = async (dir) => {
  const out = {};
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[path.relative(dir, full)] = await hashFile(full);
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
};
const sh = (cwd, command, args) => new Promise((resolve) => {
  execFile(command, args, { cwd }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const git = (cwd, ...args) => sh(cwd, 'git', args);

function seedStats() {
  return {
    version: 1, updatedAt: Date.now(), arms: {
      [`${MINI}|docs`]: { pulls: 20, ok: 10, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 },
      [`${NEMO}|docs`]: { pulls: 15, ok: 14, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 },
      [`${MINI}|data`]: { pulls: 12, ok: 4, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 },
    },
    pressure: {},
  };
}
async function seedWorkspace(root, { pressure = false } = {}) {
  const stats = seedStats();
  if (pressure) {
    const future = Date.now() + 1_000_000_000;
    for (const model of PRIORITY_MODELS.slice(0, 3)) stats.pressure[model] = { window: [], cooldownUntil: future };
  }
  await mkdir(path.join(root, '.openforge', 'skills'), { recursive: true });
  await writeFile(path.join(root, '.openforge', 'model-stats.json'), JSON.stringify(stats, null, 2));
  const proven = '---\nname: API error handling\ntags: api, errors\ntask_classes: docs\n---\n\nRetry with backoff; log the status code.\n';
  const dead = '---\nname: Stale pattern\ntags: stale\ntask_classes: docs\n---\n\nNever use this again.\n';
  await writeFile(path.join(root, '.openforge', 'skills', 'api-error-handling.md'), proven);
  await writeFile(path.join(root, '.openforge', 'skills', 'stale-pattern.md'), dead);
  await writeFile(path.join(root, '.openforge', 'skills', 'index.json'), JSON.stringify({ version: 1, skills: [
    { slug: 'api-error-handling', name: 'API error handling', tags: ['api', 'errors'], taskClasses: ['docs'], excerpt: 'Retry with backoff', uses: 5, successes: 4 },
    { slug: 'stale-pattern', name: 'Stale pattern', tags: ['stale'], taskClasses: ['docs'], excerpt: 'Never use', uses: 6, successes: 0 },
  ] }, null, 2));
  return stats;
}

/* ---------- 1–4: scheduler-safe cycle ---------- */
const root = await mkdtemp(path.join(os.tmpdir(), 'organism-stress-'));
await seedWorkspace(root);
const statsBefore = await hashFile(path.join(root, '.openforge', 'model-stats.json'));
const skillsBefore = await hashTree(path.join(root, '.openforge', 'skills'));
const cycle1 = await runOrganismCycle(root, { log: () => {}, schedulerSafe: true });
check('cycle 1 completes awake', cycle1.cycle === 1 && !cycle1.dormant, JSON.stringify(cycle1));
check('model-stats.json untouched by a scheduler-safe cycle', (await hashFile(path.join(root, '.openforge', 'model-stats.json'))) === statsBefore);
const skillsAfter = await hashTree(path.join(root, '.openforge', 'skills'));
check('shared skill library untouched by a scheduler-safe cycle', JSON.stringify(skillsAfter) === JSON.stringify(skillsBefore));
const state1 = await loadOrganism(root);
check('grow wrote directives into organism state', state1.directives.exploreClasses.includes('docs'), JSON.stringify(state1.directives));
const mirror = JSON.parse(await readFile(path.join(root, '.openforge', 'organism', 'directives.json'), 'utf8'));
check('directives mirror matches organism state', JSON.stringify(mirror.exploreClasses) === JSON.stringify(state1.directives.exploreClasses));
check('mutate produced challenger + weak-class + skill-gap proposals', cycle1.proposals.length === 3, JSON.stringify(cycle1.proposals.map((p) => p.kind)));
check('replication manifest records the docs skill propagated to data', state1.replications.some((r) => r.sourceSlug === 'api-error-handling' && r.targetClass === 'data'), JSON.stringify(state1.replications));
const repFiles = await readdir(path.join(root, '.openforge', 'organism', 'replications'));
check('exactly one immutable replication file was written', repFiles.length === 1 && repFiles[0] === 'replicated-api-error-handling-to-data-c1.md', repFiles.join(','));
check('dead skill queued as archive candidate, not moved', state1.archiveCandidates.some((c) => c.slug === 'stale-pattern') && existsSync(path.join(root, '.openforge', 'skills', 'stale-pattern.md')));
check('vitals count the replication', state1.vitals.replications === 1);

/* ---------- 2: router steering from organism files alone ---------- */
const directives = await loadOrganismDirectives(root);
check('loadOrganismDirectives reads organism files', directives.exploreClasses.includes('docs'));
const router = new ModelRouter({ stats: { version: 1, updatedAt: 0, arms: {}, pressure: {} }, catalogIds: [MINI], organismDirectives: directives.exploreClasses });
const directed = router.score(MINI, 'docs', 0);
const undirected = router.score(MINI, 'web', 0);
check('router boosts a priority model by exactly 0.12 in a directed class', Math.abs((directed - undirected) - 0.12) < 1e-9, `${directed} vs ${undirected}`);

/* ---------- 3: replications visible to the next mission ---------- */
const allSkills = await listSkills(root);
check('listSkills merges the replication', allSkills.some((s) => s.slug === 'replicated-api-error-handling-to-data-c1' && s.source === 'organism-replication'));
const found = await searchSkills(root, 'api error handling retry', 'data', 3);
check('searchSkills finds the replication for its sibling class', found.some((s) => s.slug === 'replicated-api-error-handling-to-data-c1' && s.body.includes('Retry with backoff')), JSON.stringify(found.map((s) => s.slug)));
const indexBefore = await hashFile(path.join(root, '.openforge', 'skills', 'index.json'));
await recordSkillOutcomes(root, ['replicated-api-error-handling-to-data-c1'], true);
const stateAfterOutcome = await loadOrganism(root);
const repRecord = stateAfterOutcome.replications.find((r) => r.slug === 'replicated-api-error-handling-to-data-c1');
check('replication outcome bumps the manifest, not index.json', repRecord.uses === 1 && repRecord.successes === 1 && (await hashFile(path.join(root, '.openforge', 'skills', 'index.json'))) === indexBefore);

/* ---------- 4: idempotence ---------- */
const cycle2 = await runOrganismCycle(root, { log: () => {}, schedulerSafe: true });
const state2 = await loadOrganism(root);
check('cycle advances and history accumulates', cycle2.cycle === 2 && state2.history.length === 2);
check('second cycle adds no duplicate proposals', cycle2.proposals.length === 3);
const repFiles2 = await readdir(path.join(root, '.openforge', 'organism', 'replications'));
check('second cycle adds no duplicate replication files', repFiles2.length === 1);
check('replication manifest still has exactly one entry', state2.replications.length === 1);

/* ---------- 5: dormancy ---------- */
const dormantRoot = await mkdtemp(path.join(os.tmpdir(), 'organism-dormant-'));
await seedWorkspace(dormantRoot, { pressure: true });
// Dormancy is set by the dormancy phase, which runs AFTER grow/mutate/
// reproduce in a cycle — so the first pressured cycle enters dormancy,
// and the NEXT cycle is the one that stands those phases down.
const dormantCycle = await runOrganismCycle(dormantRoot, { log: () => {}, schedulerSafe: true });
const dormantState = await loadOrganism(dormantRoot);
check('pressured cycle enters dormancy', dormantState.dormant === true, JSON.stringify({ dormant: dormantState.dormant }));
const dormantDirectives = [...dormantState.directives.exploreClasses];
const dormantReplications = dormantState.replications.length;
await runOrganismCycle(dormantRoot, { log: () => {}, schedulerSafe: true });
const stillDormant = await loadOrganism(dormantRoot);
check('dormant cycle stands grow/reproduce down', stillDormant.dormant === true && stillDormant.replications.length === dormantReplications && JSON.stringify(stillDormant.directives.exploreClasses) === JSON.stringify(dormantDirectives), JSON.stringify({ replications: stillDormant.replications.length, directives: stillDormant.directives.exploreClasses }));
const statsPath = path.join(dormantRoot, '.openforge', 'model-stats.json');
const dormantStats = JSON.parse(await readFile(statsPath, 'utf8'));
for (const model of Object.keys(dormantStats.pressure)) dormantStats.pressure[model].cooldownUntil = 0;
await writeFile(statsPath, JSON.stringify(dormantStats, null, 2));
const woken = await runOrganismCycle(dormantRoot, { log: () => {}, schedulerSafe: true });
const wokenState = await loadOrganism(dormantRoot);
check('cycle wakes when pressure clears and then reproduces', !wokenState.dormant && wokenState.replications.length === 1, JSON.stringify({ dormant: wokenState.dormant, replications: wokenState.replications.length }));

/* ---------- 6: mergeOrganismState + CLI ---------- */
const sideA = { version: 1, cycle: 1, phase: 'recycle', dormant: false, updatedAt: 1000, vitals: { health: 70, totalPulls: 10, totalOk: 7, skillCount: 2, provenSkills: 1, mutations: 1, replications: 1 }, directives: { exploreClasses: ['docs'], updatedAt: 1000 }, proposals: [{ id: 'weak-class:data', kind: 'weak-class', title: 'Weak task class: data', detail: 'd', createdAt: 900, status: 'open' }], history: [{ cycle: 1, at: 1000, summary: 'a' }], replications: [{ slug: 'rep-a', sourceSlug: 's', targetClass: 'data', cycle: 1, createdAt: 900, uses: 2, successes: 1 }], archiveCandidates: [] };
const sideB = { version: 1, cycle: 2, phase: 'recycle', dormant: false, updatedAt: 2000, vitals: { health: 71, totalPulls: 20, totalOk: 14, skillCount: 3, provenSkills: 1, mutations: 2, replications: 1 }, directives: { exploreClasses: ['web'], updatedAt: 2000 }, proposals: [{ id: 'challenger:x', kind: 'challenger', title: 'Challenger', detail: 'd', createdAt: 1900, status: 'open' }, { id: 'weak-class:data', kind: 'weak-class', title: 'Weak task class: data', detail: 'd', createdAt: 900, status: 'stale' }], history: [{ cycle: 2, at: 2000, summary: 'b' }], replications: [{ slug: 'rep-b', sourceSlug: 's2', targetClass: 'web', cycle: 2, createdAt: 1900, uses: 0, successes: 0 }, { slug: 'rep-a', sourceSlug: 's', targetClass: 'data', cycle: 1, createdAt: 900, uses: 5, successes: 3 }], archiveCandidates: [{ slug: 'dead-1', name: 'Dead', uses: 6, successes: 0, detectedAt: 1900 }] };
const merged = mergeOrganismState(sideA, sideB);
check('merge unions proposals with open beating stale', merged.proposals.length === 2 && merged.proposals.find((p) => p.id === 'weak-class:data').status === 'open');
check('merge unions history and takes the newer directives', merged.history.length === 2 && merged.cycle === 2 && merged.directives.exploreClasses.includes('web'));
check('merge unions replications and takes max counters', merged.replications.length === 2 && merged.replications.find((r) => r.slug === 'rep-a').uses === 5 && merged.replications.find((r) => r.slug === 'rep-a').successes === 3);
const mergeDir = await mkdtemp(path.join(os.tmpdir(), 'organism-merge-'));
await writeFile(path.join(mergeDir, 'ours.json'), JSON.stringify(sideA));
await writeFile(path.join(mergeDir, 'theirs.json'), JSON.stringify(sideB));
const cli = await sh(mergeDir, process.execPath, [path.join(HERE, 'organism.mjs'), 'merge-state', path.join(mergeDir, 'ours.json'), path.join(mergeDir, 'theirs.json'), path.join(mergeDir, 'out.json')]);
check('merge-state CLI exits cleanly and writes a merged file', cli.code === 0 && existsSync(path.join(mergeDir, 'out.json')), cli.stderr.slice(0, 200));
const cliMerged = JSON.parse(await readFile(path.join(mergeDir, 'out.json'), 'utf8'));
check('CLI merge preserves both sides', cliMerged.proposals.length === 2 && cliMerged.replications.length === 2);

/* ---------- 7: real git — tick vs mission, then divergent organism ---------- */
const repo = await mkdtemp(path.join(os.tmpdir(), 'organism-git-'));
await git(repo, 'init', '-b', 'main');
await git(repo, 'config', 'user.name', 'Stress Test');
await git(repo, 'config', 'user.email', 'stress@test.local');
await seedWorkspace(repo);
await writeFile(path.join(repo, '.openforge', 'organism.json'), JSON.stringify({ version: 1, cycle: 0, phase: 'initialize', dormant: false, updatedAt: 0, vitals: { health: null, totalPulls: 0, totalOk: 0, skillCount: 0, provenSkills: 0, mutations: 0, replications: 0 }, directives: { exploreClasses: [], updatedAt: 0 }, proposals: [], history: [], replications: [], archiveCandidates: [] }, null, 2));
await git(repo, 'add', '-A');
await git(repo, 'commit', '-m', 'base');
await git(repo, 'checkout', '-b', 'mission');
const missionStats = JSON.parse(await readFile(path.join(repo, '.openforge', 'model-stats.json'), 'utf8'));
missionStats.arms[`${MINI}|web`] = { pulls: 3, ok: 3, rl: 0, err: 0, latencyEmaMs: 0, lastUsedAt: 0, lastRateLimitAt: 0 };
await writeFile(path.join(repo, '.openforge', 'model-stats.json'), JSON.stringify(missionStats, null, 2));
await writeFile(path.join(repo, '.openforge', 'skills', 'mission-skill.md'), '---\nname: Mission skill\ntags: mission\ntask_classes: web\n---\n\nFrom the mission.\n');
const missionIndex = JSON.parse(await readFile(path.join(repo, '.openforge', 'skills', 'index.json'), 'utf8'));
missionIndex.skills.push({ slug: 'mission-skill', name: 'Mission skill', tags: ['mission'], taskClasses: ['web'], excerpt: 'From the mission', uses: 0, successes: 0 });
await writeFile(path.join(repo, '.openforge', 'skills', 'index.json'), JSON.stringify(missionIndex, null, 2));
await git(repo, 'add', '-A');
await git(repo, 'commit', '-m', 'mission: stats + skill');
await git(repo, 'checkout', 'main');
await runOrganismCycle(repo, { log: () => {}, schedulerSafe: true });
await git(repo, 'add', '.openforge/organism.json', '.openforge/organism');
await git(repo, 'commit', '-m', '[openforge-scheduler] state update');
const merge1 = await git(repo, 'merge', '--no-edit', 'mission');
check('tick and mission branches merge with zero conflicts', merge1.code === 0, merge1.stdout.slice(0, 300) + merge1.stderr.slice(0, 300));
const mergedStats = JSON.parse(await readFile(path.join(repo, '.openforge', 'model-stats.json'), 'utf8'));
const mergedOrganism = JSON.parse(await readFile(path.join(repo, '.openforge', 'organism.json'), 'utf8'));
check('merge keeps the mission arm AND the organism cycle', Boolean(mergedStats.arms[`${MINI}|web`]) && mergedOrganism.cycle === 1 && mergedOrganism.replications.length === 1);
check('merge keeps the mission skill file', existsSync(path.join(repo, '.openforge', 'skills', 'mission-skill.md')));
// Divergent organism: both sides run a cycle from the same base.
await git(repo, 'checkout', '-b', 'org-a');
await runOrganismCycle(repo, { log: () => {}, schedulerSafe: true });
await git(repo, 'add', '.openforge/organism.json', '.openforge/organism');
await git(repo, 'commit', '-m', 'org-a cycle');
await git(repo, 'checkout', 'main');
await runOrganismCycle(repo, { log: () => {}, schedulerSafe: true });
await git(repo, 'add', '.openforge/organism.json', '.openforge/organism');
await git(repo, 'commit', '-m', 'main cycle');
const merge2 = await git(repo, 'merge', '--no-edit', 'org-a');
if (merge2.code !== 0) {
  // Workflow fallback, exercised for real: merge organism.json by
  // merge-state, regenerate the directives mirror from the merged
  // directives, and complete the merge.
  const conflicted = (await git(repo, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  check('divergent organism merge conflicts only on organism paths', conflicted.length > 0 && conflicted.every((f) => f.startsWith('.openforge/organism')), conflicted.join(','));
  await sh(repo, 'git', ['show', ':2:.openforge/organism.json']);
  const ours = await (async () => { const r = await sh(repo, 'git', ['show', ':2:.openforge/organism.json']); return JSON.parse(r.stdout); })();
  const theirs = await (async () => { const r = await sh(repo, 'git', ['show', ':3:.openforge/organism.json']); return JSON.parse(r.stdout); })();
  const resolved = mergeOrganismState(ours, theirs);
  await writeFile(path.join(repo, '.openforge', 'organism.json'), JSON.stringify(resolved, null, 2));
  await writeFile(path.join(repo, '.openforge', 'organism', 'directives.json'), JSON.stringify({ ...resolved.directives, source: 'organism-grow' }, null, 2));
  await git(repo, 'add', '-A');
  const done = await git(repo, 'commit', '--no-edit');
  check('organism conflict resolved by merge and committed', done.code === 0, done.stderr.slice(0, 200));
} else {
  console.log('(note: divergent organism merge happened to apply cleanly — the merge-state path is still covered by section 6)');
}
const finalOrganism = JSON.parse(await readFile(path.join(repo, '.openforge', 'organism.json'), 'utf8'));
check('resolved organism state keeps cycle, proposals, and replications', finalOrganism.cycle >= 2 && finalOrganism.proposals.length === 3 && finalOrganism.replications.length === 2 && finalOrganism.replications.some((r) => r.targetClass === 'data') && finalOrganism.replications.some((r) => r.targetClass === 'web'), JSON.stringify({ cycle: finalOrganism.cycle, proposals: finalOrganism.proposals.length, replications: finalOrganism.replications.map((r) => r.targetClass) }));
const markerScan = await sh(repo, 'grep', ['-rl', '<<<<<<<', '--exclude-dir=.git', '.']);
check('no conflict markers remain anywhere', markerScan.stdout.trim() === '');

console.log(`\nORGANISM STRESS: ${passed} checks passed, 0 failed.`);

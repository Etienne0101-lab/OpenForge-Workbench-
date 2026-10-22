/**
 * OpenForge Organism — the autopoietic lifecycle layer.
 *
 * Stephen's original organism (lib/original-organism.py in his upload) was a
 * concept sketch: seven lifecycle phases — initialize, grow, mature, mutate,
 * reproduce, dormancy, recycle — around LLM code generation. Two of its
 * mechanisms are NOT carried over, deliberately: raw exec() of generated
 * code, and base64-obfuscated self-replication. The platform already has
 * stronger, inspectable equivalents (missions verify before adopting;
 * swarms replicate agents; skills replicate knowledge). What IS carried
 * over — and made real here — is the lifecycle itself, run over the
 * platform's actual organs:
 *
 *   initialize  snapshot the body: model stats, skill library, pressure
 *   grow        find capability gaps; write exploration directives the
 *               model router actually consumes (stats.organism)
 *   mature      measure fitness: per-class success, champions, skill yield
 *   mutate      propose evidence-based mutations (weak classes, challenger
 *               models, skill gaps) — proposals, never silent self-edits;
 *               pool changes stay Stephen's call
 *   reproduce   propagate proven skills into sibling task classes as new,
 *               provenance-stamped skill files (writeSkill)
 *   dormancy    when rate pressure is high, sleep: grow/mutate/reproduce
 *               stand down next cycle; wake when pressure clears
 *   recycle     archive dead skills (uses>=5, zero successes) to
 *               .openforge/skills/archived/ — moved, never deleted
 *
 * State persists in .openforge/organism.json inside the project repo, so the
 * organism's memory travels with the project like the stats and skills do.
 * The scheduler runs one cycle per tick; `node agent/organism.mjs status|
 * cycle|phase <name>` drives it manually. No phase makes model calls —
 * the organism is metabolism, not another mouth to feed.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStats, saveStats, PRIORITY_MODELS, COVERAGE_TARGET } from './model-router.mjs';
import { listSkills, parseSkill, rebuildSkillsIndex, writeSkill, SKILLS_DIR } from './skills.mjs';

export const ORGANISM_PATH = '.openforge/organism.json';
export const PHASES = ['initialize', 'grow', 'mature', 'mutate', 'reproduce', 'dormancy', 'recycle'];
export const TASK_CLASSES = ['code', 'docs', 'tests', 'data', 'web', 'ops', 'general'];
const HISTORY_CAP = 24;
const PROPOSAL_CAP = 30;

export function emptyOrganism() {
  return {
    version: 1, cycle: 0, phase: 'initialize', dormant: false, updatedAt: 0,
    vitals: { health: null, totalPulls: 0, totalOk: 0, skillCount: 0, provenSkills: 0, mutations: 0, replications: 0 },
    directives: { exploreClasses: [], updatedAt: 0 },
    proposals: [],
    history: [],
  };
}

export async function loadOrganism(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, ORGANISM_PATH), 'utf8'));
    if (parsed && parsed.version === 1) return { ...emptyOrganism(), ...parsed };
  } catch { /* first awakening */ }
  return emptyOrganism();
}

export async function saveOrganism(root, state) {
  state.updatedAt = Date.now();
  await mkdir(path.join(root, '.openforge'), { recursive: true });
  await writeFile(path.join(root, ORGANISM_PATH), JSON.stringify(state, null, 2), 'utf8');
}

/* ---------- Shared analysis ---------- */

/** Per-class rollup of the bandit arms: pulls, successes, champion model. */
export function classRollup(stats) {
  const classes = {};
  for (const [key, arm] of Object.entries(stats.arms || {})) {
    const [model, taskClass] = key.split('|');
    if (!taskClass) continue;
    const entry = classes[taskClass] || (classes[taskClass] = { pulls: 0, ok: 0, champion: '', championRate: -1 });
    entry.pulls += arm.pulls || 0;
    entry.ok += arm.ok || 0;
    const rate = (arm.ok + 1) / (arm.pulls + 2);
    if ((arm.pulls || 0) >= 3 && rate > entry.championRate) { entry.champion = model; entry.championRate = rate; }
  }
  return classes;
}

export function computeVitals(stats, skills) {
  let totalPulls = 0;
  let totalOk = 0;
  for (const arm of Object.values(stats.arms || {})) { totalPulls += arm.pulls || 0; totalOk += arm.ok || 0; }
  return {
    health: totalPulls > 0 ? Math.round((100 * totalOk) / totalPulls) : null,
    totalPulls,
    totalOk,
    skillCount: skills.length,
    provenSkills: skills.filter((skill) => (skill.successes || 0) >= 2).length,
  };
}

function pressureCount(stats, now) {
  return PRIORITY_MODELS.filter((model) => (stats.pressure?.[model]?.cooldownUntil || 0) > now).length;
}

/* ---------- The phases. Each returns a one-line outcome. ---------- */

async function phaseInitialize(ctx) {
  const { stats, skills } = ctx;
  const classes = Object.keys(classRollup(stats)).length;
  return `body mapped: ${Object.keys(stats.arms || {}).length} model arms across ${classes} task classes, ${skills.length} skills in the library`;
}

async function phaseGrow(ctx) {
  const { root, stats, state } = ctx;
  if (state.dormant) return 'dormant — growth stands down this cycle';
  const rollup = classRollup(stats);
  const gaps = [];
  for (const taskClass of TASK_CLASSES) {
    const entry = rollup[taskClass];
    if (!entry || entry.pulls === 0) { gaps.push(taskClass); continue; }
    // Priority-pool coverage: any priority model with too few samples here?
    const underSampled = PRIORITY_MODELS.some((model) => ((stats.arms[`${model}|${taskClass}`]?.pulls) || 0) < COVERAGE_TARGET);
    if (underSampled && entry.pulls >= 2) gaps.push(taskClass);
  }
  const explore = gaps.slice(0, 3);
  state.directives = { exploreClasses: explore, updatedAt: Date.now() };
  // The router consumes directives from the stats object itself, so the
  // coupling survives any transport (repo file, swarm merge, companion).
  stats.organism = { exploreClasses: explore, updatedAt: Date.now() };
  await saveStats(root, stats);
  return explore.length ? `exploration directives set: ${explore.join(', ')} (router boost live)` : 'no capability gaps — coverage is complete';
}

async function phaseMature(ctx) {
  const { stats } = ctx;
  const rollup = classRollup(stats);
  const lines = Object.entries(rollup)
    .filter(([, entry]) => entry.pulls > 0)
    .sort((a, b) => b[1].pulls - a[1].pulls)
    .slice(0, 3)
    .map(([taskClass, entry]) => `${taskClass} ${Math.round((100 * entry.ok) / Math.max(1, entry.pulls))}%${entry.champion ? ` (champion ${entry.champion.split('/').pop()})` : ''}`);
  return lines.length ? `fitness: ${lines.join(' · ')}` : 'fitness: no call history yet — the body is young';
}

function addProposal(state, kind, title, detail) {
  const id = `${kind}:${title}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-').slice(0, 90);
  if (state.proposals.some((proposal) => proposal.id === id && proposal.status === 'open')) return false;
  state.proposals.push({ id, kind, title, detail, createdAt: Date.now(), status: 'open' });
  if (state.proposals.length > PROPOSAL_CAP) state.proposals = state.proposals.slice(-PROPOSAL_CAP);
  state.vitals.mutations += 1;
  return true;
}

async function phaseMutate(ctx) {
  const { stats, skills, state } = ctx;
  if (state.dormant) return 'dormant — mutation stands down this cycle';
  const rollup = classRollup(stats);
  let added = 0;
  for (const [taskClass, entry] of Object.entries(rollup)) {
    if (entry.pulls >= 10 && entry.championRate >= 0 && entry.championRate < 0.55) {
      if (addProposal(state, 'weak-class', `Weak task class: ${taskClass}`, `${taskClass} runs at ${Math.round(100 * (entry.ok / entry.pulls))}% success over ${entry.pulls} calls despite its champion. Candidate mutations: a dedicated skill for the class, a strategy variant, or a mission to diagnose the failure pattern.`)) added += 1;
    }
    if (entry.pulls >= 8 && !skills.some((skill) => (skill.taskClasses || []).includes(taskClass))) {
      if (addProposal(state, 'skill-gap', `No skill covers ${taskClass}`, `${taskClass} has ${entry.pulls} recorded calls and no skill in the library. Candidate mutation: distill the winning pattern from recent successful ${taskClass} missions into a skill (learn_skill during a mission, or the workbench Organism panel).`)) added += 1;
    }
    // Challenger watch: a non-default model dominating a class.
    const defaultArm = stats.arms[`${PRIORITY_MODELS[0]}|${taskClass}`];
    for (const [key, arm] of Object.entries(stats.arms)) {
      const [model, armClass] = key.split('|');
      if (armClass !== taskClass || model === PRIORITY_MODELS[0] || !PRIORITY_MODELS.includes(model)) continue;
      const rate = (arm.ok + 1) / (arm.pulls + 2);
      const defaultRate = defaultArm ? (defaultArm.ok + 1) / (defaultArm.pulls + 2) : 0;
      if (arm.pulls >= 12 && rate >= 0.85 && rate > defaultRate + 0.1) {
        if (addProposal(state, 'challenger', `${model} outperforms the default at ${taskClass}`, `${model} succeeds at ${Math.round(100 * rate)}% over ${arm.pulls} ${taskClass} calls vs the default's ${Math.round(100 * defaultRate)}%. The bandit already rotates it in; promoting it in the priority pool is Stephen's call (model policy).`)) added += 1;
      }
    }
  }
  return added ? `${added} new mutation proposal(s) recorded` : 'no new mutations — the evidence proposes nothing this cycle';
}

async function phaseReproduce(ctx) {
  const { root, stats, skills, state } = ctx;
  if (state.dormant) return 'dormant — reproduction stands down this cycle';
  const activeClasses = Object.entries(classRollup(stats)).filter(([, entry]) => entry.pulls >= 3).map(([taskClass]) => taskClass);
  let made = 0;
  for (const skill of skills) {
    if (made >= 2) break;
    const uses = skill.uses || 0;
    const successes = skill.successes || 0;
    if (uses < 3 || successes < 2 || successes / Math.max(1, uses) < 0.6) continue;
    for (const taskClass of activeClasses) {
      if (made >= 2) break;
      if ((skill.taskClasses || []).includes(taskClass)) continue;
      let body = skill.body || '';
      if (!body) {
        try { body = parseSkill(await readFile(path.join(root, SKILLS_DIR, `${skill.slug}.md`), 'utf8')).body; } catch { body = ''; }
      }
      if (!body) continue;
      const name = `${skill.name} (${taskClass} variant)`;
      await writeSkill(root, {
        name,
        tags: [...(skill.tags || []), 'organism-derived'],
        taskClasses: [taskClass],
        content: `> Replicated by the OpenForge organism from "${skill.name}" — proven at ${successes}/${uses} missions in ${(skill.taskClasses || []).join(', ') || 'general'} work and propagated to ${taskClass}. Validate on first use; the library's counters will judge it like any skill.\n\n${body}`,
      });
      state.vitals.replications += 1;
      made += 1;
    }
  }
  if (made) await rebuildSkillsIndex(root);
  return made ? `replicated ${made} proven skill(s) into sibling task classes` : 'nothing ripe to replicate — proven skills already cover the active classes';
}

async function phaseDormancy(ctx) {
  const { stats, state } = ctx;
  const pressured = pressureCount(stats, Date.now());
  const was = state.dormant;
  state.dormant = pressured >= 3;
  if (state.dormant && !was) return `entering dormancy — ${pressured} priority models are in cooldown; growth, mutation and reproduction stand down until pressure clears`;
  if (!state.dormant && was) return 'waking — rate pressure has cleared';
  return state.dormant ? `still dormant (${pressured} priority models cooling down)` : `awake (${pressured} priority models in cooldown)`;
}

async function phaseRecycle(ctx) {
  const { root, skills, state } = ctx;
  const dead = skills.filter((skill) => (skill.uses || 0) >= 5 && (skill.successes || 0) === 0);
  let moved = 0;
  if (dead.length) {
    const archiveDir = path.join(root, SKILLS_DIR, 'archived');
    await mkdir(archiveDir, { recursive: true });
    for (const skill of dead) {
      const from = path.join(root, SKILLS_DIR, `${skill.slug}.md`);
      if (existsSync(from)) { await rename(from, path.join(archiveDir, `${skill.slug}.md`)); moved += 1; }
    }
    if (moved) await rebuildSkillsIndex(root);
  }
  const staleBefore = state.proposals.length;
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const proposal of state.proposals) if (proposal.status === 'open' && proposal.createdAt < cutoff) proposal.status = 'stale';
  const staled = state.proposals.filter((proposal) => proposal.status === 'stale').length;
  return [
    moved ? `archived ${moved} dead skill(s) (5+ uses, zero successes) to skills/archived/` : 'no dead skills to recycle',
    staled ? `${staled} stale proposal(s) marked` : '',
  ].filter(Boolean).join('; ');
}

const PHASE_FNS = {
  initialize: phaseInitialize, grow: phaseGrow, mature: phaseMature, mutate: phaseMutate,
  reproduce: phaseReproduce, dormancy: phaseDormancy, recycle: phaseRecycle,
};

/* ---------- The cycle ---------- */

export async function runOrganismPhase(root, phase, { log = () => {} } = {}) {
  const fn = PHASE_FNS[phase];
  if (!fn) throw new Error(`unknown organism phase: ${phase}`);
  const stats = await loadStats(root);
  const skills = await listSkills(root);
  const state = await loadOrganism(root);
  const ctx = { root, stats, skills, state };
  const outcome = await fn(ctx);
  state.phase = phase;
  const vitals = computeVitals(stats, await listSkills(root));
  state.vitals = { ...state.vitals, ...vitals };
  await saveOrganism(root, state);
  log(`[organism] ${phase}: ${outcome}`);
  return { phase, outcome, vitals: state.vitals, dormant: state.dormant };
}

export async function runOrganismCycle(root, { log = () => {} } = {}) {
  const results = [];
  for (const phase of PHASES) results.push(await runOrganismPhase(root, phase, { log }));
  const state = await loadOrganism(root);
  state.cycle += 1;
  const summary = results.map((result) => `${result.phase}: ${result.outcome}`).join(' | ');
  state.history.push({ cycle: state.cycle, at: Date.now(), summary });
  if (state.history.length > HISTORY_CAP) state.history = state.history.slice(-HISTORY_CAP);
  await saveOrganism(root, state);
  log(`[organism] cycle ${state.cycle} complete — health ${state.vitals.health === null ? 'n/a' : `${state.vitals.health}%`}, ${state.vitals.mutations} mutations proposed, ${state.vitals.replications} replications, ${state.dormant ? 'DORMANT' : 'awake'}`);
  return { cycle: state.cycle, results, vitals: state.vitals, dormant: state.dormant, proposals: state.proposals.filter((proposal) => proposal.status === 'open') };
}

/* ---------- CLI ---------- */

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [command = 'status', arg = ''] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'status') {
    const state = await loadOrganism(root);
    console.log(JSON.stringify(state, null, 2));
  } else if (command === 'cycle') {
    const result = await runOrganismCycle(root, { log: console.log });
    console.log(JSON.stringify({ cycle: result.cycle, vitals: result.vitals, dormant: result.dormant, openProposals: result.proposals.length }, null, 2));
  } else if (command === 'phase') {
    const result = await runOrganismPhase(root, arg, { log: console.log });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('usage: node agent/organism.mjs [status|cycle|phase <name>]');
    process.exit(1);
  }
}

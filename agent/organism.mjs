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
 *               model router actually consumes (organism-owned state)
 *   mature      measure fitness: per-class success, champions, skill yield
 *   mutate      propose evidence-based mutations (weak classes, challenger
 *               models, skill gaps) — proposals, never silent self-edits;
 *               pool changes stay Stephen's call
 *   reproduce   propagate proven skills into sibling task classes as new,
 *               provenance-stamped, immutable replication files under
 *               .openforge/organism/replications/ (never the shared library)
 *   dormancy    when rate pressure is high, sleep: grow/mutate/reproduce
 *               stand down next cycle; wake when pressure clears
 *   recycle     archive dead skills (uses>=5, zero successes) to
 *               .openforge/skills/archived/ — moved, never deleted — or,
 *               on the scheduler path, queue them as archive candidates
 *               without touching the shared library (see below)
 *
 * State persists in .openforge/organism.json inside the project repo, so the
 * organism's memory travels with the project like the stats and skills do.
 * The scheduler runs one cycle per tick; `node agent/organism.mjs status|
 * cycle|phase <name>` drives it manually. No phase makes model calls —
 * the organism is metabolism, not another mouth to feed.
 *
 * CONFLICT DESIGN (why grow/reproduce can now run every tick with zero
 * merge risk): the organism NEVER writes a file any other writer writes.
 * model-stats.json belongs to missions (the bandit) and skills/index.json
 * plus .openforge/skills/*.md belong to missions and the swarm
 * integrator — so grow no longer writes stats.organism into
 * model-stats.json, and reproduce no longer writes into the shared skill
 * library. Instead:
 *   - grow writes directives into organism.json (organism-owned) plus a
 *     mirror at .openforge/organism/directives.json; the router reads
 *     those at mission start (loadOrganismDirectives), so directives
 *     steer routing exactly as before without touching shared stats.
 *   - reproduce writes one NEW, immutable file per replication under
 *     .openforge/organism/replications/, named for its source skill and
 *     target class, and records it in the organism manifest. The skill
 *     loader merges those files into listSkills/searchSkills at READ
 *     time, so a replication is usable by the very next mission without
 *     any write to the shared library — and two writers can never
 *     conflict on a replication file, because no writer ever modifies
 *     an existing one (dedup is by source+class, checked before write).
 *   - the scheduler workflow commits exactly the organism-owned paths
 *     (.openforge/organism.json, .openforge/organism/) plus schedule
 *     state, and rebase conflicts on those paths are resolved by
 *     mergeOrganismState (union, never last-writer-wins), exposed via
 *     `node agent/organism.mjs merge-state <ours> <theirs> <out>`.
 * Shared files are therefore untouched by a scheduler tick: a tick and a
 * mission merge can land in either order and neither loses data.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStats, PRIORITY_MODELS, COVERAGE_TARGET } from './model-router.mjs';
import { listSkills, parseSkill, rebuildSkillsIndex, SKILLS_DIR } from './skills.mjs';

export const ORGANISM_PATH = '.openforge/organism.json';
export const ORGANISM_DIR = '.openforge/organism';
export const DIRECTIVES_PATH = '.openforge/organism/directives.json';
export const REPLICATIONS_DIR = '.openforge/organism/replications';
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
    replications: [],
    archiveCandidates: [],
  };
}

export async function loadOrganism(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, ORGANISM_PATH), 'utf8'));
    if (parsed && parsed.version === 1) {
      const state = { ...emptyOrganism(), ...parsed };
      state.replications = Array.isArray(parsed.replications) ? parsed.replications : [];
      state.archiveCandidates = Array.isArray(parsed.archiveCandidates) ? parsed.archiveCandidates : [];
      return state;
    }
  } catch { /* first awakening */ }
  return emptyOrganism();
}

/**
 * Read the organism's current exploration directives from its own files
 * (organism.json plus the directives.json mirror), unioned. Never throws:
 * a missing organism simply directs nothing. This is what the router
 * consumes at mission start — it is the replacement for the old
 * stats.organism coupling, which required writing shared model-stats.json.
 */
export async function loadOrganismDirectives(root) {
  const classes = [];
  let updatedAt = 0;
  const absorb = (directives) => {
    if (!directives) return;
    updatedAt = Math.max(updatedAt, directives.updatedAt || 0);
    for (const taskClass of directives.exploreClasses || []) if (!classes.includes(taskClass)) classes.push(taskClass);
  };
  try { absorb(JSON.parse(await readFile(path.join(root, ORGANISM_PATH), 'utf8')).directives); } catch { /* no state yet */ }
  try { absorb(JSON.parse(await readFile(path.join(root, DIRECTIVES_PATH), 'utf8'))); } catch { /* no mirror yet */ }
  return { exploreClasses: classes, updatedAt };
}

/**
 * Merge two divergent organism states without losing either side's work.
 * This is the conflict resolver for the one file two writers could ever
 * both touch (organism.json): proposals union by id (open beats stale),
 * history union by cycle, replications and archive candidates union by
 * slug, directives from the newer side (unioned on a timestamp tie),
 * monotonic counters take the max, and everything else comes from the
 * newer side. Deterministic and order-independent for the unioned parts.
 */
export function mergeOrganismState(a, b) {
  const left = a && a.version === 1 ? a : emptyOrganism();
  const right = b && b.version === 1 ? b : emptyOrganism();
  const newer = (right.updatedAt || 0) >= (left.updatedAt || 0) ? right : left;
  const older = newer === right ? left : right;
  const byId = new Map();
  for (const proposal of [...(left.proposals || []), ...(right.proposals || [])]) {
    const existing = byId.get(proposal.id);
    if (!existing) { byId.set(proposal.id, { ...proposal }); continue; }
    if (existing.status !== 'open' && proposal.status === 'open') byId.set(proposal.id, { ...proposal });
  }
  const byCycle = new Map();
  for (const entry of [...(left.history || []), ...(right.history || [])]) {
    const existing = byCycle.get(entry.cycle);
    if (!existing || (entry.at || 0) >= (existing.at || 0)) byCycle.set(entry.cycle, { ...entry });
  }
  const bySlug = (lists) => {
    const map = new Map();
    for (const item of lists.flat()) if (item && item.slug && !map.has(item.slug)) map.set(item.slug, { ...item });
    return [...map.values()];
  };
  // Replications carry use counters that missions bump independently of
  // the scheduler's cycle writes, so their merge takes the MAX of each
  // counter — first-wins would silently lose a mission's accounting.
  const mergedReplications = new Map();
  for (const item of [...(left.replications || []), ...(right.replications || [])]) {
    if (!item || !item.slug) continue;
    const existing = mergedReplications.get(item.slug);
    if (!existing) { mergedReplications.set(item.slug, { ...item }); continue; }
    mergedReplications.set(item.slug, {
      ...existing,
      uses: Math.max(existing.uses || 0, item.uses || 0),
      successes: Math.max(existing.successes || 0, item.successes || 0),
    });
  }
  const leftDirectives = left.directives || { exploreClasses: [], updatedAt: 0 };
  const rightDirectives = right.directives || { exploreClasses: [], updatedAt: 0 };
  const directives = (rightDirectives.updatedAt || 0) > (leftDirectives.updatedAt || 0)
    ? { ...rightDirectives }
    : (leftDirectives.updatedAt || 0) > (rightDirectives.updatedAt || 0)
      ? { ...leftDirectives }
      : { exploreClasses: [...new Set([...(leftDirectives.exploreClasses || []), ...(rightDirectives.exploreClasses || [])])], updatedAt: Math.max(leftDirectives.updatedAt || 0, rightDirectives.updatedAt || 0) };
  return {
    version: 1,
    cycle: Math.max(left.cycle || 0, right.cycle || 0),
    phase: newer.phase || 'initialize',
    dormant: Boolean(newer.dormant),
    updatedAt: Math.max(left.updatedAt || 0, right.updatedAt || 0),
    vitals: {
      ...newer.vitals,
      mutations: Math.max(left.vitals?.mutations || 0, right.vitals?.mutations || 0),
      replications: Math.max(left.vitals?.replications || 0, right.vitals?.replications || 0),
    },
    directives,
    proposals: [...byId.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0)).slice(-30),
    history: [...byCycle.values()].sort((x, y) => x.cycle - y.cycle).slice(-24),
    replications: [...mergedReplications.values()],
    archiveCandidates: bySlug([left.archiveCandidates || [], right.archiveCandidates || []]),
    _mergedFrom: { leftUpdatedAt: left.updatedAt || 0, rightUpdatedAt: right.updatedAt || 0, note: 'merged, not overwritten' },
  };
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
  // Organism-owned persistence only: directives live in organism.json
  // (saved by the phase runner) plus this mirror, which the router reads
  // at mission start. model-stats.json is NEVER written here — it belongs
  // to missions, and writing it from a scheduler tick is exactly what
  // used to make grow's output vanish or collide with mission merges.
  // The mirror is written immediately so a later phase failure in this
  // cycle cannot lose the directives.
  await mkdir(path.join(root, ORGANISM_DIR), { recursive: true });
  await writeFile(path.join(root, DIRECTIVES_PATH), JSON.stringify({ ...state.directives, source: 'organism-grow' }, null, 2), 'utf8');
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
  // Dedup key: (source skill, target class). A replication is made once,
  // ever — re-running a cycle must never write a second file for the same
  // propagation, and the manifest is the record, not the shared index.
  const already = new Set((state.replications || []).map((entry) => `${entry.sourceSlug}|${entry.targetClass}`));
  let existingFiles = [];
  try { existingFiles = await readdir(path.join(root, REPLICATIONS_DIR)); } catch { /* first replication */ }
  for (const file of existingFiles) {
    const match = /^replicated-(.+)-to-([a-z0-9-]+)-c\d+\.md$/.exec(file);
    if (match) already.add(`${match[1]}|${match[2]}`);
  }
  let made = 0;
  for (const skill of skills) {
    if (made >= 2) break;
    // Only replicate the base library's own skills, never a replication
    // of a replication — propagation is one generation deep, so the
    // organism cannot echo-chamber its own output into the library.
    if (skill.source === 'organism-replication') continue;
    const uses = skill.uses || 0;
    const successes = skill.successes || 0;
    if (uses < 3 || successes < 2 || successes / Math.max(1, uses) < 0.6) continue;
    for (const taskClass of activeClasses) {
      if (made >= 2) break;
      if ((skill.taskClasses || []).includes(taskClass)) continue;
      if (already.has(`${skill.slug}|${taskClass}`)) continue;
      let body = skill.body || '';
      if (!body) {
        try { body = parseSkill(await readFile(path.join(root, SKILLS_DIR, `${skill.slug}.md`), 'utf8')).body; } catch { body = ''; }
      }
      if (!body) continue;
      const name = `${skill.name} (${taskClass} variant)`;
      const slug = `replicated-${skill.slug}-to-${taskClass}-c${state.cycle + 1}`;
      const frontmatter = [
        '---',
        `name: ${name}`,
        `tags: ${[...(skill.tags || []), 'organism-derived'].join(', ')}`,
        `task_classes: ${taskClass}`,
        '---',
        '',
      ].join('\n');
      const content = `> Replicated by the OpenForge organism from "${skill.name}" — proven at ${successes}/${uses} missions in ${(skill.taskClasses || []).join(', ') || 'general'} work and propagated to ${taskClass}. Validate on first use; the library's counters will judge it like any skill.\n\n${body}`;
      // Immutable organism-owned artifact: this file is written once and
      // never modified again, so no other writer can ever conflict on it.
      // The skill loader merges this directory into listSkills/searchSkills
      // at read time, so the replication is usable by the next mission
      // without any write to the shared skill library or its index.
      await mkdir(path.join(root, REPLICATIONS_DIR), { recursive: true });
      await writeFile(path.join(root, REPLICATIONS_DIR, `${slug}.md`), frontmatter + content.trim() + '\n', 'utf8');
      (state.replications || (state.replications = [])).push({
        slug, sourceSlug: skill.slug, sourceName: skill.name, targetClass: taskClass,
        cycle: state.cycle + 1, createdAt: Date.now(), uses: 0, successes: 0,
      });
      already.add(`${skill.slug}|${taskClass}`);
      state.vitals.replications += 1;
      made += 1;
    }
  }
  return made ? `replicated ${made} proven skill(s) into sibling task classes (organism replications, live for the next mission)` : 'nothing ripe to replicate — proven skills already cover the active classes';
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
  const { root, skills, state, schedulerSafe } = ctx;
  const dead = skills.filter((skill) => skill.source !== 'organism-replication' && (skill.uses || 0) >= 5 && (skill.successes || 0) === 0);
  let moved = 0;
  if (dead.length && schedulerSafe) {
    // Scheduler path: record the dead skills as archive candidates in
    // organism state (organism-owned, committed by the tick) and touch
    // NOTHING in the shared library. A mission or manual run executes
    // the archival later, when it can commit the library change itself.
    // This is what keeps a tick from ever conflicting with a mission
    // merge over .openforge/skills/.
    const known = new Set((state.archiveCandidates || []).map((entry) => entry.slug));
    for (const skill of dead) {
      if (known.has(skill.slug)) continue;
      (state.archiveCandidates || (state.archiveCandidates = [])).push({
        slug: skill.slug, name: skill.name, uses: skill.uses || 0, successes: 0, detectedAt: Date.now(),
      });
      known.add(skill.slug);
    }
    const queued = (state.archiveCandidates || []).length;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const proposal of state.proposals) if (proposal.status === 'open' && proposal.createdAt < cutoff) proposal.status = 'stale';
    const staled = state.proposals.filter((proposal) => proposal.status === 'stale').length;
    return [
      `${dead.length} dead skill(s) queued as archive candidates (scheduler-safe: shared library untouched; ${queued} total queued)`,
      staled ? `${staled} stale proposal(s) marked` : '',
    ].filter(Boolean).join('; ');
  }
  if (dead.length) {
    const archiveDir = path.join(root, SKILLS_DIR, 'archived');
    await mkdir(archiveDir, { recursive: true });
    for (const skill of dead) {
      const from = path.join(root, SKILLS_DIR, `${skill.slug}.md`);
      if (existsSync(from)) { await rename(from, path.join(archiveDir, `${skill.slug}.md`)); moved += 1; }
    }
    if (moved) {
      await rebuildSkillsIndex(root);
      const movedSlugs = new Set(dead.map((skill) => skill.slug));
      state.archiveCandidates = (state.archiveCandidates || []).filter((entry) => !movedSlugs.has(entry.slug));
    }
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

export async function runOrganismPhase(root, phase, { log = () => {}, schedulerSafe = false } = {}) {
  const fn = PHASE_FNS[phase];
  if (!fn) throw new Error(`unknown organism phase: ${phase}`);
  const stats = await loadStats(root);
  const skills = await listSkills(root);
  const state = await loadOrganism(root);
  const ctx = { root, stats, skills, state, schedulerSafe };
  const outcome = await fn(ctx);
  state.phase = phase;
  const vitals = computeVitals(stats, await listSkills(root));
  state.vitals = { ...state.vitals, ...vitals };
  await saveOrganism(root, state);
  log(`[organism] ${phase}: ${outcome}`);
  return { phase, outcome, vitals: state.vitals, dormant: state.dormant };
}

export async function runOrganismCycle(root, { log = () => {}, schedulerSafe = false } = {}) {
  const results = [];
  for (const phase of PHASES) results.push(await runOrganismPhase(root, phase, { log, schedulerSafe }));
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
  const [command = 'status', ...rest] = process.argv.slice(2);
  const root = process.cwd();
  if (command === 'status') {
    const state = await loadOrganism(root);
    console.log(JSON.stringify(state, null, 2));
  } else if (command === 'cycle') {
    const result = await runOrganismCycle(root, { log: console.log, schedulerSafe: rest.includes('--scheduler-safe') });
    console.log(JSON.stringify({ cycle: result.cycle, vitals: result.vitals, dormant: result.dormant, openProposals: result.proposals.length }, null, 2));
  } else if (command === 'phase') {
    const result = await runOrganismPhase(root, rest[0], { log: console.log });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'merge-state') {
    // Conflict resolver for the scheduler workflow: merge two divergent
    // organism.json versions (ours, theirs) into <out> without losing
    // either side's proposals, history, or replications.
    const [oursPath, theirsPath, outPath] = rest;
    if (!oursPath || !theirsPath || !outPath) { console.error('usage: node agent/organism.mjs merge-state <ours.json> <theirs.json> <out.json>'); process.exit(2); }
    const ours = JSON.parse(await readFile(oursPath, 'utf8'));
    const theirs = JSON.parse(await readFile(theirsPath, 'utf8'));
    const merged = mergeOrganismState(ours, theirs);
    await writeFile(outPath, JSON.stringify(merged, null, 2), 'utf8');
    console.log(JSON.stringify({ cycle: merged.cycle, proposals: merged.proposals.length, replications: merged.replications.length, history: merged.history.length }));
  } else {
    console.error('usage: node agent/organism.mjs [status|cycle [--scheduler-safe]|phase <name>|merge-state <ours> <theirs> <out>]');
    process.exit(1);
  }
}

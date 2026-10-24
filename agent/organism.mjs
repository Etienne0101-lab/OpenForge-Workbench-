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

/** Per-class rollup of the

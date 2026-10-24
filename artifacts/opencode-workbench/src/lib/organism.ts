/**
 * The OpenForge Organism — browser side.
 *
 * The organism is the platform's autopoietic lifecycle layer (agent plane:
 * agent/organism.mjs). Its state lives in the project repo at
 * .openforge/organism.json and is written by the scheduler's per-tick cycle
 * (or `node agent/organism.mjs cycle`). This module reads that state for the
 * Organism panel and defines the shared phase vocabulary — the seven phases
 * from Stephen's original organism, each now bound to real platform organs:
 *
 *   initialize  body snapshot (stats, skills, pressure)
 *   grow        capability gaps -> exploration directives the router obeys
 *   mature      fitness measurement (per-class success, champions)
 *   mutate      evidence-based mutation proposals (never silent self-edits)
 *   reproduce   proven skills propagated into sibling task classes
 *   dormancy    rate-pressure sleep; growth stands down
 *   recycle     dead skills archived (moved, never deleted)
 */

import { parseRepo } from './github';

export type OrganismPhase = 'initialize' | 'grow' | 'mature' | 'mutate' | 'reproduce' | 'dormancy' | 'recycle';

export const ORGANISM_PHASES: { id: OrganismPhase; name: string; description: string; color: string }[] = [
  { id: 'initialize', name: 'Initialize', description: 'Snapshot the body: model stats, skills, pressure', color: '#5aa2ff' },
  { id: 'grow', name: 'Grow', description: 'Find capability gaps; direct the router to explore them', color: '#7ac74f' },
  { id: 'mature', name: 'Mature', description: 'Measure fitness: per-class success and champions', color: '#f2c94c' },
  { id: 'mutate', name: 'Mutate', description: 'Propose evidence-based mutations for review', color: '#b07fe8' },
  { id: 'reproduce', name: 'Reproduce', description: 'Propagate proven skills into sibling task classes', color: '#f28ec4' },
  { id: 'dormancy', name: 'Dormancy', description: 'Sleep under rate pressure; conserve quota', color: '#7f8ff2' },
  { id: 'recycle', name: 'Recycle', description: 'Archive dead skills; mark stale proposals', color: '#f26d6d' },
];

export type OrganismProposal = { id: string; kind: string; title: string; detail: string; createdAt: number; status: string };
export type OrganismReplication = { slug: string; sourceSlug: string; sourceName: string; targetClass: string; cycle: number; createdAt: number; uses: number; successes: number };
export type OrganismArchiveCandidate = { slug: string; name: string; uses: number; successes: number; detectedAt: number };
export type OrganismState = {
  version: number;
  cycle: number;
  phase: OrganismPhase;
  dormant: boolean;
  updatedAt: number;
  vitals: { health: number | null; totalPulls: number; totalOk: number; skillCount: number; provenSkills: number; mutations: number; replications: number };
  directives: { exploreClasses: string[]; updatedAt: number };
  proposals: OrganismProposal[];
  history: { cycle: number; at: number; summary: string }[];
  // Widened 2026-10-24: replications are immutable files under
  // .openforge/organism/replications/ (merged into skill search at read
  // time, never written into the shared library), and archive
  // candidates are dead skills a scheduler tick queued without touching
  // the shared library. Both are optional for older states.
  replications?: OrganismReplication[];
  archiveCandidates?: OrganismArchiveCandidate[];
};

/** Read .openforge/organism.json from the linked repo (API with token, else the public mirror). */
export async function fetchOrganismState(repoInput: string, branch: string, token: string): Promise<OrganismState | null> {
  const parsed = parseRepo(repoInput || '');
  if (!parsed) return null;
  const ref = branch || 'main';
  if (token) {
    try {
      const response = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/.openforge/organism.json?ref=${encodeURIComponent(ref)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json' },
      });
      if (response.ok) return (await response.json()) as OrganismState;
    } catch { /* fall through to the mirror */ }
  }
  try {
    const response = await fetch(`https://cdn.jsdelivr.net/gh/${parsed.owner}/${parsed.repo}@${encodeURIComponent(ref)}/.openforge/organism.json`);
    if (response.ok) return (await response.json()) as OrganismState;
  } catch { /* no organism yet */ }
  return null;
}

/**
 * Context distillation for browser missions (Context Density,
 * Phase 1) — the mirror of agent/distill.mjs. Older mission turns
 * fold into a deterministic state block built from the mission's own
 * structured state (goal, plan steps, verifications, changed files),
 * so history growth stops being linear in turns. Zero extra model
 * requests: no summarizer call is spent.
 */
import type { ChatMessage } from '../openrouter';

export const DISTILL_SENTINEL = 'MISSION STATE (distilled)';
export const DISTILL_THRESHOLD_CHARS = 60_000;
export const DISTILL_KEEP_RECENT = 10;

export interface MissionDistillSnapshot {
  goal: string;
  steps: Array<{ title: string; status: string; detail?: string }>;
  verifications: Array<{ name: string; ok: boolean; evidence: string }>;
  changedFiles: string[];
  distilledCount?: number;
}

function firstLine(text: string, cap = 120): string {
  const line = (text || '').split('\n').find((entry) => entry.trim()) || '';
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

export function buildMissionStateBlock(snapshot: MissionDistillSnapshot, droppedDigest: string[]): string {
  const lines = [
    `${DISTILL_SENTINEL} — ${snapshot.distilledCount || 0} earlier turn(s) were folded into this block to keep the mission's context dense. Everything below is the engine's structured record; trust it over any vague recollection of the folded turns.`,
    '',
    `GOAL: ${snapshot.goal}`,
  ];
  if (snapshot.steps.length) {
    lines.push('', 'PLAN:');
    snapshot.steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. [${step.status}] ${step.title}${step.detail ? ` — ${step.detail.slice(0, 160)}` : ''}`);
    });
  }
  if (snapshot.changedFiles.length) {
    lines.push('', `FILES CHANGED SO FAR (${snapshot.changedFiles.length}):`);
    for (const file of snapshot.changedFiles) lines.push(`  - ${file}`);
  }
  if (snapshot.verifications.length) {
    lines.push('', 'VERIFICATIONS RUN:');
    for (const entry of snapshot.verifications) lines.push(`  - ${entry.name}: ${entry.ok ? 'passed' : 'FAILED'} — ${entry.evidence.slice(0, 160)}`);
  }
  if (droppedDigest.length) {
    lines.push('', 'LAST FOLDED TURNS (first lines):');
    for (const line of droppedDigest) lines.push(`  - ${line}`);
  }
  lines.push('', 'Continue from the plan state above. Do not redo completed steps.');
  return lines.join('\n');
}

export function distillMissionMessages(
  messages: ChatMessage[],
  snapshot: MissionDistillSnapshot,
  options: { thresholdChars?: number; keepRecent?: number } = {},
): { messages: ChatMessage[]; distilled: number; savedChars: number } {
  const thresholdChars = options.thresholdChars ?? DISTILL_THRESHOLD_CHARS;
  const keepRecent = options.keepRecent ?? DISTILL_KEEP_RECENT;
  const totalChars = messages.reduce((sum, message) => sum + (message?.content || '').length, 0);
  if (totalChars <= thresholdChars || messages.length <= keepRecent + 2) {
    return { messages, distilled: 0, savedChars: 0 };
  }
  const head = messages.slice(0, 1); // the mission brief
  const turns = messages.slice(1).filter((message) => !(message?.content || '').includes(DISTILL_SENTINEL));
  if (turns.length <= keepRecent) return { messages, distilled: 0, savedChars: 0 };
  const dropped = turns.slice(0, turns.length - keepRecent);
  const kept = turns.slice(turns.length - keepRecent);
  const droppedDigest = dropped.slice(-8).map((message) => `${message.role}: ${firstLine(message.content)}`);
  const block = buildMissionStateBlock({ ...snapshot, distilledCount: (snapshot.distilledCount || 0) + dropped.length }, droppedDigest);
  const next = [...head, { role: 'user' as const, content: block }, ...kept];
  const savedChars = totalChars - next.reduce((sum, message) => sum + (message?.content || '').length, 0);
  return { messages: next, distilled: dropped.length, savedChars: Math.max(0, savedChars) };
}

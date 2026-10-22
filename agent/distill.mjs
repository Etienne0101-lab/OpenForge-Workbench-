/**
 * Context distillation for long missions (Context Density, Phase 1).
 *
 * A mission's message history grows with every tool observation, so a
 * long mission pays quadratic context for linear progress. But the
 * engine already maintains the mission's STRUCTURED state — plan,
 * completed steps, changed files, verifications, notes — which is
 * exactly what a distillation needs to preserve. When the history
 * crosses a size threshold, older turns fold into a deterministic
 * STATE BLOCK (zero extra model requests — no summarizer call) and
 * only recent turns stay raw. Linear growth becomes near-logarithmic:
 * the block is regenerated from state each time, so it never grows
 * with the number of distilled turns.
 */

export const DISTILL_SENTINEL = 'MISSION STATE (distilled)';
export const DISTILL_THRESHOLD_CHARS = 60000;
export const DISTILL_KEEP_RECENT = 10;

function firstLine(text, cap = 120) {
  const line = String(text || '').split('\n').find((entry) => entry.trim()) || '';
  return line.length > cap ? `${line.slice(0, cap)}…` : line;
}

export function buildStateBlock({ goal, plan = [], done = [], changed = [], verifications = [], notes = [], questions = [], distilledCount = 0, droppedDigest = [] }) {
  const lines = [
    `${DISTILL_SENTINEL} — ${distilledCount} earlier turn(s) were folded into this block to keep the mission's context dense. Everything below is the engine's structured record; trust it over any vague recollection of the folded turns. Full detail remains in the mission timeline and checkpoints.`,
    '',
    `GOAL: ${goal}`,
  ];
  if (plan.length) {
    lines.push('', 'PLAN:');
    plan.forEach((step, index) => {
      const status = index < done.length ? 'done' : index === done.length ? 'current' : 'pending';
      lines.push(`  ${index + 1}. [${status}] ${step}`);
    });
  }
  if (done.length) {
    lines.push('', 'COMPLETED STEPS:');
    for (const entry of done) lines.push(`  - ${entry}`);
  }
  if (changed.length) {
    lines.push('', `FILES CHANGED SO FAR (${changed.length}):`);
    for (const file of changed) lines.push(`  - ${file}`);
  }
  if (verifications.length) {
    lines.push('', 'VERIFICATIONS RUN:');
    for (const entry of verifications) lines.push(`  - ${entry.name}: ${String(entry.evidence || '').slice(0, 160)}`);
  }
  if (notes.length) {
    lines.push('', 'AGENT NOTES:');
    for (const note of notes.slice(-8)) lines.push(`  - ${String(note).slice(0, 240)}`);
  }
  if (questions.length) {
    lines.push('', 'OPEN QUESTIONS RAISED:');
    for (const question of questions) lines.push(`  - ${String(question).slice(0, 200)}`);
  }
  if (droppedDigest.length) {
    lines.push('', 'LAST FOLDED TURNS (first lines):');
    for (const line of droppedDigest) lines.push(`  - ${line}`);
  }
  lines.push('', 'Continue from the plan state above. Do not redo completed steps.');
  return lines.join('\n');
}

/**
 * Fold older turns of `messages` ([system, brief, ...turns]) into a
 * state block built from `snapshot`. Returns { messages, distilled,
 * savedChars } — distilled = number of turns folded (0 = unchanged).
 */
export function distillMessages(messages, snapshot, { thresholdChars = DISTILL_THRESHOLD_CHARS, keepRecent = DISTILL_KEEP_RECENT } = {}) {
  const totalChars = messages.reduce((sum, message) => sum + String(message?.content || '').length, 0);
  if (totalChars <= thresholdChars || messages.length <= keepRecent + 3) {
    return { messages, distilled: 0, savedChars: 0 };
  }
  const head = messages.slice(0, 2); // system prompt + mission brief
  const turns = messages.slice(2).filter((message) => !String(message?.content || '').includes(DISTILL_SENTINEL));
  if (turns.length <= keepRecent) return { messages, distilled: 0, savedChars: 0 };
  const dropped = turns.slice(0, turns.length - keepRecent);
  const kept = turns.slice(turns.length - keepRecent);
  const droppedDigest = dropped.slice(-8).map((message) => `${message.role}: ${firstLine(message.content)}`);
  const block = buildStateBlock({ ...snapshot, distilledCount: (snapshot.distilledCount || 0) + dropped.length, droppedDigest });
  const next = [...head, { role: 'user', content: block }, ...kept];
  const savedChars = totalChars - next.reduce((sum, message) => sum + String(message?.content || '').length, 0);
  return { messages: next, distilled: dropped.length, savedChars: Math.max(0, savedChars) };
}

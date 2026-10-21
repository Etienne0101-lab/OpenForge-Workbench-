import type { MissionStatus } from '../workspace-store';

/**
 * Mission graph — LangGraph's architecture, incorporated natively.
 *
 * LangGraph itself is a Python server framework and cannot run in this
 * browser app (see the viability analysis); what ports — at zero
 * dependency cost — is its design: an explicit state graph with
 * conditional edges, append-only channels, a checkpoint at every
 * superstep, and interrupt() gates for human decisions. The engine in
 * App.tsx executes this graph; the Mission panel renders it live.
 *
 *   plan ──▶ act ──▶ verify ──▶ act (next step) ──▶ finalize
 *              │         │
 *              ├─────────┴──▶ repair (bad reply / failed check, bounded)
 *              └───────────▶ interrupt (plan / change / tool approval, ask_user)
 */

export type MissionGraphNode = 'plan' | 'act' | 'verify' | 'repair' | 'interrupt' | 'finalize';

export const GRAPH_NODES: Array<{ id: MissionGraphNode; label: string; blurb: string }> = [
  { id: 'plan', label: 'Plan', blurb: 'The agent proposes a plan; nothing runs before approval.' },
  { id: 'act', label: 'Act', blurb: 'One validated action per turn: read, search, propose, note.' },
  { id: 'verify', label: 'Verify', blurb: 'Preview builds, Python, SQL, HTTP and runtime checks produce evidence.' },
  { id: 'repair', label: 'Repair', blurb: 'Protocol errors and failed checks route here, bounded by the repair budget.' },
  { id: 'interrupt', label: 'Human gate', blurb: 'Execution pauses for a decision; your answer is the resume value.' },
  { id: 'finalize', label: 'Finalize', blurb: 'Report with mechanically checked verification claims; merge stays human.' },
];

export const GRAPH_EDGES: Array<{ from: MissionGraphNode; to: MissionGraphNode; when: string }> = [
  { from: 'plan', to: 'interrupt', when: 'plan awaits approval' },
  { from: 'plan', to: 'act', when: 'plan approved' },
  { from: 'act', to: 'verify', when: 'a verification tool runs' },
  { from: 'act', to: 'interrupt', when: 'an action needs approval or an answer' },
  { from: 'act', to: 'repair', when: 'the reply is not a valid action' },
  { from: 'verify', to: 'act', when: 'evidence recorded; work continues' },
  { from: 'verify', to: 'repair', when: 'a check failed and repairs remain' },
  { from: 'repair', to: 'act', when: 'the model retries with the error as context' },
  { from: 'interrupt', to: 'act', when: 'the user decides; execution resumes' },
  { from: 'act', to: 'finalize', when: 'the agent completes or gives up, or budgets end' },
];

/** Derive the graph node from mission status when no explicit node is recorded. */
export function nodeForStatus(status: MissionStatus): MissionGraphNode {
  switch (status) {
    case 'planning':
      return 'plan';
    case 'awaiting-plan-approval':
    case 'waiting-user':
    case 'blocked':
      return 'interrupt';
    case 'verifying':
      return 'verify';
    case 'completed':
    case 'failed':
    case 'abandoned':
    case 'merged':
    case 'discarded':
      return 'finalize';
    default:
      return 'act';
  }
}

export type MissionPhase = 'planning' | 'acting' | 'verifying' | 'repairing' | 'waiting' | 'done';

export function nodeForPhase(phase: MissionPhase): MissionGraphNode {
  switch (phase) {
    case 'planning': return 'plan';
    case 'acting': return 'act';
    case 'verifying': return 'verify';
    case 'repairing': return 'repair';
    case 'waiting': return 'interrupt';
    case 'done': return 'finalize';
  }
}

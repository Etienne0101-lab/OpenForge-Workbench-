import type { Suggestion } from '../workspace-store';

/**
 * Mission Mode wire protocol: the model answers each turn with ONE JSON
 * object { rationale, action: { tool, args } }. This is deliberately not
 * provider-native tool calling — free/router models have proven unreliable
 * at emitting those formats, while plain JSON with validation + a repair
 * turn works across the whole catalog.
 */

export type AgentAction = { tool: string; args: Record<string, unknown> };
export type ParsedTurn = { rationale: string; action: AgentAction };

export const KNOWN_TOOLS = [
  'update_plan', 'step_done', 'step_failed',
  'list_files', 'read_file', 'search_code', 'repo_map',
  'propose_change', 'build_preview', 'note', 'ask_user',
  'complete_mission', 'give_up',
] as const;

/** Extract the first balanced {...} object from text, respecting strings. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function parseAgentTurn(text: string): { turn: ParsedTurn } | { error: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { error: 'No JSON object found in the reply. Reply with exactly one JSON object: {"rationale": "…", "action": {"tool": "…", "args": {…}}}.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { error: 'The reply contained malformed JSON. Reply with exactly one valid JSON object and no markdown fences.' };
  }
  const obj = parsed as { rationale?: unknown; action?: { tool?: unknown; args?: unknown } };
  if (!obj.action || typeof obj.action.tool !== 'string') {
    return { error: 'The JSON object is missing action.tool. Include "action": {"tool": "<tool name>", "args": {…}}.' };
  }
  const args = (obj.action.args && typeof obj.action.args === 'object' ? obj.action.args : {}) as Record<string, unknown>;
  return { turn: { rationale: typeof obj.rationale === 'string' ? obj.rationale : '', action: { tool: obj.action.tool, args } } };
}

/** Structural validation against the tool registry; returns an error string or null. */
export function validateAction(action: AgentAction): string | null {
  if (!(KNOWN_TOOLS as readonly string[]).includes(action.tool)) {
    return `Unknown tool "${action.tool}". Known tools: ${KNOWN_TOOLS.join(', ')}.`;
  }
  const args = action.args;
  const needString = (key: string) => (typeof args[key] === 'string' && (args[key] as string).trim() ? null : `Tool ${action.tool} requires a non-empty string arg "${key}".`);
  switch (action.tool) {
    case 'update_plan':
      return Array.isArray(args.steps) && args.steps.length > 0 && args.steps.every((step) => typeof step === 'string' && step.trim())
        ? null
        : 'Tool update_plan requires args.steps: a non-empty array of step title strings.';
    case 'step_done':
    case 'step_failed':
      return typeof args.step === 'number' && Number.isInteger(args.step) && args.step >= 1
        ? null
        : `Tool ${action.tool} requires args.step: the 1-based plan step number.`;
    case 'read_file':
      return needString('path');
    case 'search_code':
      return needString('query');
    case 'propose_change':
      return needString('blocks');
    case 'note':
      return needString('text');
    case 'ask_user':
      return needString('question');
    case 'complete_mission':
      return needString('summary');
    case 'give_up':
      return needString('reason');
    default:
      return null;
  }
}

/**
 * Parse the platform's change-block format (<<<FILE>>> / <<<PATCH>>> /
 * <<<DELETE>>>) — the same blocks the chat produces — into suggestions.
 * Kept in step with suggestionsFrom in App.tsx.
 */
export function parseChangeBlocks(text: string): Suggestion[] {
  const suggestions: Suggestion[] = [];
  let body = text;
  body = body.replace(/<<<PATCH\s+([^>\n]+)>>>\s*\n([\s\S]*?)\n<<<END PATCH>>>/g, (_match, path: string, inner: string) => {
    const patches: Array<{ find: string; replace: string }> = [];
    const pairRe = /<<<FIND>>>\s*\n([\s\S]*?)\n<<<REPLACE>>>\s*\n([\s\S]*?)(?=\n<<<FIND>>>|\s*$)/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(inner)) !== null) {
      patches.push({ find: m[1], replace: m[2] });
    }
    if (patches.length) suggestions.push({ path: path.trim(), content: '', patches, kind: 'patch', status: 'pending' });
    return '';
  });
  body = body.replace(/<<<DELETE\s+([^>\n]+)>>>(?:\s*\n<<<END DELETE>>>)?/g, (_match, path: string) => {
    suggestions.push({ path: path.trim(), content: '', kind: 'delete', status: 'pending' });
    return '';
  });
  body.replace(/<<<FILE\s+([^>\n]+)>>>\s*\n([\s\S]*?)\n<<<END FILE>>>/g, (_match, path: string, content: string) => {
    suggestions.push({ path: path.trim(), content, kind: 'replace', status: 'pending' });
    return '';
  });
  return suggestions;
}

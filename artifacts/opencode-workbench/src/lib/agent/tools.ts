import type { MissionFileChange, ProjectFile, Suggestion } from '../workspace-store';
import { buildRepoMap } from '../project-map';

/**
 * Mission Mode tool executors. Read tools are pure functions over the
 * mission copy's files; change application mirrors the chat's reviewed
 * accept semantics (exact-match patch splice, all-or-nothing per patch).
 */

export type ToolPermission = 'auto' | 'approve';
export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  update_plan: 'auto',
  step_done: 'auto',
  step_failed: 'auto',
  list_files: 'auto',
  read_file: 'auto',
  search_code: 'auto',
  repo_map: 'auto',
  propose_change: 'approve',
  build_preview: 'auto',
  note: 'auto',
  ask_user: 'auto',
  complete_mission: 'auto',
  give_up: 'auto',
};

const SKIP_PARTS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo']);

export function normalizeMissionPath(input: string): string | null {
  const path = input.replaceAll('\\', '/');
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || /^[a-z]:\//i.test(path)) return null;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function isSensitiveMissionPath(path: string): boolean {
  const basename = path.split('/').pop() || '';
  return /^\.env(?:\.[^/]*)?$/i.test(basename)
    || /(?:^|[._-])(?:secret|secrets|credential|credentials|password|token|private[-_]?key)(?:[._-]|$)/i.test(basename)
    || /^id_(?:rsa|ed25519)$/i.test(basename)
    || /\.(?:pem|key|p12|pfx)$/i.test(basename);
}

export function isSafeMissionPath(path: string): boolean {
  const normalized = normalizeMissionPath(path);
  if (!normalized || isSensitiveMissionPath(normalized)) return false;
  return !normalized.split('/').some((part) => SKIP_PARTS.has(part.toLowerCase()));
}

/** Keep observations bounded so command/build output can't flood the context window. */
export function truncateObservation(text: string, max = 4200): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.62));
  const tail = text.slice(-Math.floor(max * 0.28));
  return `${head}\n…[${text.length - head.length - tail.length} chars truncated]…\n${tail}`;
}

function isLeaf(files: ProjectFile[], file: ProjectFile): boolean {
  return !files.some((candidate) => candidate.path.startsWith(`${file.path}/`));
}

export function execListFiles(files: ProjectFile[]): string {
  const leaves = files.filter((file) => isLeaf(files, file));
  if (!leaves.length) return 'The mission workspace has no files.';
  return leaves.map((file) => `${file.path} (${file.blob ? `${file.blob.size} B binary` : `${file.content.length} chars`})`).join('\n');
}

export function execReadFile(files: ProjectFile[], rawPath: string): { ok: boolean; text: string } {
  const path = normalizeMissionPath(rawPath);
  if (!path) return { ok: false, text: `Refused: "${rawPath}" is not a valid project-relative path.` };
  if (isSensitiveMissionPath(path)) return { ok: false, text: `Refused: ${path} looks like a credential file and is never shown to the model.` };
  const file = files.find((entry) => entry.path === path);
  if (!file) return { ok: false, text: `Not found: ${path}. Use list_files to see what exists.` };
  if (file.blob) return { ok: false, text: `${path} is a binary file (${file.blob.size} bytes); its content cannot be read as text.` };
  return { ok: true, text: `--- ${path} ---\n${file.content}` };
}

export function execSearchCode(files: ProjectFile[], query: string): string {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  for (const file of files) {
    if (file.blob || !isLeaf(files, file)) continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push(`${file.path}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        if (hits.length >= 60) return `${hits.join('\n')}\n…[stopped at 60 matches]`;
      }
    }
  }
  return hits.length ? hits.join('\n') : `No matches for "${query}".`;
}

export function execRepoMap(files: ProjectFile[]): string {
  return buildRepoMap(files);
}

export type ApplyOutcome = { files: ProjectFile[]; applied: string[]; errors: string[]; changes: MissionFileChange[] };

/**
 * Apply reviewed suggestions to a file list with the chat's semantics.
 * Patch application is all-or-nothing per suggestion: a non-matching FIND
 * changes nothing and is reported back so the agent can re-propose.
 */
export function applySuggestions(files: ProjectFile[], suggestions: Suggestion[]): ApplyOutcome {
  let next = files.map((file) => ({ ...file }));
  const applied: string[] = [];
  const errors: string[] = [];
  const beforeByPath = new Map<string, string | null>();
  const rememberBefore = (path: string) => {
    if (!beforeByPath.has(path)) {
      const current = next.find((file) => file.path === path);
      beforeByPath.set(path, current && !current.blob ? current.content : null);
    }
  };
  for (const suggestion of suggestions) {
    const path = normalizeMissionPath(suggestion.path);
    if (!path || !isSafeMissionPath(path)) {
      errors.push(`Refused unsafe path: ${suggestion.path}`);
      continue;
    }
    const kind = suggestion.kind || 'replace';
    if (kind === 'delete') {
      if (!next.some((file) => file.path === path)) { errors.push(`Delete skipped: ${path} does not exist.`); continue; }
      rememberBefore(path);
      next = next.filter((file) => file.path !== path);
      applied.push(`deleted ${path}`);
      continue;
    }
    if (kind === 'patch') {
      const current = next.find((file) => file.path === path);
      if (!current || current.blob) { errors.push(`Patch target ${path} is not an editable text file.`); continue; }
      let content = current.content;
      let failed = false;
      for (const patch of suggestion.patches || []) {
        const at = content.indexOf(patch.find);
        if (at === -1) { errors.push(`Patch for ${path} did not apply: a FIND block no longer matches the file exactly. Nothing was changed for this file.`); failed = true; break; }
        content = content.slice(0, at) + patch.replace + content.slice(at + patch.find.length);
      }
      if (failed) continue;
      rememberBefore(path);
      next = next.map((file) => file.path === path ? { ...file, content, size: new Blob([content]).size } : file);
      applied.push(`patched ${path}`);
      continue;
    }
    rememberBefore(path);
    const textFile: ProjectFile = { path, content: suggestion.content, mimeType: 'text/plain;charset=utf-8', size: new Blob([suggestion.content]).size };
    next = next.some((file) => file.path === path)
      ? next.map((file) => file.path === path ? textFile : file)
      : [...next, textFile];
    applied.push(`wrote ${path}`);
  }
  const changes: MissionFileChange[] = [];
  for (const [path, before] of beforeByPath) {
    const current = next.find((file) => file.path === path);
    const after = current && !current.blob ? current.content : null;
    if (before !== after) changes.push({ path, before, after });
  }
  return { files: next, applied, errors, changes };
}

/** Diff between two file lists (text files only), for checkpoints and merges. */
export function diffFileLists(base: ProjectFile[], current: ProjectFile[]): MissionFileChange[] {
  const changes: MissionFileChange[] = [];
  const baseMap = new Map(base.filter((f) => !f.blob).map((f) => [f.path, f.content]));
  const currentMap = new Map(current.filter((f) => !f.blob).map((f) => [f.path, f.content]));
  for (const [path, content] of currentMap) {
    if (!baseMap.has(path)) changes.push({ path, before: null, after: content });
    else if (baseMap.get(path) !== content) changes.push({ path, before: baseMap.get(path) ?? null, after: content });
  }
  for (const [path, content] of baseMap) {
    if (!currentMap.has(path)) changes.push({ path, before: content, after: null });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Restore a file list to the state captured at checkpoint `index`:
 * checkpoints store forward diffs, so restoring applies the inverse of
 * every later checkpoint in reverse order.
 */
export function restoreToCheckpoint(files: ProjectFile[], checkpoints: Array<{ changes: MissionFileChange[] }>, index: number): ProjectFile[] {
  let next = files.map((file) => ({ ...file }));
  for (let i = checkpoints.length - 1; i > index; i -= 1) {
    for (const change of [...checkpoints[i].changes].reverse()) {
      if (change.before === null) {
        next = next.filter((file) => file.path !== change.path);
      } else if (change.after === null || next.some((file) => file.path === change.path)) {
        const restored: ProjectFile = { path: change.path, content: change.before, mimeType: 'text/plain;charset=utf-8', size: new Blob([change.before]).size };
        next = next.some((file) => file.path === change.path)
          ? next.map((file) => file.path === change.path ? restored : file)
          : [...next, restored];
      }
    }
  }
  return next;
}


/* ---- v5.1: verification-tool approval policy ---- */

/** Read-only SQL (SELECT/WITH/PRAGMA/EXPLAIN) runs without approval; writes are gated. */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().toLowerCase();
  return /^(select|with|pragma|explain)\b/.test(stripped);
}

/** Extract an origin (protocol + host) for per-origin HTTP approvals. */
export function httpOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.slice(0, 60);
  }
}

export type ApprovalDecision = { needed: boolean; pattern: string; summary: string };

/**
 * The single place that decides whether a tool call needs a human gate.
 * Patterns are what "approve + remember" stores: tool name for python /
 * sql-writes / changes, tool@origin for HTTP, tool:<command> for runtime.
 */
export function approvalFor(
  tool: string,
  args: Record<string, unknown>,
  mission: { preset: string; remembered: string[] },
): ApprovalDecision {
  const remembered = mission.remembered || [];
  const deep = mission.preset === 'deep';
  switch (tool) {
    case 'propose_change':
      return { needed: !(deep || remembered.includes('propose_change')), pattern: 'propose_change', summary: 'Apply a change set to the mission copy' };
    case 'run_python': {
      const what = typeof args.path === 'string' ? `Run Python file ${args.path}` : 'Run a Python script';
      return { needed: !(deep || remembered.includes('run_python')), pattern: 'run_python', summary: what };
    }
    case 'run_sql': {
      const sql = String(args.sql || '');
      if (isReadOnlySql(sql)) return { needed: false, pattern: 'run_sql', summary: 'Read-only SQL query' };
      return { needed: !(deep || remembered.includes('run_sql')), pattern: 'run_sql', summary: `Write SQL against the workbench database: ${sql.slice(0, 120)}` };
    }
    case 'http_request': {
      const origin = httpOrigin(String(args.url || ''));
      const pattern = `http_request@${origin}`;
      const method = String(args.method || 'GET').toUpperCase();
      return { needed: !remembered.includes(pattern), pattern, summary: `${method} ${String(args.url || '').slice(0, 140)}` };
    }
    case 'run_runtime': {
      const command = String(args.command || '');
      const pattern = `run_runtime:${command}`;
      return { needed: !(deep || remembered.includes(pattern)), pattern, summary: `Run in the Node runtime: ${command}` };
    }
    default:
      return { needed: false, pattern: tool, summary: tool };
  }
}

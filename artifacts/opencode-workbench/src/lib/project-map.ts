// Project intelligence for the Workbench: a compact repo map and relevance
// ranking so the assistant sees the whole project, not just hand-picked files.

export type MapFile = { path: string; content: string; blob?: unknown };

const SYMBOL_PATTERNS: Array<RegExp> = [
  // TypeScript / JavaScript
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  // Python
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/,
  /^type\s+([A-Z]\w*)\s+(?:struct|interface)/,
  // Rust
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Z]\w*)/,
  // Java / C# / Kotlin / Swift
  /^\s*(?:public|private|protected|internal|final|abstract|static|\s)+?(?:class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/,
  // Ruby / PHP
  /^\s*def\s+([a-z_]\w*)/,
  /^\s*(?:public\s+|private\s+|protected\s+)?function\s+([A-Za-z_]\w*)/,
];

export function extractSymbols(content: string, max = 10): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    if (symbols.length >= max) break;
    if (line.length > 300) continue;
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        symbols.push(match[1]);
        break;
      }
    }
  }
  return symbols;
}

// Repo maps are rebuilt on every chat send and mission start, but a
// project's map only changes when its files do. Memoize by a cheap
// content fingerprint (path + length + sampled edge hash per file),
// persisted so a page reload doesn't recompute it either. Part of
// Context Density Phase 1: never spend the same computation twice.
const REPOMAP_CACHE_KEY = 'openforge-workbench-repomap-cache';
let repomapMemo: { fingerprint: string; map: string } | null = null;

function fnvSample(text: string): string {
  const sample = text.length > 4096 ? `${text.slice(0, 2048)}${text.slice(-2048)}` : text;
  let hash = 0x811c9dc5;
  for (let i = 0; i < sample.length; i += 1) {
    hash ^= sample.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function repomapFingerprint(files: MapFile[], maxChars: number): string {
  return `${maxChars}|${files.map((file) => `${file.path}:${file.blob ? 'b' : file.content.length}:${file.blob ? '' : fnvSample(file.content)}`).join('|')}`;
}

export function buildRepoMap(files: MapFile[], maxChars = 24_000): string {
  const fingerprint = repomapFingerprint(files, maxChars);
  if (repomapMemo && repomapMemo.fingerprint === fingerprint) return repomapMemo.map;
  try {
    const stored = JSON.parse(localStorage.getItem(REPOMAP_CACHE_KEY) || 'null') as { fingerprint: string; map: string } | null;
    if (stored && stored.fingerprint === fingerprint) {
      repomapMemo = stored;
      return stored.map;
    }
  } catch { /* cache is best-effort */ }
  const map = buildRepoMapUncached(files, maxChars);
  repomapMemo = { fingerprint, map };
  try { localStorage.setItem(REPOMAP_CACHE_KEY, JSON.stringify(repomapMemo)); } catch { /* best-effort */ }
  return map;
}

function buildRepoMapUncached(files: MapFile[], maxChars = 24_000): string {
  const lines: string[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    if (file.blob) {
      lines.push(`${file.path} (binary)`);
      continue;
    }
    const symbols = extractSymbols(file.content);
    const kb = Math.max(1, Math.round(file.content.length / 1024));
    lines.push(symbols.length ? `${file.path} (${kb} KB): ${symbols.join(', ')}` : `${file.path} (${kb} KB)`);
  }
  let map = lines.join('\n');
  if (map.length > maxChars) {
    map = `${map.slice(0, maxChars)}\n… (repo map truncated; ${sorted.length} files total)`;
  }
  return map;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter(
    (word, index, all) => all.indexOf(word) === index,
  );
}

/**
 * Rank text files by relevance to a query (the user's latest message).
 * Manual context picks always win; auto-selection only fills the budget.
 */
export function rankFilesByRelevance(files: MapFile[], query: string): MapFile[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const scored = files
    .filter((file) => !file.blob)
    .map((file) => {
      const pathLower = file.path.toLowerCase();
      const symbols = extractSymbols(file.content, 20).join(' ').toLowerCase();
      const contentLower = file.content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (pathLower.includes(term)) score += 6;
        if (symbols.includes(term)) score += 4;
        const hits = contentLower.split(term).length - 1;
        score += Math.min(hits, 5);
      }
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.file);
}

/** Character budget for file context, scaled to the model's context window. */
export function contextBudgetChars(contextLength: number | null | undefined): number {
  const tokens = contextLength && contextLength > 0 ? contextLength : 32_000;
  // ~3.5 chars per token for code; spend at most ~40% of the window on files,
  // leaving room for the conversation, the repo map, and the answer.
  const budget = Math.floor(tokens * 3.5 * 0.4);
  return Math.min(600_000, Math.max(24_000, budget));
}

export function perFileCapChars(budget: number): number {
  return Math.min(60_000, Math.max(12_000, Math.floor(budget / 4)));
}

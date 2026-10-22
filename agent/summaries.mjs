/**
 * Extractive file summaries + a content-hash cache (Context Density,
 * Phase 1, Layer 2 scoped to safe equivalence classes).
 *
 * A summary here is a PURE FUNCTION of file content — deterministic,
 * no model involved — so caching it by content hash can never serve
 * a stale or state-dependent answer: change the content, the hash
 * changes, the summary recomputes. The cache lives in
 * .openforge/cache/<hash>.json inside the workspace, so it persists
 * in git and compounds across the whole agent collective: a summary
 * one agent computes is a summary every future agent reuses.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = '.openforge/cache';
const SKIP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.mp3', '.mp4', '.bin', '.lock']);
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.rb', '.php', '.swift', '.kt', '.sh']);

export function contentHash(content) {
  return createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
}

const DECLARATION_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*class\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,
];

/** Deterministic extractive summary: structure + symbols + scale. */
export function extractiveSummary(relPath, content) {
  const text = String(content || '');
  const ext = path.extname(relPath).toLowerCase();
  const lineCount = text ? text.split('\n').length : 0;
  const parts = [`${lineCount} lines, ${text.length} chars`];
  if (ext === '.md' || ext === '.mdx' || ext === '.txt' || ext === '.rst') {
    const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1].trim()).slice(0, 8);
    if (headings.length) parts.push(`headings: ${headings.join(' · ')}`);
    const firstProse = text.split('\n').find((line) => line.trim() && !line.startsWith('#'));
    if (firstProse) parts.push(`opens: ${firstProse.trim().slice(0, 140)}`);
  } else if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parts.push(`keys: ${Object.keys(parsed).slice(0, 14).join(', ')}`);
      else if (Array.isArray(parsed)) parts.push(`array of ${parsed.length}`);
    } catch { parts.push('unparseable json'); }
  } else if (CODE_EXTENSIONS.has(ext)) {
    const symbols = [];
    for (const line of text.split('\n')) {
      for (const pattern of DECLARATION_PATTERNS) {
        const match = line.match(pattern);
        if (match) { symbols.push(match[1]); break; }
      }
      if (symbols.length >= 14) break;
    }
    if (symbols.length) parts.push(`symbols: ${symbols.join(', ')}`);
  } else {
    const firstLines = text.split('\n').filter((line) => line.trim()).slice(0, 2).map((line) => line.trim().slice(0, 90));
    if (firstLines.length) parts.push(`opens: ${firstLines.join(' / ')}`);
  }
  return parts.join(' · ').slice(0, 460);
}

/** Lexical relevance of a file (path + summary) to the mission goal. */
export function scoreFileRelevance(goal, relPath, summary) {
  const terms = [...new Set(String(goal || '').toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4))];
  if (!terms.length) return 0;
  const pathText = relPath.toLowerCase();
  const summaryText = String(summary || '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (pathText.includes(term)) score += 3;
    if (summaryText.includes(term)) score += 1;
  }
  return score;
}

export async function loadSummaryCache(root) {
  const cache = new Map();
  const dir = path.join(root, CACHE_DIR);
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, entry), 'utf8'));
        if (parsed && parsed.summary) cache.set(entry.replace(/\.json$/, ''), parsed);
      } catch { /* a corrupt cache entry is a miss, never a failure */ }
    }
  } catch { /* no cache yet */ }
  return cache;
}

export async function getOrComputeSummary(root, cache, relPath, content) {
  const hash = contentHash(content);
  const hit = cache.get(hash);
  if (hit) return { summary: hit.summary, fromCache: true, hash };
  const summary = extractiveSummary(relPath, content);
  const entry = { path: relPath, summary, at: new Date().toISOString() };
  cache.set(hash, entry);
  try {
    await mkdir(path.join(root, CACHE_DIR), { recursive: true });
    await writeFile(path.join(root, CACHE_DIR, `${hash}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  } catch { /* the cache is an optimization; never fail a mission over it */ }
  return { summary, fromCache: false, hash };
}

/**
 * Build the briefing's KEY FILE SUMMARIES section: the most
 * goal-relevant files, summarized extractively (cached by content
 * hash). The agent starts oriented instead of spending its first
 * reads discovering structure.
 */
async function scoreWorkspaceFiles(root, relPaths, goal, { maxFileChars = 200000 } = {}) {
  const cache = await loadSummaryCache(root);
  const scored = [];
  for (const rel of relPaths) {
    if (rel.startsWith('.openforge/')) continue;
    if (SKIP_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    const abs = path.join(root, rel);
    if (!abs.startsWith(root) || !existsSync(abs)) continue;
    let content;
    try { content = await readFile(abs, 'utf8'); } catch { continue; }
    if (content.length > maxFileChars) continue;
    const { summary } = await getOrComputeSummary(root, cache, rel, content);
    scored.push({ rel, summary, score: scoreFileRelevance(goal, rel, summary) });
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  return scored;
}

export async function buildBriefingSummaries(root, relPaths, goal, { limit = 8, maxFileChars = 200000 } = {}) {
  const scored = await scoreWorkspaceFiles(root, relPaths, goal, { maxFileChars });
  const top = scored.slice(0, limit);
  if (!top.length) return '';
  const lines = top.map((entry) => `- ${entry.rel} — ${entry.summary}`);
  return `\n\nKEY FILE SUMMARIES (extractive, cached by content hash — orientation only; read a file before changing it):\n${lines.join('\n')}`;
}

/**
 * The workspace file list for a briefing, relevance-ranked: scored
 * files first (most goal-relevant at the top, so they survive the
 * briefing's file-list cap), unscored/skipped files after, in their
 * original order.
 */
export async function rankWorkspaceFiles(root, relPaths, goal) {
  const scored = await scoreWorkspaceFiles(root, relPaths, goal);
  const scoredPaths = new Set(scored.map((entry) => entry.rel));
  const rest = relPaths.filter((rel) => !scoredPaths.has(rel));
  return [...scored.map((entry) => entry.rel), ...rest];
}

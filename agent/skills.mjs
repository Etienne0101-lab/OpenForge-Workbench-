/**
 * OpenForge skill library — persistent memory for temporary agents.
 *
 * Agents are ephemeral; skills are not. A skill is a small markdown file
 * in .openforge/skills/ (frontmatter: name, tags, task_classes) capturing
 * a reusable procedure, pattern, or pitfall. The library lives in the
 * project repository, so it persists through git: agents recall skills at
 * mission start, deposit new ones with the learn_skill tool, and the
 * swarm integrator keeps the index consistent after merges. Counters in
 * index.json track how often each skill is used and how often the
 * missions that used it succeeded — the library curates itself by data.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SKILLS_DIR = '.openforge/skills';
export const INDEX_PATH = '.openforge/skills/index.json';

export function slugify(name) {
  return String(name || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

export function parseSkill(text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(text || ''));
  if (!match) return { meta: {}, body: String(text || '') };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: match[2].trim() };
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function scanSkills(root) {
  const dir = path.join(root, SKILLS_DIR);
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.md')).sort()) {
    const text = await readFile(path.join(dir, file), 'utf8');
    const { meta, body } = parseSkill(text);
    entries.push({
      slug: file.replace(/\.md$/, ''),
      name: meta.name || file.replace(/\.md$/, ''),
      tags: splitList(meta.tags),
      taskClasses: splitList(meta.task_classes),
      excerpt: body.replace(/\s+/g, ' ').slice(0, 240),
      body,
    });
  }
  return entries;
}

/** (Re)build index.json from the skill files, preserving use counters. */
export async function rebuildSkillsIndex(root) {
  const scanned = await scanSkills(root);
  let previous = {};
  try {
    const parsed = JSON.parse(await readFile(path.join(root, INDEX_PATH), 'utf8'));
    for (const skill of parsed.skills || []) previous[skill.slug] = skill;
  } catch { /* first build */ }
  const skills = scanned.map(({ body, ...rest }) => ({
    ...rest,
    uses: previous[rest.slug]?.uses || 0,
    successes: previous[rest.slug]?.successes || 0,
  }));
  await mkdir(path.join(root, SKILLS_DIR), { recursive: true });
  await writeFile(path.join(root, INDEX_PATH), JSON.stringify({ version: 1, skills }, null, 2), 'utf8');
  return skills;
}

export async function listSkills(root) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, INDEX_PATH), 'utf8'));
    if (Array.isArray(parsed.skills) && parsed.skills.length) return parsed.skills;
  } catch { /* fall through to a scan */ }
  return scanSkills(root);
}

/** Keyword/tag/class-scored retrieval. Returns entries including bodies. */
export async function searchSkills(root, queryText, taskClass, limit = 3) {
  const all = await listSkills(root);
  if (!all.length) return [];
  const words = new Set(String(queryText || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const scored = all.map((skill) => {
    let score = 0;
    for (const tag of skill.tags) if (words.has(tag)) score += 3;
    if (taskClass && skill.taskClasses.includes(taskClass)) score += 2;
    const haystack = `${skill.name} ${skill.excerpt}`.toLowerCase();
    for (const word of words) if (haystack.includes(word)) score += 1;
    score += Math.min(skill.successes || 0, 5) * 0.2; // proven skills float up
    return { skill, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit).map((entry) => entry.skill);
  // Attach bodies (index entries may already carry them from a scan).
  const withBodies = [];
  for (const skill of picked) {
    if (skill.body) { withBodies.push(skill); continue; }
    try {
      const text = await readFile(path.join(root, SKILLS_DIR, `${skill.slug}.md`), 'utf8');
      withBodies.push({ ...skill, body: parseSkill(text).body });
    } catch { withBodies.push(skill); }
  }
  return withBodies;
}

/** Deposit or update a skill. Returns the slug. */
export async function writeSkill(root, { name, tags, taskClasses, content }) {
  const slug = slugify(name);
  await mkdir(path.join(root, SKILLS_DIR), { recursive: true });
  const frontmatter = [
    '---',
    `name: ${name}`,
    `tags: ${(tags || []).join(', ')}`,
    `task_classes: ${(taskClasses || []).join(', ')}`,
    '---',
    '',
  ].join('\n');
  await writeFile(path.join(root, SKILLS_DIR, `${slug}.md`), frontmatter + String(content || '').trim() + '\n', 'utf8');
  await rebuildSkillsIndex(root);
  return slug;
}

/** Bump use/success counters after a mission that recalled skills. */
export async function recordSkillOutcomes(root, slugs, success) {
  if (!slugs.length) return;
  const skills = await rebuildSkillsIndex(root);
  let changed = false;
  for (const skill of skills) {
    if (slugs.includes(skill.slug)) {
      skill.uses += 1;
      if (success) skill.successes += 1;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(path.join(root, INDEX_PATH), JSON.stringify({ version: 1, skills }, null, 2), 'utf8');
  }
}

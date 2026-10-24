#!/usr/bin/env node
/**
 * OpenForge swarm planner — decomposes a mission goal into independent
 * parallel tasks for worker agents.
 *
 * One model call. Output: swarm-plan.json in the working directory and,
 * under GitHub Actions, `tasks` / `count` step outputs (the workflow
 * builds its worker matrix from them). If anything goes wrong — bad
 * model reply, unavailable model — the plan degrades to a single task
 * containing the whole goal, so a swarm run never dies at the plan gate.
 *
 * Env: SWARM_GOAL (required), OPENROUTER_API_KEY (required),
 * AGENT_MODEL, SWARM_WORKERS (max tasks, default 3), OPENROUTER_BASE_URL.
 */

import { appendFile, writeFile } from 'node:fs/promises';
import { FALLBACK_MODELS, createResilientCaller, parseAgentReply, walkFiles } from './agent-core.mjs';
import { ModelRouter, classifyTask, fetchFreeModelIds, loadStats } from './model-router.mjs';

const goal = process.env.SWARM_GOAL;
const apiKeys = (process.env.OPENROUTER_API_KEYS || process.env.OPENROUTER_API_KEY || '').split(/[\n,]/).map((key) => key.trim()).filter(Boolean);
if (!goal) { console.error('SWARM_GOAL is required.'); process.exit(2); }
if (!apiKeys.length) { console.error('OPENROUTER_API_KEY secret is not set.'); process.exit(2); }

const maxTasks = Math.max(1, Math.min(6, Number(process.env.SWARM_WORKERS || 3)));
const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const files = await walkFiles(process.cwd());

const PLANNER_PROMPT = `You are the planner for a swarm of coding agents who will work IN PARALLEL, each in its own copy of the same repository, on separate branches. Decompose the mission goal into at most ${maxTasks} INDEPENDENT tasks whose results can be merged afterwards. Tasks must not depend on each other's output; prefer partitioning by file area or by clearly separable concern. If the goal is inherently one indivisible task, return exactly one task covering the whole goal.

Reply with EXACTLY ONE JSON object and nothing else:
{"tasks":[{"title":"short title","instructions":"complete, self-contained instructions for one worker agent — everything it needs, since it cannot see the other tasks","scope":"the files/areas this task should touch"}]}`;

async function plan() {
  const stats = await loadStats(process.cwd());
  const { loadOrganismDirectives } = await import('./organism.mjs');
  const organismDirectives = await loadOrganismDirectives(process.cwd());
  if (organismDirectives.exploreClasses.length || stats.organism) {
    stats.organism = { exploreClasses: organismDirectives.exploreClasses, updatedAt: organismDirectives.updatedAt || Date.now() };
  }
  const router = new ModelRouter({
    stats,
    catalogIds: [...FALLBACK_MODELS, ...(await fetchFreeModelIds(baseUrl))],
    pinnedModel: process.env.AGENT_MODEL && process.env.AGENT_MODEL !== 'auto' ? process.env.AGENT_MODEL : null,
    organismDirectives: organismDirectives.exploreClasses,
  });
  const { calibrateKeys, describeKeyInfo, pickStartKeyIndex } = await import('./quota.mjs');
  const keyInfos = await calibrateKeys(baseUrl, apiKeys);
  keyInfos.forEach((info, index) => console.error(`[quota] ${describeKeyInfo(info, index)}`));
  const caller = createResilientCaller({
    baseUrl,
    apiKeys,
    router,
    taskClass: classifyTask(goal),
    startKeyIndex: process.env.AGENT_KEY_INDEX !== undefined ? Number(process.env.AGENT_KEY_INDEX) : pickStartKeyIndex(keyInfos),
    onEvent: (_type, text) => console.error(text),
  });
  try {
    const { content } = await caller.send([
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: `MISSION GOAL: ${goal}\n\nREPOSITORY FILES (${files.length}):\n${files.slice(0, 200).join('\n')}` },
    ]);
    const parsed = parseAgentReply(content);
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.filter((task) => task && task.title && task.instructions).slice(0, maxTasks) : [];
    if (tasks.length) return tasks.map((task) => ({ title: String(task.title), instructions: String(task.instructions), scope: String(task.scope || '') }));
    console.error('Planner returned no usable tasks.');
  } catch (error) {
    console.error(`Planner failed on every model/key combination: ${error instanceof Error ? error.message : 'error'}`);
  }
  return null;
}

const tasks = (await plan()) || [{ title: 'Full mission (planner fallback)', instructions: goal, scope: 'the whole workspace' }];
console.log(`Swarm plan: ${tasks.length} task(s)`);
tasks.forEach((task, index) => console.log(`  ${index + 1}. ${task.title}`));
await writeFile('swarm-plan.json', JSON.stringify({ goal, tasks }, null, 2), 'utf8');
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `tasks=${JSON.stringify(tasks)}\ncount=${tasks.length}\n`, 'utf8');
}

#!/usr/bin/env node
/**
 * OpenForge scheduler — turns .openforge/schedule.json into due missions.
 *
 * Run by the OpenForge Scheduler workflow on a cron tick (or manually
 * with --force <id>). The design is deliberately state-based: each entry
 * remembers when it last ran, and a tick simply asks "has a scheduled
 * slot passed since then?" — so a delayed or dropped tick delays a
 * mission but never loses or duplicates it. Dispatches go to the same
 * OpenForge Agent / Swarm workflows a human uses, tagged with the entry
 * id (run-name carries [sched:<id>]) so an already-running scheduled
 * mission is never double-dispatched, and a manifest-wide concurrency
 * cap keeps scheduled work from starving the shared API-key quota.
 *
 * Missions dispatched from here are ordinary missions: model "auto"
 * means the learned router picks — and every scheduled run's outcomes
 * feed the same statistics that route the next one.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SCHEDULE_PATH = '.openforge/schedule.json';
export const AGENT_WORKFLOW = 'openforge-agent.yml';
export const SWARM_WORKFLOW = 'openforge-swarm.yml';
export const CADENCE_CRONS = {
  hourly: '3 * * * *',
  daily: '7 13 * * *',
  weekdays: '7 13 * * 1-5',
  weekly: '7 13 * * 1',
};

/* ---------- mini cron (UTC, Vixie dom/dow rule) ---------- */

function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(',')) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const range = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(range);
      if (rangeMatch) { lo = Number(rangeMatch[1]); hi = Number(rangeMatch[2]); }
      else { lo = hi = Number(range); }
    }
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

export function cronMatches(cron, date) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  if (!parseCronField(minute, 0, 59).has(date.getUTCMinutes())) return false;
  if (!parseCronField(hour, 0, 23).has(date.getUTCHours())) return false;
  if (!parseCronField(month, 1, 12).has(date.getUTCMonth() + 1)) return false;
  const domSet = parseCronField(dom, 1, 31);
  const dowSet = parseCronField(dow, 0, 7);
  if (dowSet.has(7)) { dowSet.delete(7); dowSet.add(0); }
  const domHit = domSet.has(date.getUTCDate());
  const dowHit = dowSet.has(date.getUTCDay());
  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  if (domRestricted && dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

/** Latest minute-aligned slot at or before `date`, searching back 8 days. */
export function lastSlotBefore(cron, date) {
  const cursor = new Date(date.getTime());
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i += 1) {
    if (cronMatches(cron, cursor)) return cursor.getTime();
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
  }
  return null;
}

export function entryCron(entry) {
  return entry.cron || CADENCE_CRONS[entry.cadence] || CADENCE_CRONS.daily;
}

export function dueSlot(entry, nowMs) {
  if (!entry.enabled) return null;
  const baseline = Date.parse(entry.lastRunAt || entry.createdAt || '') || 0;
  const slot = lastSlotBefore(entryCron(entry), new Date(nowMs));
  return slot !== null && slot > baseline ? slot : null;
}

/* ---------- GitHub via the gh CLI (injectable for tests) ---------- */

function execGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 60000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

export function makeGh(repo) {
  return {
    async listRuns(workflowFile) {
      const result = await execGh(['api', `repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=20`]);
      if (result.code !== 0) return [];
      try { return JSON.parse(result.stdout).workflow_runs || []; } catch { return []; }
    },
    async branchSha(ref) {
      const result = await execGh(['api', `repos/${repo}/branches/${ref}`]);
      if (result.code !== 0) return '';
      try { return JSON.parse(result.stdout).commit.sha || ''; } catch { return ''; }
    },
    async createBranch(name, sha) {
      const payload = path.join(tmpdir(), `openforge-ref-${Date.now()}.json`);
      await writeFile(payload, JSON.stringify({ ref: `refs/heads/${name}`, sha }), 'utf8');
      const result = await execGh(['api', `repos/${repo}/git/refs`, '--method', 'POST', '--input', payload]);
      if (result.code !== 0) console.error(`gh create branch ${name} failed: ${(result.stderr || result.stdout || '').split('\n')[0]}`);
      return result.code === 0;
    },
    async dispatch(workflowFile, ref, inputs) {
      const payload = path.join(tmpdir(), `openforge-dispatch-${Date.now()}.json`);
      await writeFile(payload, JSON.stringify({ ref, inputs }), 'utf8');
      const result = await execGh(['api', `repos/${repo}/actions/workflows/${workflowFile}/dispatches`, '--method', 'POST', '--input', payload]);
      if (result.code !== 0) console.error(`gh dispatch ${workflowFile} failed: ${(result.stderr || result.stdout || '').split('\n')[0]}`);
      return result.code === 0;
    },
  };
}

/* ---------- The tick ---------- */

export async function runScheduler({ root, repo, ref = 'main', now = Date.now(), forceId = '', gh, dryRun = false, log = console.log }) {
  const manifestFile = path.join(root, SCHEDULE_PATH);
  if (!existsSync(manifestFile)) { log('No schedule manifest — nothing to do.'); return []; }
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const maxConcurrent = manifest.maxConcurrent || 2;
  const runsCache = {};
  const runsFor = async (file) => runsCache[file] || (runsCache[file] = await gh.listRuns(file));
  const decisions = [];
  let dispatched = 0;

  for (const entry of entries) {
    const workflowFile = entry.mode === 'swarm' ? SWARM_WORKFLOW : AGENT_WORKFLOW;
    const runs = await runsFor(workflowFile);
    const active = runs.filter((run) => ['queued', 'in_progress', 'waiting'].includes(run.status));
    const alreadyRunning = active.some((run) => String(run.display_title || '').includes(`[sched:${entry.id}]`));
    const forced = forceId && forceId === entry.id;
    const slot = forced ? now : dueSlot(entry, now);
    let action;
    if (!entry.enabled && !forced) action = 'skipped (disabled)';
    else if (slot === null) action = 'skipped (not due)';
    else if (alreadyRunning) action = 'skipped (already running)';
    else {
      const totalActive = (await Promise.all([runsFor(AGENT_WORKFLOW), runsFor(SWARM_WORKFLOW)]))
        .flat().filter((run) => ['queued', 'in_progress', 'waiting'].includes(run.status)).length;
      if (totalActive + dispatched >= maxConcurrent) action = `deferred (concurrency cap ${maxConcurrent})`;
      else {
        const inputs = entry.mode === 'swarm'
          ? { goal: entry.goal, model: entry.model || 'auto', workers: String(entry.workers || 3), max_steps: String(entry.maxSteps || 40), swarm_id: `sched-${entry.id}`.slice(0, 40), base_branch: entry.baseBranch || 'main', schedule_id: entry.id }
          : { goal: entry.goal, model: entry.model || 'auto', max_steps: String(entry.maxSteps || 40), base_branch: entry.baseBranch || 'main', schedule_id: entry.id };
        // Agent missions run on a dedicated branch so their commits
        // arrive as a reviewable pull request, never directly on the
        // base branch. (Swarms branch themselves; they stay on ref.)
        let dispatchRef = ref;
        let branchNote = '';
        if (entry.mode === 'agent' && !dryRun && typeof gh.branchSha === 'function' && typeof gh.createBranch === 'function') {
          const stamp = new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 12);
          const branchName = `openforge/sched-${entry.id}-${stamp}`.slice(0, 80);
          const sha = await gh.branchSha(entry.baseBranch || 'main');
          if (sha && (await gh.createBranch(branchName, sha))) { dispatchRef = branchName; branchNote = ` on ${branchName}`; }
          else branchNote = ' (branch creation failed — running on the base ref)';
        }
        let ok = dryRun ? true : await gh.dispatch(workflowFile, dispatchRef, inputs);
        let untagged = false;
        if (!ok && !dryRun) {
          // A repo whose agent/swarm workflows predate the schedule_id
          // input rejects the dispatch (422 Unexpected inputs). Degrade
          // gracefully: dispatch untagged — dedupe then leans on the
          // manifest state + concurrency cap instead of run titles.
          const { schedule_id, ...rest } = inputs;
          ok = await gh.dispatch(workflowFile, ref, rest);
          untagged = ok;
        }
        action = ok ? `${dryRun ? 'would dispatch' : 'dispatched'} ${entry.mode} via ${workflowFile}${branchNote}${untagged ? ' (untagged — refresh the agent/swarm workflow files for dedupe tags)' : ''}` : 'dispatch FAILED (will retry next tick)';
        if (ok && !dryRun) {
          entry.lastRunAt = new Date(now).toISOString();
          entry.runCount = (entry.runCount || 0) + 1;
          dispatched += 1;
        }
      }
    }
    entry.lastDecision = action;
    decisions.push({ id: entry.id, name: entry.name, action });
    log(`[sched:${entry.id}] ${entry.name || entry.goal} — ${action}`);
  }
  if (!dryRun) {
    manifest.updatedAt = new Date(now).toISOString();
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
  }
  return decisions;
}

/* ---------- CLI ---------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const forceId = args.includes('--force') ? args[args.indexOf('--force') + 1] || '' : '';
  const dryRun = args.includes('--dry-run');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) { console.error('GITHUB_REPOSITORY is not set.'); process.exit(1); }
  await runScheduler({ root: process.cwd(), repo, ref: process.env.SCHEDULER_REF || 'main', forceId, dryRun, gh: makeGh(repo) });
}

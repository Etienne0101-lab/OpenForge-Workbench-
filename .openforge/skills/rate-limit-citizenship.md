---
name: Rate-limit citizenship on free models
tags: rate limit, 429, openrouter, free models, swarm
task_classes: ops, code, general
---
Free model tiers cap requests per key and per model, and parallel agents share that budget. Work like a citizen of a shared commons:

1. Batch your thinking: decide the next several actions before calling tools one message at a time; avoid trivial single-purpose calls.
2. If a call fails with a rate-limit error, do not retry in a tight loop — the platform backs off and rotates keys/models for you; use the pause to re-check your plan instead.
3. Prefer one thorough verification pass (a single script that checks everything) over many small probes.
4. In a swarm, stay strictly inside your task's scope: duplicated work across workers doubles quota burn for zero gain.

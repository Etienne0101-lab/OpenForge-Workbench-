---
name: Verify before claiming
tags: verification, testing, shell, evidence
task_classes: code, tests, ops, general
---
Never report success you have not observed. For every claim in your summary, point to evidence you actually produced during this mission: a command you ran and its output, a file you read back after writing, a test that passed.

Procedure:
1. After creating or changing files, re-read at least the critical ones (or list them with sizes) — writes can silently fail or land somewhere unexpected.
2. Run the project's own checks when they exist (tests, build, typecheck, a smoke run of the script) and read the FULL output, not just the exit code.
3. In complete_mission's `verified` list, name only the tools you actually executed (e.g. "run_shell") — the platform cross-checks claims against recorded executions and strikes unverified ones.
4. If a verification fails, repair and re-verify; if it cannot pass, say so plainly in the summary with the failing output quoted.

---
name: Docs must match reality
tags: documentation, readme, accuracy, claims
task_classes: docs
---
Documentation that describes features as live when they are unbuilt or untested is a defect, not marketing.

Procedure:
1. Before writing that something works, works "live", or is verified, check the evidence in the workspace (code paths, tests, run records). If you cannot find evidence, write "designed" / "implemented, awaiting verification" instead.
2. Match names, paths, commands, and defaults EXACTLY to the code (read the file; do not write from memory).
3. When you change behavior, update the docs in the same change set — stale docs are treated as bugs by the next agent who trusts them.
4. Keep honest bounds visible: what the thing cannot do belongs in the doc next to what it can.

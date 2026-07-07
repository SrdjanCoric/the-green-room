# Project Instructions

## Active plan

- The project's master plan is `plans/agentic-interview-coach-plan.md` — a durable architectural
  header plus an ordered list of task pointers. Task bodies live in `plans/tasks/`; finished
  tasks move to `plans/tasks/done/`.
- When `/implement-next-task` is invoked without an argument, take the first eligible unfinished
  (`- [ ]`) pointer whose `(after …)` prerequisites are all merged. When `/to-plan` runs, append
  new task file(s) + pointer(s) to this same plan; never create a second plan.

## Standing rules (mandatory — apply to every task, commit, and PR)

1. **From-scratch framing.** This is a ground-up Mastra application. Never reference porting, a
   prior implementation, another framework, or any pre-existing codebase in commit messages, PR
   titles/descriptions, code comments, or committed docs. The git history must read as an app
   built from scratch on Mastra.
2. **Docs-first, never assume.** Before implementing any task, re-verify every Mastra API used
   against the live docs at https://mastra.ai/docs and https://mastra.ai/reference. Mastra v1
   changed many signatures (agent `.generate`/`.stream`; `createWorkflow`/`createStep`/`createRun`;
   `runtimeContext`→`requestContext` inside steps/tools; processors under `@mastra/core/processors`;
   scorers under `@mastra/evals`; workflow snapshot/time-travel APIs). Do not write Mastra APIs
   from memory, and do not assume an option or import path — confirm it.

## Local working notes

- `plans/SOURCES.local.md` holds implementation asset pointers and is **gitignored** — it never
  ships. Committed files must not reproduce its contents.

## Security

- Never read or modify `.env` or any file holding secrets.

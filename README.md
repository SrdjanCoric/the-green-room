# Interview Coach

An agentic behavioral-interview coach built on [Mastra](https://mastra.ai). It runs a mock
interview against your CV and a target job, adapts its questions turn by turn, then grades every
answer and writes a coaching report.

This is the walking skeleton: a registered Mastra instance (LibSQL storage + native
observability), one trivial `ping` workflow, and a CLI that runs it in-process. Every later
feature hangs off this spine.

## Requirements

- Node.js ≥ 22.13
- An Anthropic API key

## Quickstart

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY
```

Run the CLI. It drives the `ping` workflow end-to-end and prints the echoed result:

```bash
npm run cli -- "hello"
# → Echoed: hello
```

Omit the message and the CLI prompts for one.

## Studio

Serve Studio over the same database the CLI writes to, then open it to inspect runs and their
traces:

```bash
npm run dev            # http://localhost:4111
```

Each workflow run appears under observability as a trace.

## Development

```bash
npm test               # run the test suite (vitest)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
```

Workflow snapshots, memory, and traces persist to `./data/` (gitignored).

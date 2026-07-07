# Interview Coach

An agentic behavioral-interview coach built on [Mastra](https://mastra.ai). It runs a mock
interview against your CV and a target job, adapts its questions turn by turn, then grades every
answer and writes a coaching report.

Under the hood it's one Mastra workflow: it reads your CV into a candidate profile, turns a job
posting into role context, gathers a short company brief, runs an adaptive question loop
(suspending after each question to wait for your answer), then grades the session and writes a
Markdown report. A LibSQL database holds workflow snapshots, memory, and traces, so an interrupted
interview can be resumed and every run shows up in Studio. The coach is grounded in a small
retrieval corpus (see [Coaching knowledge](#coaching-knowledge-rag)) so its advice cites a real
answer-craft methodology rather than generic tips.

## Requirements

- Node.js ≥ 22.13
- An Anthropic API key (interview, grading, coaching)
- An OpenAI API key — only for the coach's retrieval (embeddings); the interview runs without it

## Setup

```bash
npm install
cp .env.example .env   # then set ANTHROPIC_API_KEY (and OPENAI_API_KEY for coach RAG)
```

## Running an interview

`interview` is the default command, so both of these start a mock interview:

```bash
npm run cli -- --cv ./cv.pdf --job https://example.com/careers/staff-engineer
npm run cli -- interview --cv ./cv.pdf
```

You answer each question in the terminal (type your answer, then a line containing only `/done`).
When the interview finishes it prints the closing summary, the transcript, and the path to the
coaching report.

### `interview` flags

| Flag             | Required | Description                                                             |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `--cv <path>`    | yes      | Candidate CV to interview against (`.pdf`, `.txt`, or `.md`).           |
| `--job <src>`    | no       | Job posting as a URL, a file path, or pasted text. A failed URL fetch falls back to a paste prompt. |
| `--level <level>`| no       | Target seniority (e.g. `junior`, `senior`, `staff`). Omit to be asked.  |
| `--provider <name>` | no    | Model provider for both tiers (default: `anthropic`).                   |
| `--fast-model <id>` | no    | Model id for the fast tier (CV/role parsers, interviewer, research).    |
| `--smart-model <id>`| no    | Model id for the smart tier (director, grader, coach).                  |
| `--candidate <id>`  | no    | Stable candidate id; keys resource-scoped working memory across sessions. |

## Resuming an interview

Each interview is durable. If you stop partway through, resume it:

```bash
npm run cli -- resume              # resumes the most recent interview
npm run cli -- resume --run <id>   # resumes a specific run
```

## Reviewing reports

Coaching reports are written as Markdown under `./data/reports/`. List them newest-first:

```bash
npm run cli -- reports
```

## Coaching knowledge (RAG)

The coach grounds its per-answer fixes in a `how-to-answer` corpus: a set of markdown notes on
answer craft (STAR structure, quantifying results, owning your part, scoping stories to a level).
The notes are chunked, embedded with OpenAI `text-embedding-3-small`, and stored in a LibSQL vector
index at `./data/knowledge.db` (gitignored). When the coach writes advice, it retrieves the most
relevant guidance for each weak answer and grounds the fix in it.

Build the index before your first coached run:

```bash
npm run ingest
```

`ingest` requires `OPENAI_API_KEY` (embedding uses the same model at ingest and query time). It
reads from your **private corpus** at `knowledge/how-to-answer/` when that directory holds markdown,
and otherwise falls back to the **committed samples** at `knowledge/samples/`, so it works out of
the box:

```
knowledge/
  how-to-answer/     # your private corpus — gitignored, user-supplied (*.md)
  samples/           # committed synthetic examples used when the private corpus is absent
```

Drop your own `*.md` guidance into `knowledge/how-to-answer/` and re-run `npm run ingest` to
replace the index with your corpus. Only `knowledge/samples/` is committed; the private corpus and
the vector database never ship.

## Studio

Studio serves over the same database the CLI writes to, so you can inspect runs and their traces:

```bash
npm run dev            # http://localhost:4111
```

Each workflow run appears under observability as a trace, and a suspended interview shows up as a
run you can inspect between turns.

## Development

```bash
npm test               # run the test suite (vitest)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
```

Workflow snapshots, memory, traces, and reports persist under `./data/` (gitignored).

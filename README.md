# The Green Room

An agentic behavioral-interview coach built on [Mastra](https://mastra.ai). It runs a mock
interview against your CV and a target job, adapts its questions turn by turn, then grades every
answer and writes a coaching report.

The app is one Mastra workflow: it reads your CV into a candidate profile, turns a job posting
into role context, gathers a short company brief, runs an adaptive question loop (pausing after
each question for your answer), then grades the session and writes a Markdown report. A LibSQL
database holds workflow snapshots, memory, and traces, so an interrupted interview can be resumed
and every run shows up in Studio. The coach grounds its advice in a retrieval index of
answer-craft guidance (see [Coaching knowledge](#coaching-knowledge)).

## Requirements

- Node.js ≥ 22.13
- An Anthropic API key (interview, grading, coaching)
- An OpenAI API key (embeddings for the coach's retrieval; the interview itself runs without it)
- Optional: an ElevenLabs API key for spoken questions in the browser

## Setup

```bash
npm install
cd web && npm install && cd ..
cp .env.example .env   # then set ANTHROPIC_API_KEY (and OPENAI_API_KEY for coached advice)
```

Set `ELEVENLABS_API_KEY` to speak browser interview questions. The API key alone uses the built-in
Bella English voice and Eleven Flash v2.5. `ELEVENLABS_VOICE_ID` and
`ELEVENLABS_TTS_MODEL` can override those server-side defaults.

## Running an interview in the browser

The web UI is a React single-page app in `web/` that drives the interview over SSE streaming. It
needs two processes: the Mastra API server and the Vite dev server.

```bash
# Terminal 1: the Mastra API server (also serves Studio)
npm run dev                     # http://localhost:4111

# Terminal 2: the web UI
cd web && npm run dev           # http://localhost:5173
```

Open http://localhost:5173 and run an interview:

1. Upload your CV (`.pdf`, `.txt`, or `.md`).
2. Give the job posting as a link or pasted text.
3. Click **Raise the curtain**. The interviewer asks which seniority level to target (junior,
   mid-level, senior, or staff), then asks questions one at a time. When ElevenLabs is configured,
   the browser waits for each complete question, speaks it, and reveals the text from ElevenLabs'
   character timing. The answer card appears after playback. Without voice, questions use the
   typed reveal.
4. Answer each question in the cue card and deliver it. When the interviewer has enough signal,
   the session ends and the coaching report streams in, with the full transcript and advice for
   each answer.

The sidebar lists your past runs, and opening a finished one shows its report. The Vite server
proxies `/api`, `/prepare-interview`, and `/voice` to `http://localhost:4111`, so the browser stays
same-origin and needs no CORS setup. Point the proxy at another host with `MASTRA_SERVER_URL`.

Voice is limited to browser interview questions. The target-level prompt, closing, report, and CLI
stay silent. The browser checks `GET /voice/capabilities` when an interview starts. The response
contains only a capability boolean; the API key and voice settings stay on the Mastra server.
Speech or playback errors, including audio decoding failures, show the complete question and
enable the typed answer. The next question tries voice again.

If questions stay in text mode, restart the Mastra server after setting `ELEVENLABS_API_KEY`, then
open `http://localhost:5173/voice/capabilities`. A configured server returns `{"speech":true}`.
A failed capability request keeps text mode, as does `{"speech":false}` or a browser without MP3
playback support.

Build the UI for static hosting with `cd web && npm run build` (output in `web/dist/`,
gitignored).

## Running an interview in the terminal

`interview` is the default CLI command, so both of these start one:

```bash
npm run cli -- --cv ./cv.pdf --job https://example.com/careers/staff-engineer
npm run cli -- interview --cv ./cv.pdf
```

Type each answer, then a line containing only `/done`. When the interview finishes, the CLI
prints the closing summary, the transcript, and the path to the coaching report.

### `interview` flags

| Flag                  | Required | Description                                                                                                                              |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--cv <path>`         | yes      | Candidate CV to interview against (`.pdf`, `.txt`, or `.md`).                                                                            |
| `--job <src>`         | no       | Job posting as a URL, a file path, or pasted text. A failed URL fetch falls back to a paste prompt.                                      |
| `--level <level>`     | no       | Target seniority (e.g. `junior`, `senior`, `staff`). Omit to be asked.                                                                   |
| `--provider <name>`   | no       | Model provider for both tiers (default: `anthropic`).                                                                                    |
| `--fast-model <id>`   | no       | Model id for the fast tier (CV/role parsers, interviewer, research).                                                                     |
| `--smart-model <id>`  | no       | Model id for the smart tier (director, grader, coach).                                                                                   |
| `--candidate <id>`    | no       | Stable candidate id; keys resource-scoped working memory across sessions.                                                                |
| `--max-questions <n>` | no       | Ceiling on questions asked in the session (default: 20). A ceiling, not a target: the director wraps up as soon as it has enough signal. |

## Resuming an interview

Each interview is durable, in the browser and in the terminal.

If you reload the page (or your connection drops) while a question or the final report is still
streaming, the browser rejoins the same run where it left off: the server keeps a replay cache
of every streamed chunk by run id, and the client picks up from the last chunk it received. Your
answered questions are restored from a local session snapshot, and the in-flight text finishes
streaming instead of restarting. An interview that's still open in the sidebar shows as
**● now playing**; clicking it reconnects to that run. If the API server restarted in between,
there's no live stream to rejoin; the interview instead picks up from its last saved turn.

From the terminal:

```bash
npm run cli -- resume              # resumes the most recent interview
npm run cli -- resume --run <id>   # resumes a specific run
```

## Reviewing reports

Coaching reports are written as Markdown under `./data/reports/`. List them newest-first:

```bash
npm run cli -- reports
```

## Coaching knowledge

The coach retrieves from the knowledge index that ships with the app at `data/knowledge.db`:
notes on answer craft, chunked and embedded with OpenAI `text-embedding-3-small`. When the coach
writes advice, it pulls the most relevant guidance for each weak answer and grounds the fix in
it. There is nothing to build before the first run. Queries embed with the same model at
runtime, which is why coached advice needs `OPENAI_API_KEY` (the interview itself runs without
it).

To ground the coach in your own notes instead, point `KNOWLEDGE_CORPUS_DIR` at a directory of
markdown files and run:

```bash
npm run ingest
```

`ingest` embeds your documents with the same OpenAI model (so it needs `OPENAI_API_KEY` too) and
replaces the shipped index with one built from your corpus.

## Studio

Studio serves over the same database the CLI and web UI write to, so you can inspect runs and
their traces:

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

cd web
npm test               # component + logic tests (vitest + Testing Library)
npm run typecheck
npm run lint
```

Workflow snapshots, memory, traces, uploads, and reports persist under `./data/` and stay out
of git; the shipped knowledge index (`data/knowledge.db`) is the one committed file there.

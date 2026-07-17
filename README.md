# The Green Room

The Green Room is a behavioral-interview coach built on [Mastra](https://mastra.ai). Use it in the
browser or terminal with your CV and a target job. It researches the company and adapts each
question to your previous answers. After the interview, it grades your answers and writes a
coaching report grounded in answer-craft guidance.

ElevenLabs can speak browser interview questions and the closing. You can type an answer or dictate
it in multiple segments, editing the transcript between segments before delivery. Voice is
optional. A voice failure leaves the typed interview available.

The browser and CLI drive the same durable Mastra workflow. LibSQL stores workflow snapshots and
candidate memory, along with reports and traces. An interrupted interview can resume without
restarting. Completed sessions remain available in the browser playbill and through the CLI report
commands. Mastra Studio reads the same storage for run and trace inspection.

## Requirements

- Node.js ≥ 22.13
- An Anthropic API key (interview, grading, coaching)
- An OpenAI API key (embeddings for the coach's retrieval; the interview itself runs without it)
- Optional: an ElevenLabs API key for spoken questions, closings, and dictated answers in the browser

## Setup

```bash
npm install
cd web && npm install && cd ..
cp .env.example .env   # then set ANTHROPIC_API_KEY (and OPENAI_API_KEY for coached advice)
```

Set `ANTHROPIC_API_KEY` before starting an interview. Set `OPENAI_API_KEY` when you want the coach
to retrieve answer guidance from the shipped knowledge index.

### ElevenLabs voice setup

ElevenLabs is optional. Configure it to speak browser interview questions and closings. The same
configuration enables Scribe v2 Realtime dictated answers.

1. Create an ElevenLabs API key and accept the Scribe terms in the ElevenLabs dashboard.
2. Set `ELEVENLABS_API_KEY` in the server's `.env` file. Never put it in `web/` or expose it through
   a `VITE_` variable.
3. Restart `npm run dev`. Open http://localhost:4111/voice/capabilities and confirm the response is
   `{"speech":true,"transcription":true}`.
4. Run the browser app on localhost or HTTPS. Browser microphone capture requires a secure context.
5. Click **Start answering** during an interview. The browser asks for microphone permission the
   first time unless the site already has a saved permission decision.

The API key stays on the Mastra server. The server creates a single-use Scribe token that expires
after 15 minutes and is consumed when the browser connects. Question speech uses the built-in
Bella English voice and Eleven Flash v2.5. Set `ELEVENLABS_VOICE_ID` or
`ELEVENLABS_TTS_MODEL` to override those speech defaults.

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
4. Type an answer, or click **Start answering** and grant microphone access. Dictation begins only
   after that click. Live Scribe text is read-only while the microphone is active. Click **Stop
   answering** to review and edit the text. Click **Continue answering** to dictate another segment,
   or click **Deliver** to send the answer. The five-minute limit covers all segments in one answer.
   Typing remains available when dictation is not used or fails.
5. When the interviewer has enough signal, it speaks the complete closing with the same timed text.
   The report waits for playback to finish, then opens with the full transcript and advice for each
   answer. In text mode, the closing keeps its typed reveal.

The sidebar lists your past runs, and opening a finished one shows its report. The Vite server
proxies `/api`, `/prepare-interview`, and `/voice` to `http://localhost:4111`, so the browser stays
same-origin and needs no CORS setup. Point the proxy at another host with `MASTRA_SERVER_URL`.

### Voice and dictation behavior

Voice applies to browser interview questions and the closing. The target-level prompt, progress
cues, report, and CLI stay silent. The browser checks `GET /voice/capabilities` when an interview
starts. Speech and transcription readiness are reported separately, with no key or provider
settings in the response.

The answer card appears after question playback. **Start answering** requests a fresh Scribe token
and microphone access. The transcript stays read-only during active dictation, including connection
and finalization. **Stop answering** finalizes the segment and makes the transcript editable.
**Continue answering** starts another segment without changing the reviewed text. Each segment uses
a fresh token and realtime connection. The elapsed time carries across segments, and the active
segment stops automatically when the answer reaches five recorded minutes.

Microphone audio travels from the browser directly to ElevenLabs. The local server receives the
token request but never receives the audio. The app keeps the token and undelivered transcript in
browser memory. It writes only the reviewed text sent with **Deliver** to workflow storage and the
final report. The app does not store microphone audio. ElevenLabs handles the direct connection
under the retention terms of your account.

Speech errors reveal the full interviewer line and keep the interview moving. Dictation failures
leave typed answers available, whether permission is denied, the token request fails, the browser
lacks a required API, or the realtime session cannot finish. If a later segment fails, the text you
reviewed before starting it remains editable and ready to deliver. **Try again** starts a new attempt
only when you click it.

If voice is unavailable:

- Confirm that http://localhost:4111/voice/capabilities reports the expected capability fields.
- Restart the Mastra server after changing `ELEVENLABS_API_KEY`.
- Check microphone permission in the browser's site settings.
- Use localhost or HTTPS.
- Confirm that the ElevenLabs account has accepted the Scribe terms and has available quota.

### Voice API

The same-origin voice endpoints are:

| Endpoint                          | Method | Response or purpose                                                                 |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `/voice/capabilities`             | GET    | `{ speech: boolean, transcription: boolean }` with no provider secrets              |
| `/voice/speech`                   | POST   | Streams app-owned timed speech chunks for a JSON `{ text }` request                 |
| `/voice/transcription-token`      | POST   | Returns `{ token }` with `Cache-Control: no-store`; returns 502, 503, or 504 on failure |

The token endpoint accepts no candidate audio or transcript. The server is intended for local use;
these routes do not add a separate authentication layer.

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

Browser and terminal interviews are durable.

If you reload the page or lose the connection while a question or report is streaming, the browser
rejoins the same run. The server keeps a replay cache of delivered stream chunks, and a local
session snapshot restores answered questions. The current text continues without restarting. An
interrupted spoken closing is not replayed; the browser shows the complete closing and opens the
finished report. An open interview appears as **● now playing** in the sidebar. Click it to
reconnect. If the API server restarted, the interview resumes from its last saved turn.

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

The coach retrieves answer-craft notes from the knowledge index at `data/knowledge.db`. The notes
are chunked and embedded with OpenAI `text-embedding-3-small`. When the coach
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

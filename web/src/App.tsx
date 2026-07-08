import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InterviewScreen } from './components/InterviewScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { ReportScreen } from './components/ReportScreen';
import { SetupScreen, type SetupPayload } from './components/SetupScreen';
import { Sidebar } from './components/Sidebar';
import { useInterview } from './hooks/useInterview';
import {
  prepareInterview as defaultPrepare,
  type PrepareInterviewRequest,
  type PrepareInterviewResponse,
} from './lib/api';
import { createMastraInterviewClient } from './lib/mastraInterviewClient';
import {
  loadHistory,
  type RunHistoryEntry,
  saveHistory,
  updateEntry,
  upsertEntry,
} from './lib/runHistory';
import type { InterviewClient, InterviewReport, StartInterviewInput } from './lib/types';

const CANDIDATE_KEY = 'green-room:candidate';
const REPORT_PREFIX = 'green-room:report:';

type Route =
  | { name: 'setup' }
  | { name: 'interview'; runId: string }
  | { name: 'report'; runId: string };

export interface AppProps {
  client?: InterviewClient;
  prepare?: (request: PrepareInterviewRequest) => Promise<PrepareInterviewResponse>;
  storage?: Storage;
}

export function App({ client, prepare = defaultPrepare, storage }: AppProps) {
  const store = storage ?? window.localStorage;
  const interviewClient = useMemo(() => client ?? createMastraInterviewClient(), [client]);

  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [history, setHistory] = useState<RunHistoryEntry[]>(() => loadHistory(store));
  const [busy, setBusy] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  // A cached report opened from the playbill, tagged with its run so it can never
  // shadow a different run's report on the report route.
  const [viewedReport, setViewedReport] = useState<{ runId: string; report: InterviewReport } | null>(
    () => {
      if (route.name !== 'report') return null;
      const cached = loadCachedReport(store, route.runId);
      return cached ? { runId: route.runId, report: cached } : null;
    },
  );

  const navigate = useCallback((next: Route) => {
    window.location.hash = toHash(next);
    setRoute(next);
  }, []);

  // Keep the route in step with browser back/forward and manual hash edits.
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const persistHistory = useCallback(
    (entry: RunHistoryEntry) => {
      setHistory((current) => {
        const next = upsertEntry(current, entry);
        saveHistory(store, next);
        return next;
      });
    },
    [store],
  );

  const patchHistory = useCallback(
    (runId: string, patch: Partial<RunHistoryEntry>) => {
      setHistory((current) => {
        const next = updateEntry(current, runId, patch);
        saveHistory(store, next);
        return next;
      });
    },
    [store],
  );

  // When the run finishes, cache the report and mark the run closed. This runs from
  // the stream-consumption path (an event); showing the notes is the effect below,
  // which can wait for the goodbye to finish typing first.
  const handleCompleted = useCallback(
    (report: InterviewReport, runId: string) => {
      cacheReport(store, runId, report);
      // Patch in place so the run's original start time is preserved.
      patchHistory(runId, {
        role: report.role,
        company: report.company,
        level: report.targetLevel,
        status: 'done',
      });
    },
    [store, patchHistory],
  );

  const interview = useInterview(interviewClient, handleCompleted);

  // Show the notes once the run has finished — but if the candidate is watching the
  // interview scene mid-goodbye, hold the curtain until the line finishes typing.
  // The effect only writes the hash (syncing to the browser); the hashchange
  // listener above carries it into the route state. It surfaces each finished run
  // exactly once — the latch keeps it from enforcing the report route forever, which
  // would trap every later navigation (a new audition, another run's report) — and a
  // candidate who navigates away during the held goodbye has made their choice: the
  // run counts as surfaced without ever yanking them back.
  const surfacedRunRef = useRef<string | null>(null);
  const heldRunRef = useRef<string | null>(null);
  const { phase, report: liveReport, runId: liveRunId, closingMessage, closingRevealed } =
    interview.state;
  useEffect(() => {
    if (phase !== 'report' || !liveReport || !liveRunId) return;
    if (surfacedRunRef.current === liveRunId) return;
    if (route.name === 'report' && route.runId === liveRunId) {
      // The candidate got here on their own; that counts as the curtain call.
      surfacedRunRef.current = liveRunId;
      return;
    }
    const watching = route.name === 'interview' && route.runId === liveRunId;
    if (watching && closingMessage && !closingRevealed) {
      heldRunRef.current = liveRunId;
      return;
    }
    if (!watching && heldRunRef.current === liveRunId) {
      surfacedRunRef.current = liveRunId;
      return;
    }
    surfacedRunRef.current = liveRunId;
    window.location.hash = toHash({ name: 'report', runId: liveRunId });
  }, [phase, liveReport, liveRunId, closingMessage, closingRevealed, route]);

  async function begin(payload: SetupPayload) {
    setBusy(true);
    setPrepError(null);
    try {
      const prepared = await prepare({
        cv: payload.cv,
        job: payload.job,
        postingKind: payload.postingKind,
      });
      if (prepared.postingFetchFailedUrl) {
        setPrepError(
          `Couldn't read the posting at ${prepared.postingFetchFailedUrl}. Paste the posting text instead.`,
        );
        return;
      }
      const input: StartInterviewInput = {
        cvPath: prepared.cvPath,
        postingText: prepared.postingText,
        researchUrls: prepared.researchUrls,
        candidate: candidateId(store),
        threadId: crypto.randomUUID(),
        ensemble: payload.ensemble,
      };
      persistHistory({
        runId: input.threadId,
        startedAt: new Date().toISOString(),
        status: 'live',
      });
      setViewedReport(null);
      interview.start(input);
      navigate({ name: 'interview', runId: input.threadId });
    } catch (error) {
      setPrepError(error instanceof Error ? error.message : 'Could not prepare the interview.');
    } finally {
      setBusy(false);
    }
  }

  function openEntry(entry: RunHistoryEntry) {
    if (entry.status === 'done') {
      const cached = loadCachedReport(store, entry.runId);
      if (cached) {
        setViewedReport({ runId: entry.runId, report: cached });
        navigate({ name: 'report', runId: entry.runId });
        return;
      }
    }
    if (entry.runId === interview.state.runId) {
      navigate({ name: interview.state.phase === 'report' ? 'report' : 'interview', runId: entry.runId });
      return;
    }
    // A live run from another session can't be reconnected yet (durable reconnect is a
    // deferred enhancement); say so rather than silently dropping to a blank setup.
    setPrepError(
      entry.status === 'live'
        ? "That interview is still in progress from another session and can't be reopened here yet."
        : 'That interview is no longer available.',
    );
    navigate({ name: 'setup' });
  }

  return (
    <div className="app">
      <Sidebar
        history={history}
        activeRunId={interview.state.runId}
        onNew={() => {
          setViewedReport(null);
          navigate({ name: 'setup' });
        }}
        onOpen={openEntry}
      />
      <main>
        <div className="spotlight" />
        <div className="stage">{renderScreen()}</div>
      </main>
    </div>
  );

  function renderScreen() {
    if (route.name === 'report') {
      const viewed = viewedReport?.runId === route.runId ? viewedReport.report : null;
      const live = interview.state.runId === route.runId ? interview.state.report : null;
      // Back/forward and manual hash edits reach this route without a playbill click,
      // so fall through to the cache before giving up on the report.
      const shown = viewed ?? live ?? loadCachedReport(store, route.runId);
      if (shown) return <ReportScreen report={shown} />;
      return <SetupScreen onBegin={begin} busy={busy} error={prepError} />;
    }

    if (route.name === 'interview' && interview.state.runId === route.runId) {
      if (interview.state.phase === 'starting') return <LoadingScreen cue={interview.state.cue} />;
      if (interview.state.phase === 'error') {
        return <p className="ferr">{interview.state.error}</p>;
      }
      if (interview.state.phase === 'turnFailed') {
        // The run is alive and suspended on a failed turn — offer the retry the
        // workflow is waiting for instead of a dead end.
        return (
          <div>
            <p className="ferr">{interview.state.error}</p>
            <button className="deliver" type="button" onClick={interview.retry}>
              Retry the turn
            </button>
          </div>
        );
      }
      return (
        <InterviewScreen
          state={interview.state}
          onSubmitAnswer={interview.submitAnswer}
          onSubmitLevel={(level) => {
            // Record the chosen level on the live history entry so the playbill shows it.
            if (interview.state.runId) patchHistory(interview.state.runId, { level });
            interview.submitLevel(level);
          }}
          onClosingRevealed={interview.markClosingRevealed}
        />
      );
    }

    return <SetupScreen onBegin={begin} busy={busy} error={prepError} />;
  }
}

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'interview' && parts[1]) return { name: 'interview', runId: parts[1] };
  if (parts[0] === 'report' && parts[1]) return { name: 'report', runId: parts[1] };
  return { name: 'setup' };
}

function toHash(route: Route): string {
  if (route.name === 'setup') return '#/setup';
  return `#/${route.name}/${route.runId}`;
}

function candidateId(store: Storage): string {
  const existing = store.getItem(CANDIDATE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  store.setItem(CANDIDATE_KEY, id);
  return id;
}

function cacheReport(store: Storage, runId: string, report: InterviewReport): void {
  store.setItem(`${REPORT_PREFIX}${runId}`, JSON.stringify(report));
}

function loadCachedReport(store: Storage, runId: string): InterviewReport | null {
  const raw = store.getItem(`${REPORT_PREFIX}${runId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InterviewReport;
  } catch {
    return null;
  }
}

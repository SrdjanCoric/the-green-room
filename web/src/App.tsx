import { useCallback, useEffect, useMemo, useState } from 'react';

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
  const [viewedReport, setViewedReport] = useState<InterviewReport | null>(() =>
    route.name === 'report' ? loadCachedReport(store, route.runId) : null,
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

  // When the run finishes, cache the report, mark the run closed, and show the notes.
  // This runs from the stream-consumption path (an event), not a render effect.
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
      setViewedReport(null);
      navigate({ name: 'report', runId });
    },
    [store, patchHistory, navigate],
  );

  const interview = useInterview(interviewClient, handleCompleted);

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
        resourceId: candidateId(store),
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
        setViewedReport(cached);
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
      const shown = viewedReport ?? (interview.state.runId === route.runId ? interview.state.report : null);
      if (shown) return <ReportScreen report={shown} />;
      return <SetupScreen onBegin={begin} busy={busy} error={prepError} />;
    }

    if (route.name === 'interview' && interview.state.runId === route.runId) {
      if (interview.state.phase === 'starting') return <LoadingScreen cue={interview.state.cue} />;
      if (interview.state.phase === 'error') {
        return <p className="ferr">{interview.state.error}</p>;
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

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
import { QuestionSpeechController } from './lib/questionSpeechController';
import { cacheReport, loadCachedReport } from './lib/reportCache';
import {
  loadHistory,
  type RunHistoryEntry,
  saveHistory,
  updateEntry,
  upsertEntry,
} from './lib/runHistory';
import { createSpeechPlayer } from './lib/speechPlayer';
import { safeSetItem } from './lib/storage';
import type { InterviewClient, InterviewReport, StartInterviewInput } from './lib/types';
import { detectQuestionSpeech } from './lib/voiceApi';

const CANDIDATE_KEY = 'green-room:candidate';

type Route =
  | { name: 'setup' }
  | { name: 'interview'; runId: string }
  | { name: 'report'; runId: string };

export interface AppProps {
  client?: InterviewClient;
  prepare?: (request: PrepareInterviewRequest) => Promise<PrepareInterviewResponse>;
  detectVoice?: () => Promise<boolean>;
  questionSpeech?: QuestionSpeechController;
  storage?: Storage;
}

export function App({
  client,
  prepare = defaultPrepare,
  detectVoice = detectQuestionSpeech,
  questionSpeech,
  storage,
}: AppProps) {
  const store = storage ?? window.localStorage;
  // The production client shares the injected storage, so its run bookkeeping and
  // the hook's session snapshots always live (and are cleared) in the same place.
  const interviewClient = useMemo(
    () => client ?? createMastraInterviewClient(undefined, store),
    [client, store],
  );

  const defaultQuestionSpeechRef = useRef<QuestionSpeechController | null>(null);
  defaultQuestionSpeechRef.current ??= new QuestionSpeechController(createSpeechPlayer());
  const speechController = questionSpeech ?? defaultQuestionSpeechRef.current;
  const [voiceEnabled, setVoiceEnabled] = useState(false);
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

  // The cached report for the current report route, parsed once per route change rather
  // than on every render. Reparsing in the render path minted a fresh object each time,
  // re-firing ReportScreen's scroll-to-top effect (which keys on report identity).
  const cachedRouteReport = useMemo(
    () => (route.name === 'report' ? loadCachedReport(store, route.runId) : null),
    [route, store],
  );

  // The updaters stay pure — no storage write inside them — because StrictMode
  // double-invokes an updater to surface impurity, which would double every write.
  // Persistence is a single effect keyed on the history, below.
  const persistHistory = useCallback((entry: RunHistoryEntry) => {
    setHistory((current) => upsertEntry(current, entry));
  }, []);

  const patchHistory = useCallback((runId: string, patch: Partial<RunHistoryEntry>) => {
    setHistory((current) => updateEntry(current, runId, patch));
  }, []);

  // Persist the history whenever it changes, outside the reducer updater. The first
  // run writes the just-loaded history straight back (a harmless identity write).
  useEffect(() => {
    saveHistory(store, history);
  }, [history, store]);

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

  // A run that settles in a hard error stops claiming to be live in the playbill;
  // reopening it retries the reconnect (the failure may have been the connection).
  const handleFailed = useCallback(
    (runId: string) => patchHistory(runId, { status: 'failed' }),
    [patchHistory],
  );

  // Every rejoin — playbill click, page load, or the hook's own online-event
  // recovery — makes the run live again, so a later reload still finds it rejoinable.
  const handleReconnected = useCallback(
    (runId: string) => patchHistory(runId, { status: 'live' }),
    [patchHistory],
  );

  const interview = useInterview(interviewClient, {
    onCompleted: handleCompleted,
    onFailed: handleFailed,
    onReconnected: handleReconnected,
    storage: store,
  });

  // A reload that lands on an interview route rejoins that run's in-flight stream
  // (the session snapshot restores the transcript; the stream rebuilds the current
  // turn). Only a run the history still holds as live is worth rejoining — anything
  // else falls through to the normal routes. Fires once, on mount.
  const rejoinedRef = useRef(false);
  useEffect(() => {
    if (rejoinedRef.current) return;
    rejoinedRef.current = true;
    if (route.name !== 'interview' || interview.state.runId) return;
    const entry = history.find((e) => e.runId === route.runId);
    if (entry?.status === 'live') {
      void refreshVoiceCapability();
      interview.reconnect(route.runId);
    }
  });

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
      const [prepared, canSpeak] = await Promise.all([
        prepare({
          cv: payload.cv,
          job: payload.job,
          postingKind: payload.postingKind,
        }),
        detectVoice().catch(() => false),
      ]);
      setVoiceEnabled(canSpeak);
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

  function refreshVoiceCapability(): Promise<void> {
    return detectVoice()
      .then(setVoiceEnabled)
      .catch(() => setVoiceEnabled(false));
  }

  function rejoin(runId: string) {
    // Re-detect after a reload/playbill rejoin. The restored current question is
    // marked silent by the machine; capability applies to the following question.
    void refreshVoiceCapability();
    // reconnect() reports back through onReconnected, which marks the run live.
    interview.reconnect(runId);
    navigate({ name: 'interview', runId });
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
      // The active run — but if its stream died, clicking it retries the reconnect
      // instead of re-showing the error screen.
      if (interview.state.phase === 'error' && entry.status !== 'done') {
        rejoin(entry.runId);
        return;
      }
      navigate({ name: interview.state.phase === 'report' ? 'report' : 'interview', runId: entry.runId });
      return;
    }
    // A live run from an earlier page load rejoins its in-flight stream where it
    // left off; a failed one gets the reconnect retried (the failure may have been
    // transient — the run's durable state decides).
    if (entry.status === 'live' || entry.status === 'failed') {
      rejoin(entry.runId);
      return;
    }
    setPrepError('That interview is no longer available.');
    navigate({ name: 'setup' });
  }

  return (
    <div className="app">
      <Sidebar
        history={history}
        activeRunId={interview.state.runId}
        onNew={() => {
          speechController.cancel();
          setVoiceEnabled(false);
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
      // so fall through to the (memoized) cache before giving up on the report.
      const shown = viewed ?? live ?? cachedRouteReport;
      if (shown) return <ReportScreen report={shown} />;
      return <SetupScreen onBegin={(payload) => void begin(payload)} busy={busy} error={prepError} />;
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
            <p className="ferr" role="alert">{interview.state.error}</p>
            <button className="deliver" type="button" onClick={interview.retry}>
              Retry the turn
            </button>
          </div>
        );
      }
      return (
        <InterviewScreen
          state={interview.state}
          voiceEnabled={voiceEnabled}
          questionSpeech={speechController}
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

    return <SetupScreen onBegin={(payload) => void begin(payload)} busy={busy} error={prepError} />;
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
  // A failed write only means the id isn't durable across a reload — not fatal.
  safeSetItem(store, CANDIDATE_KEY, id);
  return id;
}

import type { RunHistoryEntry } from '../lib/runHistory';

export interface SidebarProps {
  history: RunHistoryEntry[];
  activeRunId: string | null;
  onNew: () => void;
  onOpen: (entry: RunHistoryEntry) => void;
}

/** The playbill: a "New audition" button and the "Previously staged" history list. */
export function Sidebar({ history, activeRunId, onNew, onOpen }: SidebarProps) {
  return (
    <aside>
      <div className="marquee">
        <div className="bulbs">
          {Array.from({ length: 5 }, (_, i) => (
            <span className="bulb" key={i} />
          ))}
        </div>
        <div className="est">A rehearsal in one act</div>
        <h1>
          The Green
          <br />
          Room
        </h1>
        <div className="tag">before you go on</div>
      </div>

      <button className="cast-btn" onClick={onNew} type="button">
        <span className="star">✦</span> New audition
      </button>

      <p className="bill-h">Previously staged</p>
      <ul className="bill">
        {history.length === 0 && <li className="empty">Nothing staged yet.</li>}
        {history.map((entry) => (
          <li key={entry.runId}>
            <button
              className={entry.runId === activeRunId ? 'active' : ''}
              onClick={() => onOpen(entry)}
              type="button"
            >
              <div className="role">{entry.role ?? 'Behavioral interview'}</div>
              {entry.company && <div className="co">{entry.company}</div>}
              <div className="run">
                <span className={`status ${entry.status === 'done' ? 'done' : 'live'}`}>
                  {entry.status === 'done' ? '★ closed' : '● now playing'}
                </span>
                {entry.level ? ` · ${entry.level}` : ''} · {formatDate(entry.startedAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

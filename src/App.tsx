import { AlertCircle, ArrowLeft, Bug, Calendar, CheckCircle2, ChevronDown, ChevronRight, Clock3, Coins, Database, ExternalLink, Filter, Pencil, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface SourceFileInfo {
  transcript?: string;
  debugLog?: string;
}

interface NormalizedSession {
  id: string;
  workspaceStorageId: string;
  workspaceName?: string;
  sourcePaths: SourceFileInfo;
  startTime?: string;
  updatedAt: string;
  producer: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  firstUserMessage?: string;
  messageCount: number;
  userTurnCount: number;
  agents: string[];
  tools: string[];
  hasDebugLog: boolean;
  cost: {
    aiCredits?: number;
    aiCreditUnit?: 'AIC';
    aiCreditSource?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    requestCount?: number;
    models: string[];
  };
}

interface ToolCallInfo {
  name: string;
  detail?: string;
  inputChars: number;
  outputChars: number;
}

interface TurnInfo {
  index: number;
  userMessage?: string;
  timestamp: string;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  aiCredits?: number;
  llmRequestCount: number;
  toolCalls: ToolCallInfo[];
  subTurnCount: number;
  hasBrowserContext: boolean;
}

interface SessionsResponse {
  sessions: NormalizedSession[];
  total: number;
  lastRefreshAt?: string;
  error?: string;
}

interface SkillInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

interface AgentInfo {
  name: string;
  description: string;
  sizeBytes: number;
}

interface ToolInfo {
  name: string;
  description: string;
  isMcp: boolean;
  deferred?: boolean;
  mcpServer?: string;
  sizeBytes: number;
}

interface ContextSizes {
  systemPromptTotalBytes: number;
  systemPromptSkillsBytes: number;
  systemPromptAgentsBytes: number;
  toolsBytes: number;
  userPromptBytes: number;
  maxContextTokens?: number;
  model?: string;
}

interface SessionOverview {
  skills: SkillInfo[];
  agents: AgentInfo[];
  tools: ToolInfo[];
  contextSizes?: ContextSizes;
}

type LoadState = 'loading' | 'ready' | 'error';

const SESSION_ROUTE_PREFIX = '/sessions/';

function getRouteSessionId() {
  if (!window.location.pathname.startsWith(SESSION_ROUTE_PREFIX)) return undefined;
  const encodedId = window.location.pathname.slice(SESSION_ROUTE_PREFIX.length);
  if (!encodedId) return undefined;
  return decodeURIComponent(encodedId);
}

function sessionUrl(id: string) {
  return `${SESSION_ROUTE_PREFIX}${encodeURIComponent(id)}`;
}

function formatChars(value: number) {
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 100 ? 2 : value < 10_000 ? 1 : 0
  }).format(value / 1000);
  return `${formatted} kC`;
}

export default function App() {
  const [sessions, setSessions] = useState<NormalizedSession[]>([]);
  const [status, setStatus] = useState<LoadState>('loading');
  const [error, setError] = useState<string>();
  const [lastRefreshAt, setLastRefreshAt] = useState<string>();
  const [query, setQuery] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('all');
  const [detailSessionId, setDetailSessionId] = useState<string | undefined>(() => getRouteSessionId());
  const [turns, setTurns] = useState<TurnInfo[]>();
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [overview, setOverview] = useState<SessionOverview | null>();
  const [dateFrom, setDateFrom] = useState('2026-06-01');
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [notesListOpen, setNotesListOpen] = useState(false);
  const [allNotesOpen, setAllNotesOpen] = useState(false);
  const [scrollToTurn, setScrollToTurn] = useState<number>();

  async function loadSessions(showSpinner = false) {
    try {
      if (showSpinner) {
        setIsRefreshing(true);
      }
      const response = await fetch('/api/sessions');
      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }
      const payload = (await response.json()) as SessionsResponse;
      setSessions(payload.sessions);
      setLastRefreshAt(payload.lastRefreshAt);
      setError(payload.error);
      setStatus(payload.error ? 'error' : 'ready');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRefreshing(false);
    }
  }

  async function loadDetail(id: string) {
    setTurns(undefined);
    setOverview(null);
    setTurnsLoading(true);
    try {
      const [turnsRes, overviewRes] = await Promise.all([
        fetch(`/api/sessions/${encodeURIComponent(id)}/turns`),
        fetch(`/api/sessions/${encodeURIComponent(id)}/overview`)
      ]);
      if (!turnsRes.ok) throw new Error(`API returned ${turnsRes.status}`);
      const payload = (await turnsRes.json()) as { turns: TurnInfo[] };
      setTurns(payload.turns);
      if (overviewRes.ok) {
        const ov = (await overviewRes.json()) as SessionOverview;
        setOverview(ov);
      }
    } catch {
      setTurns([]);
    } finally {
      setTurnsLoading(false);
    }
  }

  function openDetail(id: string, updateUrl = true) {
    setDetailSessionId(id);
    setSelectedId(id);
    void loadDetail(id);
    if (updateUrl) {
      window.history.pushState(null, '', sessionUrl(id));
    }
  }

  function closeDetail() {
    setDetailSessionId(undefined);
    setTurns(undefined);
    setOverview(undefined);
    setScrollToTurn(undefined);
    window.history.pushState(null, '', '/');
  }

  function navigateToTurn(sessionId: string, turnIndex: number) {
    setAllNotesOpen(false);
    setScrollToTurn(turnIndex);
    openDetail(sessionId);
  }

  useEffect(() => {
    if (scrollToTurn === undefined || !turns) return;
    const el = document.getElementById(`turn-${scrollToTurn}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setScrollToTurn(undefined);
    }
  }, [turns, scrollToTurn]);

  useEffect(() => {
    void loadSessions();
    const routeSessionId = getRouteSessionId();
    if (routeSessionId) {
      openDetail(routeSessionId, false);
    }
    const interval = window.setInterval(() => void loadSessions(), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    function handlePopState() {
      const routeSessionId = getRouteSessionId();
      if (routeSessionId) {
        openDetail(routeSessionId, false);
        return;
      }

      setDetailSessionId(undefined);
      setTurns(undefined);
      setOverview(undefined);
      setScrollToTurn(undefined);
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const workspaces = useMemo(() => {
    const names = new Set<string>();
    sessions.forEach((session) => names.add(session.workspaceName ?? session.workspaceStorageId));
    return [...names].sort();
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const fromDate = dateFrom ? new Date(dateFrom + 'T00:00:00') : null;
    const toDate = dateTo ? new Date(dateTo + 'T23:59:59') : null;
    return sessions.filter((session) => {
      const updatedAt = new Date(session.updatedAt);
      if (fromDate && updatedAt < fromDate) return false;
      if (toDate && updatedAt > toDate) return false;
      const matchesQuery = normalizedQuery
        ? [session.id, session.workspaceStorageId, session.workspaceName, session.firstUserMessage, session.producer]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(normalizedQuery))
        : true;
      const sessionWorkspace = session.workspaceName ?? session.workspaceStorageId;
      const matchesWorkspace = workspaceFilter === 'all' || sessionWorkspace === workspaceFilter;
      return matchesQuery && matchesWorkspace;
    });
  }, [workspaceFilter, query, sessions, dateFrom, dateTo]);

  const selectedSession = filteredSessions.find((session) => session.id === selectedId) ?? filteredSessions[0];
  const selectedCost = selectedSession?.cost ?? { models: [] };
  const detailSession = sessions.find((s) => s.id === detailSessionId);
  const filteredAiCredits = filteredSessions.reduce((sum, session) => sum + (session.cost.aiCredits ?? 0), 0);
  const refreshStatusText =
    status === 'loading'
      ? 'Loading'
      : status === 'error'
        ? 'Needs attention'
        : lastRefreshAt
          ? `Upd. ${formatShortDateTime(lastRefreshAt)}`
          : 'Waiting for refresh';

  if (detailSessionId) {
    const detailCost = detailSession?.cost ?? { models: [] };
    return (
      <main className="app-shell">
        <section className="toolbar detail-toolbar" aria-label="Session detail toolbar">
          <button type="button" className="back-button" onClick={closeDetail}>
            <ArrowLeft size={17} aria-hidden="true" />
            Back to sessions
          </button>
          <div className="detail-title-block">
            <h1>{detailSession?.firstUserMessage ?? detailSession?.id ?? detailSessionId}</h1>
            <span>{detailSession ? `${detailSession.producer} · ${formatDateTime(detailSession.updatedAt)}` : 'Loading session metadata'}</span>
          </div>
          <div className="detail-toolbar-right">
            <div className="cost-summary-pill">
              <Coins size={15} aria-hidden="true" />
              {detailCost.aiCredits !== undefined
                ? <strong>{formatAic(detailCost.aiCredits)} AIC <span className="kc-price">({aicToKc(detailCost.aiCredits)} Kč)</span></strong>
                : <span>No AIC data</span>}
            </div>
          </div>
        </section>

        {notesListOpen && turns && (
          <NotesListModal sessionId={detailSessionId} turns={turns} onClose={() => setNotesListOpen(false)} />
        )}

        <section className="turns-area">
          {overview && <SessionOverviewPanel overview={overview} />}
          {turnsLoading ? (
            <StateMessage title="Loading turns" detail="Parsing JSONL log file…" />
          ) : turns && turns.length === 0 ? (
            <StateMessage title="No turns found" detail="This session has no debug log or no user messages were recorded." />
          ) : turns ? (
            <>
              <ToolTokenAnalysis turns={turns} />
              <div className="turns-list">
                {turns.map((turn) => (
                  <TurnCard key={turn.index} turn={turn} sessionId={detailSessionId} />
                ))}
              </div>
            </>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="toolbar" aria-label="Sessions toolbar">
        <div className="title-block">
          <div className="title-row">
            <Database size={22} aria-hidden="true" />
            <h1>VS Code Sessions</h1>
          </div>
          <p>Local Copilot Chat transcripts and debug logs</p>
        </div>

        <div className="toolbar-actions">
          <div className="status-pill" title="Backend refresh status">
            {status === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
            <span>{refreshStatusText}</span>
          </div>
          <button type="button" className="icon-button" onClick={() => setAllNotesOpen(true)} title="Všechny poznámky">
            <Pencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={() => void loadSessions(true)} title="Refresh sessions">
            <RefreshCw size={18} className={isRefreshing ? 'spin' : undefined} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="filters" aria-label="Session filters">
        <label className="search-box">
          <Search size={17} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" />
        </label>

        <label className="select-box">
          <Filter size={17} aria-hidden="true" />
          <select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}>
            <option value="all">All workspaces</option>
            {workspaces.map((ws) => (
              <option key={ws} value={ws}>
                {ws.length > 25 ? ws.slice(0, 25) + '…' : ws}
              </option>
            ))}
          </select>
        </label>

        <label className="date-box">
          <Calendar size={17} aria-hidden="true" />
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} title="From date" />
        </label>

        <label className="date-box">
          <Calendar size={17} aria-hidden="true" />
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} title="To date" />
        </label>

        <div className="meta-strip" aria-label="Filtered sessions summary">
          <span className="meta-count">
            <strong>{filteredSessions.length}</strong>
            <span>sessions</span>
          </span>
          <span className="meta-aic">
            <Coins size={13} aria-hidden="true" />
            <strong>{formatAic(filteredAiCredits)} AIC</strong>
            <span className="meta-kc">({(filteredAiCredits / 4.8).toFixed(0)} Kč)</span>
          </span>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      {allNotesOpen && <AllNotesModal sessions={sessions} onNavigate={navigateToTurn} onClose={() => setAllNotesOpen(false)} />}

      <section className="content-grid">
        <div className="session-table" role="region" aria-label="Session list">
          {status === 'loading' ? <StateMessage title="Loading sessions" detail="Scanning local VS Code storage." /> : null}
          {status !== 'loading' && filteredSessions.length === 0 ? (
            <StateMessage title="No sessions found" detail="Check the storage root or continue a Copilot Chat turn to create local artifacts." />
          ) : null}

          {filteredSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-row ${selectedSession?.id === session.id ? 'selected' : ''} ${(session.cost.aiCredits ?? 0) <= 1 ? 'dim' : ''}`}
              onClick={() => setSelectedId(session.id)}
            >
              <span className="summary-cell">
                <strong>{truncate(session.firstUserMessage ?? 'Untitled session', 60)}</strong>
                <small>{session.workspaceName ?? session.workspaceStorageId}</small>
              </span>
              <span>{formatDateTime(session.updatedAt)}</span>
              <span className="stats-cell">
                <span className="turns-badge">{session.userTurnCount}</span>
                <span className="req-count">{session.cost.requestCount ?? '—'}</span>
              </span>
              <span className="aic-cell">
                {session.cost.aiCredits !== undefined
                  ? <><Coins size={13} aria-hidden="true" />{formatAic(session.cost.aiCredits)}</>
                  : '—'}
              </span>
              <span className="badge-cell">
                {session.hasDebugLog ? (
                  <button
                    type="button"
                    className="debug-badge-btn"
                    onClick={(e) => { e.stopPropagation(); void openDetail(session.id); }}
                    title="Open debug detail"
                  >
                    <Bug size={15} aria-hidden="true" />
                    Debug
                  </button>
                ) : 'Transcript'}
              </span>
            </button>
          ))}
        </div>

        <aside className="detail-panel" aria-label="Selected session metadata">
          {selectedSession ? (
            <>
              <div className="detail-heading">
                <h2>{selectedSession.firstUserMessage ?? selectedSession.id}</h2>
                <span>{selectedSession.producer}</span>
              </div>

              <dl>
                <dt>Updated</dt>
                <dd>{formatDateTime(selectedSession.updatedAt)}</dd>
                <dt>Started</dt>
                <dd>{selectedSession.startTime ? formatDateTime(selectedSession.startTime) : 'Unknown'}</dd>
                <dt>Messages</dt>
                <dd>{selectedSession.messageCount}</dd>
              </dl>

              <section className="cost-panel" aria-label="AI credit usage">
                <div className="cost-heading">
                  <Coins size={17} aria-hidden="true" />
                  <h3>AI Credits</h3>
                </div>
                <div className="cost-total">
                  {selectedCost.aiCredits === undefined ? 'Not reported' : <>{formatAic(selectedCost.aiCredits)} AIC <span className="kc-price">({aicToKc(selectedCost.aiCredits)} Kč)</span></>}
                </div>
                <div className="cost-meta">
                  {(selectedCost.inputTokens || selectedCost.outputTokens || selectedCost.cachedTokens) ? (
                    <table className="token-table">
                      <tbody>
                        {selectedCost.inputTokens ? <tr><td>Input</td><td>{formatNumber(selectedCost.inputTokens)}</td></tr> : null}
                        {selectedCost.outputTokens ? <tr><td>Output</td><td>{formatNumber(selectedCost.outputTokens)}</td></tr> : null}
                        {selectedCost.cachedTokens ? <tr><td>Cached</td><td>{formatNumber(selectedCost.cachedTokens)}</td></tr> : null}
                      </tbody>
                    </table>
                  ) : null}
                  {selectedCost.models.length ? <span className="cost-models">{selectedCost.models.join(', ')}</span> : null}
                </div>
              </section>

              <div className="path-stack">
                {selectedSession.sourcePaths.transcript ? <PathLine label="Transcript" value={selectedSession.sourcePaths.transcript} /> : null}
                {selectedSession.sourcePaths.debugLog ? <PathLine label="Debug log" value={selectedSession.sourcePaths.debugLog} /> : null}
              </div>
            </>
          ) : (
            <StateMessage title="Select a session" detail="Click any session row to view turns and AI credit breakdown." />
          )}
        </aside>
      </section>
    </main>
  );
}

interface TurnNote { title: string; text: string; }

function readTurnNote(key: string): TurnNote {
  const raw = localStorage.getItem(key);
  if (!raw) return { title: '', text: '' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      return parsed as TurnNote;
    }
  } catch { /* ignore */ }
  return { title: '', text: raw };
}

function TurnCard({ turn, sessionId }: { turn: TurnInfo; sessionId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasActivity = turn.toolCalls.length > 0 || turn.subTurnCount > 0;
  const noteKey = `turn-note-${sessionId ?? 'unknown'}-${turn.index}`;
  const [note, setNote] = useState<TurnNote>(() => readTurnNote(noteKey));
  const [noteOpen, setNoteOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftText, setDraftText] = useState('');

  function openNote() {
    setDraftTitle(note.title);
    setDraftText(note.text);
    setNoteOpen(true);
  }

  function saveNote() {
    const updated: TurnNote = { title: draftTitle.trim(), text: draftText.trim() };
    setNote(updated);
    if (updated.title || updated.text) {
      localStorage.setItem(noteKey, JSON.stringify(updated));
    } else {
      localStorage.removeItem(noteKey);
    }
    setNoteOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      setNoteOpen(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      saveNote();
    }
  }

  return (
    <div className="turn-card" id={`turn-${turn.index}`}>
      <div className="turn-header">
        <span className="turn-index">#{turn.index + 1}</span>
        <span className="turn-message">{turn.userMessage ?? '(no message)'}</span>
        <span className="turn-time">{formatDateTime(turn.timestamp)}</span>
      </div>
      <div className="turn-body">
        <div className="turn-aic">
          <Coins size={14} aria-hidden="true" />
          {turn.aiCredits !== undefined ? <strong>{formatAic(turn.aiCredits)} AIC <span className="kc-price">({aicToKc(turn.aiCredits)} Kč)</span></strong> : <span className="no-aic">—</span>}
        </div>
        <div className="turn-chips">
          {turn.inputTokens > 0 ? <span>{formatNumber(turn.inputTokens)} in</span> : null}
          {turn.outputTokens > 0 ? <span>{formatNumber(turn.outputTokens)} out</span> : null}
          {turn.cachedTokens > 0 ? <span>{formatNumber(turn.cachedTokens)} cached</span> : null}
          {turn.llmRequestCount > 0 ? <span>{turn.llmRequestCount} req</span> : null}
          {turn.models.map((m) => <span key={m} className="model-chip">{m}</span>)}
          {turn.hasBrowserContext && <span className="browser-chip" title="Obsahuje Attached Element Context">🌐 browser</span>}
          {hasActivity && (
            <button type="button" className="activity-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '▲' : '▼'} aktivita
            </button>
          )}
        </div>
      </div>
      <button
        type="button"
        className={`turn-note-btn${(note.title || note.text) ? ' turn-note-btn--has-note' : ''}`}
        onClick={openNote}
        title={(note.title || note.text) ? `${note.title ? note.title + ': ' : ''}${note.text}` : 'Přidat poznámku'}
        aria-label="Poznámka"
      >
        <Pencil size={13} aria-hidden="true" />
      </button>

      {noteOpen && (
        <div className="turn-note-overlay" onClick={(e) => { if (e.target === e.currentTarget) setNoteOpen(false); }}>
          <div className="turn-note-popup">
            <p className="turn-note-popup-title">Poznámka k turnu #{turn.index + 1}</p>
            <input
              type="text"
              className="turn-note-title-input"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Nadpis (volitelné)"
            />
            <textarea
              autoFocus
              className="turn-note-textarea"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Napiš poznámku…"
              rows={4}
            />
            <div className="turn-note-actions">
              <button type="button" className="turn-note-save" onClick={saveNote}>Uložit</button>
              <button type="button" className="turn-note-cancel" onClick={() => setNoteOpen(false)}>Zrušit</button>
            </div>
          </div>
        </div>
      )}

      {expanded && hasActivity && (
        <div className="turn-activity">
          {turn.subTurnCount > 0 && (
            <div className="activity-row">
              <span className="activity-label">agent loop</span>
              <span className="activity-value">{turn.subTurnCount}× LLM round</span>
            </div>
          )}
          {turn.toolCalls.map((tc, i) => (
            <div key={i} className="activity-row">
              <span className="activity-label">tool</span>
              <span className="activity-value">
                <span className="activity-tool-name">{tc.name}</span>
                {tc.detail ? <span className="activity-detail">{tc.detail}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolTokenAnalysis({ turns }: { turns: TurnInfo[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { name: string; calls: number; input: number; output: number }>();
    for (const turn of turns) {
      for (const tool of turn.toolCalls) {
        const current = map.get(tool.name) ?? { name: tool.name, calls: 0, input: 0, output: 0 };
        current.calls += 1;
        current.input += tool.inputChars;
        current.output += tool.outputChars;
        map.set(tool.name, current);
      }
    }
    return [...map.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output) || a.name.localeCompare(b.name));
  }, [turns]);

  if (rows.length === 0) {
    return null;
  }

  const totalInput = rows.reduce((sum, row) => sum + row.input, 0);
  const totalOutput = rows.reduce((sum, row) => sum + row.output, 0);

  return (
    <div className="tool-token-analysis">
      <div className="tool-token-header">
        <div>
          <h3>Tool Usage</h3>
          <p>Velikost payloadu volání a výsledků nástrojů v debug logu.</p>
        </div>
        <div className="tool-token-total">
          {formatChars(totalInput + totalOutput)} total
          <span>{formatChars(totalInput)} in / {formatChars(totalOutput)} out</span>
        </div>
      </div>
      <div className="tool-token-table">
        <div className="tool-token-row tool-token-row--head">
          <span>Tool</span>
          <span>Calls</span>
          <span>Input</span>
          <span>Output</span>
          <span>Total</span>
        </div>
        {rows.map((row) => (
          <div key={row.name} className="tool-token-row">
            <span className="tool-token-name">{row.name}</span>
            <span>{formatNumber(row.calls)}</span>
            <span title={`${formatNumber(row.input)} C`}>{formatChars(row.input)}</span>
            <span title={`${formatNumber(row.output)} C`}>{formatChars(row.output)}</span>
            <span title={`${formatNumber(row.input + row.output)} C`}>{formatChars(row.input + row.output)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AllNotesModal({ sessions, onNavigate, onClose }: { sessions: NormalizedSession[]; onNavigate: (sessionId: string, turnIndex: number) => void; onClose: () => void }) {
  const allNotes = useMemo(() => {
    const result: { sessionId: string; workspaceName: string; updatedAt: string; turnIndex: number; note: TurnNote }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('turn-note-')) continue;
      const rest = key.slice('turn-note-'.length);
      const lastDash = rest.lastIndexOf('-');
      if (lastDash === -1) continue;
      const sessionId = rest.slice(0, lastDash);
      const turnIndex = parseInt(rest.slice(lastDash + 1), 10);
      if (isNaN(turnIndex)) continue;
      const note = readTurnNote(key);
      if (!note.title && !note.text) continue;
      const session = sessions.find((s) => s.id === sessionId);
      const workspaceName = session?.workspaceName ?? session?.workspaceStorageId ?? sessionId;
      const updatedAt = session?.updatedAt ?? '';
      result.push({ sessionId, workspaceName, updatedAt, turnIndex, note });
    }
    result.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.turnIndex - b.turnIndex);
    return result;
  }, [sessions]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof allNotes>();
    for (const item of allNotes) {
      const arr = map.get(item.sessionId) ?? [];
      arr.push(item);
      map.set(item.sessionId, arr);
    }
    return [...map.entries()];
  }, [allNotes]);

  return (
    <div className="turn-note-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="notes-list-modal notes-list-modal--wide">
        <div className="notes-list-header">
          <Pencil size={16} aria-hidden="true" />
          <span>Všechny poznámky</span>
          <span className="notes-list-count">{allNotes.length}</span>
          <button type="button" className="notes-list-close" onClick={onClose} aria-label="Zavřít">✕</button>
        </div>
        {grouped.length === 0 ? (
          <p className="notes-list-empty">Zatím žádné poznámky.</p>
        ) : (
          <div className="notes-list-items">
            {grouped.map(([sessionId, items]) => (
              <div key={sessionId} className="notes-group">
                <div className="notes-group-divider" />
                {items.map(({ turnIndex, note, workspaceName, updatedAt }) => (
                  <div key={turnIndex} className="notes-list-item notes-list-item--link" onClick={() => onNavigate(sessionId, turnIndex)}>
                    <div className="notes-list-item-meta">
                      {updatedAt && <span className="notes-group-date">{formatDateTime(updatedAt)}</span>}
                      <span className="notes-group-workspace">{workspaceName}</span>
                    </div>
                    {note.title && <div className="notes-list-title">{note.title}</div>}
                    {note.text && <div className="notes-list-text">{note.text}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NotesListModal({ sessionId, turns, onClose }: { sessionId: string; turns: TurnInfo[]; onClose: () => void }) {
  const notes = turns
    .map((turn) => {
      const key = `turn-note-${sessionId}-${turn.index}`;
      const note = readTurnNote(key);
      return { turn, note, key };
    })
    .filter(({ note }) => note.title || note.text);

  return (
    <div className="turn-note-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="notes-list-modal">
        <div className="notes-list-header">
          <Pencil size={16} aria-hidden="true" />
          <span>Poznámky</span>
          <button type="button" className="notes-list-close" onClick={onClose} aria-label="Zavřít">✕</button>
        </div>
        {notes.length === 0 ? (
          <p className="notes-list-empty">Žádné poznámky k této session.</p>
        ) : (
          <div className="notes-list-items">
            {notes.map(({ turn, note, key }) => (
              <div key={key} className="notes-list-item">
                <div className="notes-list-item-meta">
                  <span className="notes-list-turn">#{turn.index + 1}</span>
                  <span className="notes-list-turn-msg">{turn.userMessage ?? '(no message)'}</span>
                </div>
                {note.title && <div className="notes-list-title">{note.title}</div>}
                {note.text && <div className="notes-list-text">{note.text}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StateMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="state-message">
      <Clock3 size={22} aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

const OVERVIEW_PREVIEW_COUNT = 5;

function SessionOverviewPanel({ overview }: { overview: SessionOverview }) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [expandedToolServers, setExpandedToolServers] = useState<Set<string>>(new Set());
  const visibleSkills = skillsExpanded ? overview.skills : overview.skills.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenSkillsCount = overview.skills.length - OVERVIEW_PREVIEW_COUNT;
  const visibleAgents = agentsExpanded ? overview.agents : overview.agents.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenAgentsCount = overview.agents.length - OVERVIEW_PREVIEW_COUNT;
  const mcpTools = overview.tools.filter((t) => t.isMcp);
  const builtinTools = overview.tools.filter((t) => !t.isMcp);
  const mcpServers = [...new Set(mcpTools.map((t) => t.mcpServer ?? 'unknown'))];
  const getServerBytes = (server: string) =>
    server === '__builtin__'
      ? builtinTools.reduce((s, t) => s + t.sizeBytes, 0)
      : mcpTools.filter((t) => (t.mcpServer ?? 'unknown') === server).reduce((s, t) => s + t.sizeBytes, 0);
  const allServers = [...mcpServers, ...(builtinTools.length > 0 ? ['__builtin__'] : [])].sort(
    (a, b) => getServerBytes(b) - getServerBytes(a) || a.localeCompare(b)
  );
  const visibleServers = toolsExpanded ? allServers : allServers.slice(0, OVERVIEW_PREVIEW_COUNT);
  const hiddenCount = allServers.length - OVERVIEW_PREVIEW_COUNT;
  const toggleToolServer = (server: string) => {
    setExpandedToolServers((current) => {
      const next = new Set(current);
      if (next.has(server)) {
        next.delete(server);
      } else {
        next.add(server);
      }
      return next;
    });
  };

  return (
    <div className="session-overview">
      <div className="overview-grid">
        {overview.skills.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Skills ({overview.skills.length})</h3>
            <div className="overview-tools-group">
              {visibleSkills.map((skill) => (
                <div key={skill.name} className="overview-mcp-server" title={skill.description}>
                  <span className="mcp-server-name">{skill.name}</span>
                  <span className="mcp-tool-count">{formatChars(skill.sizeBytes)}</span>
                </div>
              ))}
              {!skillsExpanded && hiddenSkillsCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setSkillsExpanded(true)}>
                  + {hiddenSkillsCount} more skills
                </button>
              )}
              {skillsExpanded && overview.skills.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setSkillsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}

        {overview.agents.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Agents ({overview.agents.length})</h3>
            <div className="overview-tools-group">
              {visibleAgents.map((agent) => (
                <div key={agent.name} className="overview-mcp-server" title={agent.description}>
                  <span className="mcp-server-name">{agent.name}</span>
                  <span className="mcp-tool-count">{formatChars(agent.sizeBytes)}</span>
                </div>
              ))}
              {!agentsExpanded && hiddenAgentsCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setAgentsExpanded(true)}>
                  + {hiddenAgentsCount} more agents
                </button>
              )}
              {agentsExpanded && overview.agents.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setAgentsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}

        {overview.tools.length > 0 && (
          <div className="overview-section overview-section--groups">
            <h3 className="overview-section-title">Tools ({overview.tools.length})</h3>
            <div className="overview-tools-group">
              {visibleServers.map((server) => {
                if (server === '__builtin__') {
                  const builtinChars = builtinTools.reduce((s, t) => s + t.sizeBytes, 0);
                  const builtinDeferred = builtinTools.filter((t) => t.deferred).length;
                  const expanded = expandedToolServers.has(server);
                  return (
                    <div key="__builtin__" className="overview-mcp-server-wrap">
                      <button
                        className="overview-mcp-server overview-mcp-server--builtin"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => toggleToolServer(server)}
                      >
                        <span className="mcp-server-title">
                          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                          <span className="mcp-server-name">Built-in</span>
                        </span>
                        <span className="mcp-tool-count">
                          {builtinTools.length} tools{builtinDeferred > 0 ? ` · ${builtinDeferred} deferred` : ''} · {formatChars(builtinChars)}
                        </span>
                      </button>
                      {expanded && (
                        <div className="overview-tool-list">
                          {builtinTools.map((tool) => (
                            <div key={tool.name} className={`overview-tool-item${tool.deferred ? ' overview-tool-item--deferred' : ''}`} title={tool.description}>
                              <span className="overview-tool-title">
                                <span className="overview-tool-name">{tool.name}</span>
                                {tool.deferred && (
                                  <span className="overview-tool-deferred" title="Deferred tool">
                                    <Clock3 size={11} aria-hidden="true" /> deferred
                                  </span>
                                )}
                              </span>
                              <span className="overview-tool-meta">
                                <span className="overview-tool-size">{formatChars(tool.sizeBytes)}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                const serverTools = mcpTools.filter((t) => (t.mcpServer ?? 'unknown') === server);
                const count = serverTools.length;
                const deferredCount = serverTools.filter((t) => t.deferred).length;
                const serverChars = serverTools.reduce((s, t) => s + t.sizeBytes, 0);
                const expanded = expandedToolServers.has(server);
                return (
                  <div key={server} className="overview-mcp-server-wrap">
                    <button
                      className="overview-mcp-server"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleToolServer(server)}
                    >
                      <span className="mcp-server-title">
                        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        <span className="mcp-server-name">{server}</span>
                      </span>
                      <span className="mcp-tool-count">
                        {count} {count === 1 ? 'tool' : 'tools'}{deferredCount > 0 ? ` · ${deferredCount} deferred` : ''} · {formatChars(serverChars)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="overview-tool-list">
                        {serverTools.map((tool) => (
                          <div key={tool.name} className={`overview-tool-item${tool.deferred ? ' overview-tool-item--deferred' : ''}`} title={tool.description}>
                            <span className="overview-tool-title">
                              <span className="overview-tool-name">{tool.name}</span>
                              {tool.deferred && (
                                <span className="overview-tool-deferred" title="Deferred tool">
                                  <Clock3 size={11} aria-hidden="true" /> deferred
                                </span>
                              )}
                            </span>
                            <span className="overview-tool-meta">
                              <span className="overview-tool-size">{formatChars(tool.sizeBytes)}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!toolsExpanded && hiddenCount > 0 && (
                <button className="overview-tools-expand" onClick={() => setToolsExpanded(true)}>
                  + {hiddenCount} more servers
                </button>
              )}
              {toolsExpanded && allServers.length > OVERVIEW_PREVIEW_COUNT && (
                <button className="overview-tools-expand" onClick={() => setToolsExpanded(false)}>
                  Show less
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {overview.contextSizes && <ContextWindowBar sizes={overview.contextSizes} />}
    </div>
  );
}

function ContextWindowBar({ sizes }: { sizes: ContextSizes }) {
  const skillsChars = sizes.systemPromptSkillsBytes;
  const agentsChars = sizes.systemPromptAgentsBytes;
  const otherChars = Math.max(0, sizes.systemPromptTotalBytes - skillsChars - agentsChars);
  const toolsChars = sizes.toolsBytes;
  const userChars = sizes.userPromptBytes;
  const totalChars = sizes.systemPromptTotalBytes + toolsChars + userChars;

  const segments = [
    { key: 'other', chars: otherChars, label: 'Instructions', className: 'ctx-seg--other' },
    { key: 'skills', chars: skillsChars, label: 'Skills', className: 'ctx-seg--skills' },
    { key: 'agents', chars: agentsChars, label: 'Agents', className: 'ctx-seg--agents' },
    { key: 'tools', chars: toolsChars, label: 'Tools', className: 'ctx-seg--tools' },
    { key: 'user', chars: userChars, label: 'User prompt', className: 'ctx-seg--user' },
  ].filter((s) => s.chars > 0);

  const pct = (chars: number) => totalChars > 0 ? Math.min(100, (chars / totalChars) * 100).toFixed(3) : '0';

  return (
    <div className="ctx-window">
      <div className="ctx-window-header">
        <span className="ctx-window-label">Context window</span>
        {sizes.model && <span className="ctx-window-model">{sizes.model}</span>}
        <span className="ctx-window-usage">{formatChars(totalChars)} total</span>
      </div>
      <div className="ctx-bar" role="img" aria-label={`Context window: ${formatChars(totalChars)}`}>
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={`ctx-seg ${seg.className}`}
            style={{ width: `${pct(seg.chars)}%` }}
            title={`${seg.label}: ${formatChars(seg.chars)}`}
          />
        ))}
      </div>
      <div className="ctx-legend">
        {segments.map((seg) => (
          <span key={seg.key} className={`ctx-legend-item ctx-legend-item--${seg.key}`}>
            <span className="ctx-legend-dot" />
            {seg.label} <span className="ctx-legend-val">{formatChars(seg.chars)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PathLine({ label, value }: { label: string; value: string }) {
  const vscodePath = value.replace(/\\/g, '/');
  return (
    <a href={`vscode://file/${encodeURI(vscodePath)}`} title={value} className="path-link" aria-label={`Open ${label}`}>
      <ExternalLink size={15} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

function formatShortDateTime(value: string) {
  const d = new Date(value);
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}. ${hours}:${minutes}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
}

function formatAic(value: number) {
  return value.toFixed(2);
}

function aicToKc(value: number) {
  return (value / 4.8).toFixed(1);
}

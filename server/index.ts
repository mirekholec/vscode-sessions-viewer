import cors from 'cors';
import express from 'express';
import { loadConfig } from './config.js';
import { VsCodeTranscriptSource } from './sources/VsCodeTranscriptSource.js';

const config = loadConfig();
const app = express();
const source = new VsCodeTranscriptSource({
  workspaceStorageRoot: config.workspaceStorageRoot,
  directCopilotSessionRoot: config.directCopilotSessionRoot,
  pollIntervalMs: config.pollIntervalMs
});

app.use(cors());
app.use(express.json());

app.get('/api/health', (_request, response) => {
  const snapshot = source.listSessions();
  response.json({ ok: true, ready: snapshot.lastRefreshAt !== undefined, lastRefreshAt: snapshot.lastRefreshAt });
});

app.get('/api/sessions', (request, response) => {
  const snapshot = source.listSessions();
  const q = typeof request.query.q === 'string' ? request.query.q.toLowerCase() : undefined;
  const agent = typeof request.query.agent === 'string' ? request.query.agent.toLowerCase() : undefined;

  const sessions = snapshot.sessions.filter((session) => {
    const matchesQuery = q
      ? [session.id, session.workspaceStorageId, session.firstUserMessage, session.producer]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(q))
      : true;
    const matchesAgent = agent ? session.agents.some((value) => value.toLowerCase() === agent) : true;
    return matchesQuery && matchesAgent;
  });

  response.json({ ...snapshot, sessions, total: sessions.length });
});

app.get('/api/sessions/:id', (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  response.json(session);
});

app.get('/api/sessions/:id/overview', async (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  const overview = await source.getSessionOverview(request.params.id);
  if (!overview) {
    response.status(404).json({ error: 'No overview data available (debug log required)' });
    return;
  }

  response.json(overview);
});

app.get('/api/sessions/:id/turns', async (request, response) => {
  const session = source.getSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  const turns = await source.getSessionTurns(request.params.id);
  response.json({ turns, total: turns.length });
});

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Sessions API listening on http://127.0.0.1:${config.port}`);
});

source.start().catch((error) => {
  console.error('Session source failed to start', error);
});

async function shutdown(): Promise<void> {
  await source.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

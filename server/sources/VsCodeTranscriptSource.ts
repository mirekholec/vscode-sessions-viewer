import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import chokidar, { type FSWatcher } from 'chokidar';
import fg from 'fast-glob';
import type { AgentInfo, ContextSizes, NormalizedSession, SessionOverview, SessionSource, SessionSourceSnapshot, SkillInfo, ToolCallInfo, ToolInfo, TurnInfo } from './SessionSource.js';

interface VsCodeTranscriptSourceOptions {
  workspaceStorageRoot: string;
  directCopilotSessionRoot?: string;
  pollIntervalMs: number;
}

interface SessionAccumulator {
  id: string;
  workspaceStorageId: string;
  workspaceName?: string;
  sourcePaths: {
    transcript?: string;
    debugLog?: string;
  };
  startTime?: string;
  updatedAt?: string;
  producer: string;
  copilotVersion?: string;
  vscodeVersion?: string;
  firstUserMessage?: string;
  messageCount: number;
  userTurnCount: number;
  agents: Set<string>;
  tools: Set<string>;
  hasDebugLog: boolean;
  cost: {
    aiCredits?: number;
    aiCreditSource?: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requestCount: number;
    models: Set<string>;
  };
}

export class VsCodeTranscriptSource implements SessionSource {
  private readonly options: VsCodeTranscriptSourceOptions;
  private watcher?: FSWatcher;
  private watchedDirsKey = '';
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private sessions = new Map<string, NormalizedSession>();
  private lastRefreshAt?: string;
  private error?: string;
  private refreshInFlight?: Promise<void>;

  constructor(options: VsCodeTranscriptSourceOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => this.scheduleRefresh(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    await this.watcher?.close();
  }

  listSessions(): SessionSourceSnapshot {
    return {
      sessions: [...this.sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      lastRefreshAt: this.lastRefreshAt,
      error: this.error
    };
  }

  getSession(id: string): NormalizedSession | undefined {
    return this.sessions.get(id);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, 350);
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });

    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    try {
      const candidates = await this.findCandidateFiles();
      await this.updateWatcher(candidates);
      const accumulators = new Map<string, SessionAccumulator>();

      for (const transcriptPath of candidates.transcripts) {
        const accumulator = await this.getOrCreateAccumulatorAsync(accumulators, transcriptPath, 'transcript');
        accumulator.sourcePaths.transcript = transcriptPath;
        await this.consumeFileStats(accumulator, transcriptPath);
        await this.readJsonl(transcriptPath, (entry) => this.consumeEntry(accumulator, entry));
      }

      for (const debugLogPath of candidates.debugLogs) {
        const accumulator = await this.getOrCreateAccumulatorAsync(accumulators, debugLogPath, 'debugLog');
        accumulator.sourcePaths.debugLog = debugLogPath;
        accumulator.hasDebugLog = true;
        await this.consumeFileStats(accumulator, debugLogPath);
        await this.readJsonl(debugLogPath, (entry) => this.consumeEntry(accumulator, entry));
      }

      this.sessions = new Map(
        [...accumulators.values()].map((session) => {
          const normalized = this.normalizeAccumulator(session);
          return [normalized.id, normalized];
        })
      );
      this.lastRefreshAt = new Date().toISOString();
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.lastRefreshAt = new Date().toISOString();
    }
  }

  private async findCandidateFiles(): Promise<{ transcripts: string[]; debugLogs: string[] }> {
    const roots = this.options.directCopilotSessionRoot
      ? [this.options.directCopilotSessionRoot]
      : [this.options.workspaceStorageRoot];

    const toGlob = (p: string) => p.split(path.sep).join('/');

    const transcriptPatterns = roots.map((root) => toGlob(path.join(root, '**', 'GitHub.copilot-chat', 'transcripts', '*.jsonl')));
    const debugPatterns = roots.flatMap((root) => [
      toGlob(path.join(root, '**', 'GitHub.copilot-chat', 'debug-logs', '*', 'main.jsonl')),
      toGlob(path.join(root, '**', 'GitHub.copilot-chat', 'debug-logs', '*', '*.jsonl'))
    ]);

    const [transcripts, debugLogs] = await Promise.all([
      fg(transcriptPatterns, { onlyFiles: true, unique: true, dot: true, suppressErrors: true }),
      fg(debugPatterns, { onlyFiles: true, unique: true, dot: true, suppressErrors: true })
    ]);

    return { transcripts, debugLogs };
  }

  private async updateWatcher(candidates: { transcripts: string[]; debugLogs: string[] }): Promise<void> {
    const watchedDirs = [...new Set([...candidates.transcripts, ...candidates.debugLogs].map((filePath) => path.dirname(filePath)))].sort();
    const nextKey = watchedDirs.join('\n');

    if (nextKey === this.watchedDirsKey) {
      return;
    }

    this.watchedDirsKey = nextKey;
    await this.watcher?.close();
    this.watcher = undefined;

    if (watchedDirs.length === 0) {
      return;
    }

    this.watcher = chokidar.watch(watchedDirs, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });

    this.watcher.on('add', () => this.scheduleRefresh());
    this.watcher.on('change', () => this.scheduleRefresh());
    this.watcher.on('unlink', () => this.scheduleRefresh());
    this.watcher.on('error', (error) => {
      this.error = error instanceof Error ? error.message : String(error);
      void this.watcher?.close().then(() => {
        this.watcher = undefined;
        this.watchedDirsKey = '';
      });
    });
  }

  private async getOrCreateAccumulatorAsync(
    accumulators: Map<string, SessionAccumulator>,
    filePath: string,
    kind: 'transcript' | 'debugLog'
  ): Promise<SessionAccumulator> {
    const id = this.extractSessionId(filePath, kind);
    const existing = accumulators.get(id);

    if (existing) {
      return existing;
    }

    const workspaceStorageId = this.extractWorkspaceStorageId(filePath);
    const workspaceName = await this.resolveWorkspaceName(workspaceStorageId);
    const accumulator: SessionAccumulator = {
      id,
      workspaceStorageId,
      workspaceName,
      sourcePaths: {},
      producer: kind === 'debugLog' ? 'VS Code Copilot Chat debug log' : 'VS Code Copilot Chat transcript',
      messageCount: 0,
      userTurnCount: 0,
      agents: new Set<string>(),
      tools: new Set<string>(),
      hasDebugLog: kind === 'debugLog',
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        requestCount: 0,
        models: new Set<string>()
      }
    };

    accumulators.set(id, accumulator);
    return accumulator;
  }

  private extractSessionId(filePath: string, kind: 'transcript' | 'debugLog'): string {
    const parts = filePath.split(path.sep);
    const debugIndex = parts.lastIndexOf('debug-logs');
    if (debugIndex >= 0 && parts[debugIndex + 1]) {
      return parts[debugIndex + 1];
    }

    if (kind === 'transcript') {
      return path.basename(filePath, '.jsonl');
    }

    return createHash('sha1').update(filePath).digest('hex').slice(0, 12);
  }

  private extractWorkspaceStorageId(filePath: string): string {
    const relative = path.relative(this.options.workspaceStorageRoot, filePath);
    if (!relative.startsWith('..')) {
      return relative.split(path.sep)[0] ?? 'direct';
    }

    return 'direct';
  }

  private async readJsonl(filePath: string, onEntry: (entry: unknown) => void): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      return;
    }

    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        onEntry(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
  }

  private async consumeFileStats(accumulator: SessionAccumulator, filePath: string): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      const modifiedAt = stats.mtime.toISOString();
      accumulator.startTime = minIso(accumulator.startTime, modifiedAt);
      accumulator.updatedAt = maxIso(accumulator.updatedAt, modifiedAt);
    } catch {
      return;
    }
  }

  private consumeEntry(accumulator: SessionAccumulator, entry: unknown): void {
    if (!entry || typeof entry !== 'object') {
      return;
    }

    const record = entry as Record<string, unknown>;
    const attrs = this.asRecord(record.attrs);
    const fields = { ...attrs, ...record };
    const timestamp = this.findTimestamp(fields);
    if (timestamp) {
      accumulator.startTime = minIso(accumulator.startTime, timestamp);
      accumulator.updatedAt = maxIso(accumulator.updatedAt, timestamp);
    }

    this.copyString(fields, ['producer', 'source', 'type'], (value) => {
      if (value.includes('Copilot') || value.includes('transcript') || value.includes('debug')) {
        accumulator.producer = value;
      }
    });
    this.copyString(fields, ['copilotVersion', 'copilotChatVersion', 'extensionVersion'], (value) => {
      accumulator.copilotVersion ??= value;
    });
    this.copyString(fields, ['vscodeVersion', 'vscode', 'appVersion'], (value) => {
      accumulator.vscodeVersion ??= value;
    });

    const role = this.findString(fields, ['role', 'speaker', 'participant', 'from']) ?? this.inferRole(fields);
    const text = this.findMessageText(fields);
    if (text) {
      accumulator.messageCount += 1;
      if (!accumulator.firstUserMessage && role?.toLowerCase().includes('user')) {
        accumulator.firstUserMessage = text;
      }
      if (role?.toLowerCase().includes('user')) {
        accumulator.userTurnCount += 1;
      }
    }

    const agent = this.findString(fields, ['agent', 'agentName', 'agent_name', 'mode']);
    if (agent) {
      accumulator.agents.add(agent);
    }

    const tool = this.findString(fields, ['tool', 'toolName', 'tool_name', 'functionName', 'name']);
    if (tool && this.looksLikeTool(fields, tool)) {
      accumulator.tools.add(tool);
    }

    this.consumeCost(accumulator, fields);
  }

  private async resolveWorkspaceName(workspaceStorageId: string): Promise<string | undefined> {
    if (workspaceStorageId === 'direct') return undefined;
    try {
      const workspaceJsonPath = path.join(this.options.workspaceStorageRoot, workspaceStorageId, 'workspace.json');
      const raw = await fs.readFile(workspaceJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const uri = (parsed.folder ?? parsed.workspace) as string | undefined;
      if (!uri) return undefined;
      const decoded = decodeURIComponent(uri.replace(/^file:\/\//, ''));
      return path.basename(decoded.replace(/\.code-workspace$/, ''));
    } catch {
      return undefined;
    }
  }

  private normalizeAccumulator(accumulator: SessionAccumulator): NormalizedSession {
    const updatedAt = accumulator.updatedAt ?? new Date(0).toISOString();

    return {
      id: accumulator.id,
      workspaceStorageId: accumulator.workspaceStorageId,
      workspaceName: accumulator.workspaceName,
      sourcePaths: accumulator.sourcePaths,
      startTime: accumulator.startTime,
      updatedAt,
      producer: accumulator.producer,
      copilotVersion: accumulator.copilotVersion,
      vscodeVersion: accumulator.vscodeVersion,
      firstUserMessage: accumulator.firstUserMessage,
      messageCount: accumulator.messageCount,
      userTurnCount: accumulator.userTurnCount,
      agents: [...accumulator.agents].sort(),
      tools: [...accumulator.tools].sort(),
      hasDebugLog: accumulator.hasDebugLog,
      cost: {
        aiCredits: accumulator.cost.aiCredits,
        aiCreditUnit: accumulator.cost.aiCredits === undefined ? undefined : 'AIC',
        aiCreditSource: accumulator.cost.aiCreditSource,
        inputTokens: accumulator.cost.inputTokens || undefined,
        outputTokens: accumulator.cost.outputTokens || undefined,
        cachedTokens: accumulator.cost.cachedTokens || undefined,
        requestCount: accumulator.cost.requestCount || undefined,
        models: [...accumulator.cost.models].sort()
      }
    };
  }

  private consumeCost(accumulator: SessionAccumulator, fields: Record<string, unknown>): void {
    const nanoAiu = this.findNumber(fields, ['copilotUsageNanoAiu', 'copilotUsageNanoAIU', 'copilot_usage_nano_aiu']);
    if (nanoAiu !== undefined) {
      accumulator.cost.aiCredits = (accumulator.cost.aiCredits ?? 0) + nanoAiu / 1_000_000_000;
      accumulator.cost.aiCreditSource ??= 'copilotUsageNanoAiu';
    }

    const inputTokens = this.findNumber(fields, ['usage_input_tokens', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const outputTokens = this.findNumber(fields, ['usage_output_tokens', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    const cachedTokens = this.findNumber(fields, ['cachedTokens', 'cached_tokens', 'usage_cached_tokens']);

    if (inputTokens !== undefined || outputTokens !== undefined || cachedTokens !== undefined) {
      accumulator.cost.requestCount += 1;
      accumulator.cost.inputTokens += inputTokens ?? 0;
      accumulator.cost.outputTokens += outputTokens ?? 0;
      accumulator.cost.cachedTokens += cachedTokens ?? 0;
    }

    const model = this.findString(fields, ['usage_model', 'model', 'modelName', 'model_name']);
    if (model) {
      accumulator.cost.models.add(model);
    }
  }

  private findTimestamp(record: Record<string, unknown>): string | undefined {
    for (const key of ['timestamp', 'time', 'createdAt', 'created_at', 'updatedAt', 'updated_at', 'date', 'ts']) {
      const value = record[key];
      const date = typeof value === 'number' ? new Date(value > 10_000_000_000 ? value : value * 1000) : new Date(String(value ?? ''));
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    return undefined;
  }

  private findMessageText(record: Record<string, unknown>): string | undefined {
    const direct = this.findString(record, ['text', 'message', 'content', 'userMessage', 'user_message', 'prompt']);
    if (direct) {
      return direct.slice(0, 280);
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        const nested = this.findMessageText(value as Record<string, unknown>);
        if (nested) {
          return nested;
        }
      }
    }

    return undefined;
  }

  private findString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return undefined;
  }

  private findNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    return undefined;
  }

  private copyString(record: Record<string, unknown>, keys: string[], onValue: (value: string) => void): void {
    const value = this.findString(record, keys);
    if (value) {
      onValue(value);
    }
  }

  private looksLikeTool(record: Record<string, unknown>, tool: string): boolean {
    const serialized = JSON.stringify(record).toLowerCase();
    return serialized.includes('tool') || serialized.includes('function') || tool.includes('.');
  }

  private inferRole(record: Record<string, unknown>): string | undefined {
    const type = this.findString(record, ['type', 'name'])?.toLowerCase();
    if (type?.includes('user_message')) {
      return 'user';
    }
    if (type?.includes('agent_response') || type?.includes('assistant')) {
      return 'assistant';
    }
    return undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  async getSessionTurns(id: string): Promise<TurnInfo[]> {
    const session = this.sessions.get(id);
    if (!session) {
      return [];
    }

    const debugLogPath = session.sourcePaths.debugLog;
    const transcriptPath = session.sourcePaths.transcript;

    // Prefer main.jsonl in the debug-logs session directory; fallback to stored path
    if (debugLogPath) {
      const dir = path.dirname(debugLogPath);
      const mainPath = path.join(dir, 'main.jsonl');
      try {
        await fs.access(mainPath);
        return this.parseTurns(mainPath);
      } catch {
        return this.parseTurns(debugLogPath);
      }
    }

    if (transcriptPath) {
      return this.parseTurns(transcriptPath);
    }

    return [];
  }

  async getSessionOverview(id: string): Promise<SessionOverview | undefined> {
    const session = this.sessions.get(id);
    if (!session?.sourcePaths.debugLog) {
      return undefined;
    }

    const dir = path.dirname(session.sourcePaths.debugLog);

    // Find system_prompt and tools files (use index 0 as the first turn's context)
    const systemPromptFiles = await fg(path.join(dir, 'system_prompt_*.json').replace(/\\/g, '/'), {
      onlyFiles: true,
      suppressErrors: true
    });
    const toolsFiles = await fg(path.join(dir, 'tools_*.json').replace(/\\/g, '/'), {
      onlyFiles: true,
      suppressErrors: true
    });

    const systemPromptFile = systemPromptFiles.sort()[0];
    const toolsFile = toolsFiles.sort()[0];

    const skills: SkillInfo[] = [];
    const agents: AgentInfo[] = [];
    const tools: ToolInfo[] = [];
    let systemPromptTotalBytes = 0;
    let systemPromptSkillsBytes = 0;
    let systemPromptAgentsBytes = 0;

    if (systemPromptFile) {
      try {
        const raw = await fs.readFile(systemPromptFile, 'utf8');
        const outer = JSON.parse(raw) as { content: string };
        const parts = JSON.parse(outer.content) as Array<{ type: string; content?: string }>;
        const text = parts.find((p) => p.type === 'text')?.content ?? '';
        systemPromptTotalBytes = text.length;

        // Parse <skills>
        const skillsMatch = text.match(/<skills>([\s\S]*?)<\/skills>/);
        if (skillsMatch) {
          systemPromptSkillsBytes = skillsMatch[0].length;
          const skillsText = skillsMatch[1];
          const skillEntries = skillsText.matchAll(/<skill>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/skill>/g);
          for (const m of skillEntries) {
            skills.push({ name: m[1].trim(), description: m[2].trim(), sizeBytes: m[0].length });
          }
        }

        // Parse <agents>
        const agentsMatch = text.match(/<agents>([\s\S]*?)<\/agents>/);
        if (agentsMatch) {
          systemPromptAgentsBytes = agentsMatch[0].length;
          const agentsText = agentsMatch[1];
          const agentEntries = agentsText.matchAll(/<agent>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/agent>/g);
          for (const m of agentEntries) {
            agents.push({ name: m[1].trim(), description: m[2].trim() });
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    if (toolsFile) {
      try {
        const raw = await fs.readFile(toolsFile, 'utf8');
        const outer = JSON.parse(raw) as { content: string };
        const toolsArray = JSON.parse(outer.content) as Array<{ name?: string; type?: string; description?: string }>;
        for (const t of toolsArray) {
          const name = t.name ?? '';
          if (!name) continue;
          const isMcp = name.startsWith('mcp_');
          const mcpServer = isMcp ? name.split('_').slice(1, -1).join('_') : undefined;
          const sizeBytes = JSON.stringify(t).length;
          tools.push({ name, description: (t.description ?? '').slice(0, 120), isMcp, mcpServer, sizeBytes });
        }
      } catch {
        // ignore parse errors
      }
    }

    const toolsBytesTotal = tools.reduce((s, t) => s + t.sizeBytes, 0);
    const userPromptBytes = session.firstUserMessage?.length ?? 0;

    let maxContextTokens: number | undefined;
    let model: string | undefined = session.cost.models[0];

    try {
      const modelsRaw = await fs.readFile(path.join(dir, 'models.json'), 'utf8');
      const modelsData = JSON.parse(modelsRaw) as Array<{ id?: string; capabilities?: { limits?: { max_context_window_tokens?: number } } }>;
      const modelEntry = modelsData.find((m) => m.id === model);
      maxContextTokens = modelEntry?.capabilities?.limits?.max_context_window_tokens;
    } catch {
      // ignore — models.json may not exist
    }

    const contextSizes: ContextSizes = {
      systemPromptTotalBytes,
      systemPromptSkillsBytes,
      systemPromptAgentsBytes,
      toolsBytes: toolsBytesTotal,
      userPromptBytes,
      maxContextTokens,
      model,
    };

    return { skills, agents, tools, contextSizes };
  }

  private async parseTurns(filePath: string): Promise<TurnInfo[]> {
    interface UserMsg {
      spanId: string;
      ts: number;
      content?: string;
    }

    interface LlmReq {
      parentSpanId: string;
      ts: number;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      nanoAiu: number;
    }

    interface ToolCall {
      parentSpanId: string;
      name: string;
      args: Record<string, unknown>;
    }

    const userMessages: UserMsg[] = [];
    const llmRequests: LlmReq[] = [];
    const toolCalls: ToolCall[] = [];
    const subTurnParents = new Map<string, number>();
    const browserParents = new Set<string>();

    await this.readJsonl(filePath, (entry) => {
      if (!entry || typeof entry !== 'object') return;
      const rec = entry as Record<string, unknown>;
      const type = typeof rec.type === 'string' ? rec.type : undefined;
      const attrs = this.asRecord(rec.attrs);
      const spanId = typeof rec.spanId === 'string' ? rec.spanId : undefined;
      const parentSpanId = typeof rec.parentSpanId === 'string' ? rec.parentSpanId : undefined;
      const tsRaw = rec.ts;
      const ts = typeof tsRaw === 'number' ? (tsRaw > 10_000_000_000 ? tsRaw : tsRaw * 1000) : Date.now();

      if (type === 'user_message' && spanId) {
        const content = typeof attrs.content === 'string' ? attrs.content : undefined;
        userMessages.push({ spanId, ts, content });
      }

      if (type === 'llm_request' && parentSpanId) {
        const fields = { ...attrs };
        const model = typeof fields.model === 'string' ? fields.model : undefined;
        const inputTokens = typeof fields.inputTokens === 'number' ? fields.inputTokens : 0;
        const outputTokens = typeof fields.outputTokens === 'number' ? fields.outputTokens : 0;
        const cachedTokens = typeof fields.cachedTokens === 'number' ? fields.cachedTokens : 0;
        const nanoAiu = typeof fields.copilotUsageNanoAiu === 'number' ? fields.copilotUsageNanoAiu : 0;
        llmRequests.push({ parentSpanId, ts, model, inputTokens, outputTokens, cachedTokens, nanoAiu });
        const userRequest = typeof fields.userRequest === 'string' ? fields.userRequest : JSON.stringify(fields.userRequest ?? '');
        if (userRequest.includes('Integrated Browser')) {
          browserParents.add(parentSpanId);
        }
      }

      if (type === 'tool_call' && parentSpanId) {
        const name = typeof rec.name === 'string' ? rec.name : undefined;
        if (name) {
          let args: Record<string, unknown> = {};
          try {
            const argsRaw = typeof attrs.args === 'string' ? attrs.args : JSON.stringify(attrs.args ?? '{}');
            args = JSON.parse(argsRaw) as Record<string, unknown>;
          } catch { /* ignore */ }
          toolCalls.push({ parentSpanId, name, args });
        }
      }

      // turn_start spanId format: "turn_start-{userMsgSpanId}-{index}"
      if (type === 'turn_start' && spanId) {
        const match = /^turn_start-(.+)-\d+$/.exec(spanId);
        if (match) {
          const userMsgSpanId = match[1];
          subTurnParents.set(userMsgSpanId, (subTurnParents.get(userMsgSpanId) ?? 0) + 1);
        }
      }
    });

    // Group llm_requests by parentSpanId
    const llmByParent = new Map<string, LlmReq[]>();
    for (const req of llmRequests) {
      const list = llmByParent.get(req.parentSpanId) ?? [];
      list.push(req);
      llmByParent.set(req.parentSpanId, list);
    }

    // Group tool_calls by parentSpanId
    const toolsByParent = new Map<string, ToolCallInfo[]>();
    for (const tc of toolCalls) {
      const list = toolsByParent.get(tc.parentSpanId) ?? [];
      list.push({ name: tc.name, detail: extractToolDetail(tc.name, tc.args) });
      toolsByParent.set(tc.parentSpanId, list);
    }

    const turns: TurnInfo[] = userMessages.map((msg, index) => {
      const reqs = llmByParent.get(msg.spanId) ?? [];
      const models = [...new Set(reqs.map((r) => r.model).filter((m): m is string => !!m))].sort();
      const inputTokens = reqs.reduce((sum, r) => sum + r.inputTokens, 0);
      const outputTokens = reqs.reduce((sum, r) => sum + r.outputTokens, 0);
      const cachedTokens = reqs.reduce((sum, r) => sum + r.cachedTokens, 0);
      const totalNanoAiu = reqs.reduce((sum, r) => sum + r.nanoAiu, 0);
      const aiCredits = totalNanoAiu > 0 ? totalNanoAiu / 1_000_000_000 : undefined;
      const tools = toolsByParent.get(msg.spanId) ?? [];
      const subTurnCount = subTurnParents.get(msg.spanId) ?? 0;

      const hasBrowserContext = browserParents.has(msg.spanId);

      return {
        index,
        userMessage: msg.content,
        timestamp: new Date(msg.ts).toISOString(),
        models,
        inputTokens,
        outputTokens,
        cachedTokens,
        aiCredits,
        llmRequestCount: reqs.length,
        toolCalls: tools,
        subTurnCount,
        hasBrowserContext
      };
    });

    return turns;
  }
}

function extractToolDetail(name: string, args: Record<string, unknown>): string | undefined {
  const str = (key: string): string | undefined => {
    const v = args[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const shortPath = (p: string | undefined): string | undefined =>
    p ? path.basename(p) : undefined;

  switch (name) {
    case 'read_file': {
      const file = shortPath(str('filePath'));
      const start = args['startLine'];
      const end = args['endLine'];
      return file ? `${file}:${start}-${end}` : undefined;
    }
    case 'grep_search':
    case 'semantic_search':
      return str('query');
    case 'file_search':
      return str('query') ?? str('pattern');
    case 'list_dir':
      return shortPath(str('path'));
    case 'run_in_terminal': {
      const goal = str('goal');
      if (goal) return goal;
      const cmd = str('command');
      return cmd ? cmd.slice(0, 80) : undefined;
    }
    case 'replace_string_in_file':
    case 'create_file':
      return shortPath(str('filePath'));
    case 'multi_replace_string_in_file':
      return str('explanation');
    case 'fetch_webpage': {
      const urls = args['urls'];
      if (Array.isArray(urls) && urls.length > 0) return String(urls[0]).slice(0, 80);
      return undefined;
    }
    case 'manage_todo_list':
      return str('operation') ?? (args['todoList'] ? 'write' : undefined);
    default:
      return undefined;
  }
}

function minIso(current: string | undefined, candidate: string): string {  return !current || candidate < current ? candidate : current;
}

function maxIso(current: string | undefined, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

import spawn from 'cross-spawn';
import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentDiagnostics, AgentEvent, Phase } from '../shared/types';
import { stopOwnedProcess } from './services';
import { supportedAgentRequests, validateAgentResponse } from '../shared/agent-responses';

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexOptions {
  executable?: string;
  /** For executable wrappers; normally omitted. */
  executableArgs?: string[];
  cwd?: string;
  mcp?: { url: string; token: string };
  onEvent?: (event: AgentEvent) => void;
  requestTimeoutMs?: number;
}

export interface ThreadOptions {
  cwd: string;
  phase: Phase;
  model?: string;
  instructions?: string;
  threadId?: string;
}

/** Local JSONL app-server client. Authentication remains with the Codex CLI. */
export class CodexAdapter extends EventEmitter {
  private child?: ChildProcess;
  private ready?: Promise<void>;
  private sequence = 0;
  private stdoutBuffer = '';
  private readonly pending = new Map<
    string | number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly serverRequests = new Map<
    string | number,
    { method: string; params: Record<string, unknown> }
  >();
  private threadId?: string;
  private turnId?: string;
  private turnStarting = false;
  private phase: Phase = 'design';
  private stopped = false;
  private stderrTail = '';
  private version?: string;

  constructor(private readonly options: CodexOptions = {}) {
    super();
  }

  get currentThreadId(): string | undefined {
    return this.threadId;
  }
  get currentTurnId(): string | undefined {
    return this.turnId;
  }
  get active(): boolean {
    return !!this.turnId || this.turnStarting;
  }

  private notify(event: AgentEvent): void {
    this.options.onEvent?.(event);
    this.emit('event', event);
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.stopped = false;
    this.ready = this.launch().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async launch(): Promise<void> {
    const args = [...(this.options.executableArgs ?? []), 'app-server', '--listen', 'stdio://'];
    const env = { ...process.env };
    if (this.options.mcp) {
      args.push(
        '-c',
        `mcp_servers.overhull.url=${JSON.stringify(this.options.mcp.url)}`,
        '-c',
        'mcp_servers.overhull.bearer_token_env_var="OVERHULL_MCP_TOKEN"',
        '-c',
        'mcp_servers.overhull.required=true',
        '-c',
        'mcp_servers.overhull.default_tools_approval_mode="approve"',
      );
      env.OVERHULL_MCP_TOKEN = this.options.mcp.token;
    }
    this.stdoutBuffer = '';
    this.stderrTail = '';
    const child = spawn(this.options.executable || 'codex', args, {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8000);
    });
    child.stdin?.on('error', () => {
      /* The exit/error event rejects pending requests. */
    });
    child.once('error', (error) =>
      this.failed(
        new Error(
          `Cannot start Codex: ${error.message}. Install Codex CLI or set its executable path in Settings.`,
        ),
      ),
    );
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = undefined;
      this.failed(
        new Error(
          this.stopped
            ? 'Codex stopped.'
            : `Codex exited (${signal ?? code ?? 'unknown'}).${this.stderrTail ? ` ${this.stderrTail.slice(-1200)}` : ''}`,
        ),
      );
    });
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'sde_overhull', title: 'SDE Overhull', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      this.version = typeof initialized.userAgent === 'string' ? initialized.userAgent : undefined;
      this.write({ method: 'initialized', params: {} });
      this.notify({ type: 'status', text: 'Codex connected.' });
    } catch (error) {
      await stopOwnedProcess(child);
      if (this.child === child) this.child = undefined;
      throw error;
    }
  }

  private failed(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.turnId = undefined;
    this.turnStarting = false;
    if (!this.stopped) this.notify({ type: 'error', text: error.message });
  }

  private write(message: RpcMessage): void {
    if (!this.child?.stdin?.writable) throw new Error('Codex is not connected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Check CLI authentication and connectivity.`));
      }, this.options.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > 16 * 1024 * 1024) {
      this.failed(new Error('Codex sent an oversized protocol message.'));
      void this.dispose();
      return;
    }
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('Invalid message');
      } catch {
        this.notify({ type: 'activity', text: 'Ignored a non-protocol line from the Codex process.' });
        continue;
      }
      this.handle(message);
    }
  }

  private handle(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params ?? {};
    if (message.id !== undefined) {
      const method = message.method;
      const known = supportedAgentRequests.has(method);
      if (!known) {
        this.write({
          id: message.id,
          error: { code: -32601, message: `This client does not support ${method}.` },
        });
        return;
      }
      this.serverRequests.set(message.id, { method, params });
      this.notify({
        type: method.includes('requestApproval') ? 'approval' : 'question',
        id: message.id,
        method,
        data: params,
      });
      return;
    }
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    switch (message.method) {
      case 'item/agentMessage/delta':
        this.notify({
          type: 'message-delta',
          text: String(params.delta ?? ''),
          id: params.itemId,
          data: { threadId: params.threadId, turnId: params.turnId },
        });
        break;
      case 'item/completed':
        if (params.item?.type === 'agentMessage')
          this.notify({
            type: 'message-complete',
            text: String(params.item.text ?? ''),
            id: params.item.id,
            data: { threadId: params.threadId, turnId: params.turnId },
          });
        else this.notify({ type: 'activity', method: message.method, data: params.item ?? params });
        break;
      case 'turn/started':
        this.turnId = params.turn?.id ?? this.turnId;
        this.notify({ type: 'status', text: 'Agent working.', data: params });
        break;
      case 'turn/completed':
        this.turnId = undefined;
        this.turnStarting = false;
        this.serverRequests.clear();
        this.notify({
          type: 'turn-complete',
          data: {
            ...params,
            status: params.turn?.status ?? params.status,
            error: params.turn?.error ?? params.error,
          },
        });
        break;
      case 'serverRequest/resolved':
        if (params.requestId !== undefined) this.serverRequests.delete(params.requestId);
        this.notify({ type: 'status', method: message.method, data: params });
        break;
      case 'error':
        this.notify({
          type: 'error',
          text: params.error?.message ?? params.message ?? 'Codex reported an error.',
          data: params,
        });
        break;
      default:
        if (
          message.method.startsWith('item/') ||
          message.method === 'turn/plan/updated' ||
          message.method === 'turn/diff/updated'
        ) {
          this.notify({
            type: 'activity',
            method: message.method,
            text: typeof params.delta === 'string' ? params.delta.slice(-16000) : undefined,
            data: params,
          });
        }
    }
  }

  async diagnostics(): Promise<AgentDiagnostics> {
    try {
      await this.start();
      const [accountResult, modelsResult] = await Promise.allSettled([
        this.request('account/read', { refreshToken: false }),
        this.request('model/list', { limit: 100, includeHidden: false }),
      ]);
      const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
      const catalog = modelsResult.status === 'fulfilled' ? modelsResult.value : null;
      return {
        available: true,
        version: this.version,
        authenticated: account ? !!account.account || account.requiresOpenaiAuth === false : undefined,
        account: account?.account?.email ?? account?.account?.type,
        models: (catalog?.data ?? []).map((model: any) => ({
          id: String(model.model ?? model.id),
          name: String(model.displayName ?? model.model ?? model.id),
        })),
        error:
          accountResult.status === 'rejected'
            ? accountResult.reason.message
            : modelsResult.status === 'rejected'
              ? modelsResult.reason.message
              : !account?.account && account?.requiresOpenaiAuth !== false
                ? 'Run codex login in your terminal, then reconnect.'
                : undefined,
      };
    } catch (error) {
      return { available: false, models: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async startThread(options: ThreadOptions): Promise<string> {
    if (this.active)
      throw new Error('Wait for the current agent turn to finish before changing its context.');
    await this.start();
    const previousThread = this.threadId;
    const params = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      sandbox: options.phase === 'implement' ? 'workspace-write' : 'read-only',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      developerInstructions:
        options.instructions ??
        `You are the software development agent in SDE Overhull. Current phase: ${options.phase}. Use Overhull tools for design and evaluation changes. Do not commit, push, merge, or change branches; the application handles Git actions.`,
      ...(options.threadId ? { threadId: options.threadId, excludeTurns: true } : {}),
    };
    const result = await this.request(options.threadId ? 'thread/resume' : 'thread/start', params);
    const threadId = result.thread?.id;
    if (typeof threadId !== 'string') throw new Error('Codex did not return a conversation ID.');
    this.threadId = threadId;
    this.phase = options.phase;
    this.turnId = undefined;
    this.serverRequests.clear();
    if (previousThread && previousThread !== threadId) {
      // Unsubscribe best-effort: old servers need not implement this method.
      void this.request('thread/unsubscribe', { threadId: previousThread }).catch(() => {});
    }
    return threadId;
  }

  async send(text: string): Promise<void> {
    if (!text.trim()) throw new Error('Enter a message for the agent.');
    if (!this.threadId) throw new Error('Open an agent conversation first.');
    if (this.active)
      throw new Error('The agent is already working. Cancel or wait before sending another turn.');
    this.turnStarting = true;
    try {
      const result = await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        approvalPolicy: 'on-request',
      });
      // turn/started is normally delivered first. Do not resurrect a turn that
      // completed before its acceptance response reached us.
      if (this.turnStarting) this.turnId = result.turn?.id ?? this.turnId;
      this.turnStarting = false;
    } catch (error) {
      this.turnStarting = false;
      this.turnId = undefined;
      throw error;
    }
  }

  respond(id: string | number, response: unknown): void {
    const request = this.serverRequests.get(id);
    if (!request) throw new Error('This agent request is no longer pending.');
    const validated = validateAgentResponse({ method: request.method, data: request.params }, response);
    this.write({ id, result: validated });
    this.serverRequests.delete(id);
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) {
      if (this.turnStarting) await this.dispose();
      return;
    }
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.threadId = undefined;
    this.turnId = undefined;
    this.turnStarting = false;
    this.failed(new Error('Codex disconnected.'));
    if (child) await stopOwnedProcess(child);
  }
}

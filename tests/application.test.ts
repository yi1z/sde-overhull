import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/main/application';
import { GitService } from '../src/main/git';
import { ProjectStore, designDigest } from '../src/main/project';
import { DesignRevisionSchema, type AgentEvent, type VerificationCheck } from '../src/shared/types';
import type { VerificationOptions, VerificationReport } from '../src/main/verification';
import { saveRunLog } from '../src/main/run-logs';

// Only the external agent transport and host check runner are simulated. Repository,
// approvals, application gates, persisted run evidence, and local preferences are real.
const doubles = vi.hoisted(() => ({
  send: vi.fn(async (_text: string) => undefined),
  interrupt: vi.fn(async () => undefined),
  verify: vi.fn<(checks: VerificationCheck[], options: VerificationOptions) => Promise<VerificationReport>>(),
  emit: undefined as ((event: AgentEvent) => void) | undefined,
  tool: undefined as ((name: string, args: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('../src/main/codex', () => ({
  CodexAdapter: class {
    constructor(options: { onEvent: (event: AgentEvent) => void }) { doubles.emit = options.onEvent; }
    async start() {}
    async startThread() { return 'local-test-thread'; }
    send = doubles.send;
    interrupt = doubles.interrupt;
    async respond() {}
    async dispose() {}
    async diagnostics() { return { available: true, authenticated: true, models: [] }; }
  },
}));
vi.mock('../src/main/mcp', () => ({
  McpGateway: class {
    constructor(_tools: unknown, handler: (name: string, args: unknown) => Promise<unknown>) { doubles.tool = handler; }
    async start() { return { url: 'http://127.0.0.1:12345/mcp', token: 'local-test-token' }; }
    async close() {}
  },
}));
vi.mock('../src/main/verification', () => ({ runVerification: (...args: Parameters<typeof doubles.verify>) => doubles.verify(...args) }));

let directory: string;
let root: string;
let store: ProjectStore;
let app: Application;

async function passingReport(checks: VerificationCheck[], options: VerificationOptions): Promise<VerificationReport> {
  const codeDigest = await options.codeDigest(); const now = new Date().toISOString();
  return { unchanged: true, codeDigest, checks: checks.map((check) => ({ checkId: check.id, title: check.title, status: 'passed', exitCode: 0, startedAt: now, finishedAt: now, output: 'Passed', codeDigest })) };
}

beforeEach(async () => {
  doubles.send.mockClear(); doubles.interrupt.mockClear(); doubles.verify.mockReset(); doubles.verify.mockImplementation(passingReport);
  doubles.emit = undefined; doubles.tool = undefined;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-application-test-')); root = path.join(directory, 'project');
  const git = await GitService.initialize(root); await git.run(['config', 'user.name', 'Test Developer']); await git.run(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'index.js'), 'export const value = 1;\n'); await git.commit('Initial source', ['index.js']);
  store = new ProjectStore(root); const view = await store.initialize('Test app');
  const design = DesignRevisionSchema.parse({ ...view.design,
    requirements: [{ id: 'req', title: 'Return a value' }], tasks: [{ id: 'task', title: 'Implement the value', requirementIds: ['req'] }],
    checks: ['test', 'smoke'].map((kind) => ({ id: kind, title: kind, kind, command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, taskIds: ['task'] })),
  });
  const saved = await store.saveDraft(design, view.design.revision); await store.review('Reviewed test scope', designDigest(saved.design)); await store.approve();
  app = new Application(path.join(directory, 'preferences'), { chooseDirectory: async () => undefined, chooseFile: async () => undefined, openExternal: async () => undefined, event: () => undefined });
  await app.request('project.open', { path: root }); await app.request('project.trust');
});
afterEach(async () => {
  await app?.dispose();
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('overhull-application-test-')) await fs.rm(directory, { recursive: true, force: true });
});

async function reportReady(taskEvidence: Record<string, string> = { task: 'index.js implements the required value' }): Promise<void> {
  await doubles.tool!('request_verification', { taskEvidence, blockers: [], summary: 'Implementation ready for host checks.' });
  doubles.emit!({ type: 'turn-complete', data: { status: 'completed' } });
}

describe('application implementation boundaries', () => {
  it('does not implement an older approval while a new draft is selected', async () => {
    await app.request('design.new', { feedbackIds: [] });
    await expect(app.request('run.start')).rejects.toThrow('approval');
    expect(doubles.send).not.toHaveBeenCalled();
  });

  it('serializes simultaneous start requests into a single implementation run', async () => {
    const results = await Promise.allSettled([app.request('run.start'), app.request('run.start')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(doubles.send).toHaveBeenCalledTimes(1);
    expect((await app.request('project.refresh')).runs).toHaveLength(1);
  });

  it('cancelling from the agent panel cancels the run and releases its design lock', async () => {
    await app.request('run.start'); await app.request('agent.cancel');
    const view = await app.request('project.refresh'); expect(view.runs[0].status).toBe('cancelled');
    await expect(app.request('design.new', { feedbackIds: [] })).resolves.toBeTruthy();
  });

  it('blocks completion without coverage or host checks even if the agent claims success', async () => {
    await app.request('run.start');
    await expect(doubles.tool!('complete_implementation', { outputCodeDigest: await store.codeDigest(), summary: 'Done' })).rejects.toThrow('verification');
    await reportReady({});
    await vi.waitFor(async () => { expect((await app.request('project.refresh')).runs[0].status).toBe('blocked'); }, { timeout: 10000 });
    expect(doubles.verify).not.toHaveBeenCalled();
  });

  it('prevents another mutable agent turn while host verification is running', async () => {
    let release!: () => void;
    doubles.verify.mockImplementation(async (checks, options) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return passingReport(checks, options);
    });
    await app.request('run.start'); await reportReady();
    await vi.waitFor(() => expect(doubles.verify).toHaveBeenCalledTimes(1), { timeout: 10000 });
    try { await expect(app.request('agent.send', { text: 'Change the implementation', phase: 'implement' })).rejects.toThrow(/verif/i); }
    finally { release(); }
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledTimes(2), { timeout: 10000 });
  });

  it('requires unchanged code when accepting the agent’s final verification confirmation', async () => {
    await app.request('run.start'); await reportReady();
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledTimes(2), { timeout: 10000 });
    const view = await app.request('project.refresh'); const digest = view.runs[0].outputCodeDigest;
    await fs.writeFile(path.join(root, 'index.js'), 'export const value = 2;\n');
    await expect(doubles.tool!('complete_implementation', { outputCodeDigest: digest, summary: 'Done' })).rejects.toThrow('stale');
    expect((await app.request('project.refresh')).runs[0].status).not.toBe('complete');
  });

  it('ignores late responses from a disconnected agent after switching projects', async () => {
    await app.request('agent.send', { text: 'Inspect this project', phase: 'evaluate' });
    const oldEmitter = doubles.emit!;
    await app.request('agent.cancel');
    const other = path.join(directory, 'other'); await new GitService(directory).run(['clone', root, other]);
    await app.request('project.open', { path: other });
    oldEmitter({ type: 'message-complete', text: 'A late answer from the first project.' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await app.request('project.refresh')).messages.some((message) => message.text.includes('late answer'))).toBe(false);
  });

  it('does not change the design round while an agent is still responding', async () => {
    await app.request('agent.send', { text: 'Explain this design', phase: 'evaluate' });
    const original = (await app.request('project.refresh')).design;
    await expect(app.request('design.new', { feedbackIds: [] })).rejects.toThrow(/agent|conversation|turn/i);
    expect((await app.request('project.refresh')).design.id).toBe(original.id);
  });

  it('requires project trust before project-bound agent diagnostics can launch the CLI', async () => {
    const untrusted = new Application(path.join(directory, 'untrusted-preferences'), { chooseDirectory: async () => undefined, chooseFile: async () => undefined, openExternal: async () => undefined, event: () => undefined });
    try {
      await untrusted.request('project.open', { path: root });
      doubles.emit = undefined;
      await expect(untrusted.request('agent.diagnostics')).rejects.toThrow(/trust/i);
      expect(doubles.emit).toBeUndefined();
    } finally { await untrusted.dispose(); }
  });

  it('stores full verification output only in local run logs', async () => {
    const now = new Date().toISOString();
    const output = 'Full local diagnostic with private environment context';
    const file = await saveRunLog(path.join(directory, 'preferences'), root, 'run-logs-test', [{ checkId: 'test', title: 'Tests', status: 'failed', exitCode: 1, startedAt: now, finishedAt: now, output }]);
    expect(file.startsWith(path.join(directory, 'preferences'))).toBe(true);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).checks[0].output).toBe(output);
    expect((await store.git.status()).files.some((item) => item.path.includes('run-logs'))).toBe(false);
    await expect(saveRunLog(path.join(directory, 'preferences'), root, '../escape', [])).rejects.toThrow();
  });
});

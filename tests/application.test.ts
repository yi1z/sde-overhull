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
import { Preferences } from '../src/main/preferences';
import { acquireRunLock } from '../src/main/run-lock';

const readinessTimeout = process.env.CI ? 30000 : 10000;

// Only the external agent transport and host check runner are simulated. Repository,
// approvals, application gates, persisted run evidence, and local preferences are real.
const doubles = vi.hoisted(() => ({
  send: vi.fn(async (_text: string) => undefined),
  interrupt: vi.fn<() => Promise<void>>(async () => undefined),
  dispose: vi.fn(async () => undefined),
  startThread: vi.fn(async (_options: { threadId?: string }) => 'local-test-thread'),
  respond: vi.fn(async (_id: string | number, _response: unknown) => undefined),
  changed: vi.fn(),
  verify: vi.fn<(checks: VerificationCheck[], options: VerificationOptions) => Promise<VerificationReport>>(),
  emit: undefined as ((event: AgentEvent) => void) | undefined,
  tool: undefined as ((name: string, args: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('../src/main/codex', () => ({
  CodexAdapter: class {
    constructor(options: { onEvent: (event: AgentEvent) => void }) {
      doubles.emit = options.onEvent;
    }
    async start() {}
    startThread = doubles.startThread;
    send = doubles.send;
    interrupt = doubles.interrupt;
    respond = doubles.respond;
    dispose = doubles.dispose;
    async diagnostics() {
      return { available: true, authenticated: true, models: [] };
    }
  },
}));
vi.mock('../src/main/mcp', () => ({
  McpGateway: class {
    constructor(_tools: unknown, handler: (name: string, args: unknown) => Promise<unknown>) {
      doubles.tool = handler;
    }
    async start() {
      return { url: 'http://127.0.0.1:12345/mcp', token: 'local-test-token' };
    }
    async close() {}
  },
}));
vi.mock('../src/main/verification', () => ({
  runVerification: (...args: Parameters<typeof doubles.verify>) => doubles.verify(...args),
}));

let directory: string;
let root: string;
let store: ProjectStore;
let app: Application;

async function passingReport(
  checks: VerificationCheck[],
  options: VerificationOptions,
): Promise<VerificationReport> {
  const codeDigest = await options.codeDigest();
  const now = new Date().toISOString();
  return {
    unchanged: true,
    codeDigest,
    checks: checks.map((check) => ({
      checkId: check.id,
      title: check.title,
      status: 'passed',
      exitCode: 0,
      startedAt: now,
      finishedAt: now,
      output: 'Passed',
      codeDigest,
    })),
  };
}

beforeEach(async () => {
  doubles.send.mockReset();
  doubles.send.mockResolvedValue(undefined);
  doubles.interrupt.mockReset();
  doubles.interrupt.mockResolvedValue(undefined);
  doubles.dispose.mockReset();
  doubles.dispose.mockResolvedValue(undefined);
  doubles.verify.mockReset();
  doubles.verify.mockImplementation(passingReport);
  doubles.startThread.mockReset();
  doubles.startThread.mockResolvedValue('local-test-thread');
  doubles.respond.mockClear();
  doubles.changed.mockReset();
  doubles.emit = undefined;
  doubles.tool = undefined;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-application-test-'));
  root = path.join(directory, 'project');
  const git = await GitService.initialize(root);
  await git.run(['config', 'user.name', 'Test Developer']);
  await git.run(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'index.js'), 'export const value = 1;\n');
  await git.commit('Initial source', ['index.js']);
  store = new ProjectStore(root);
  const view = await store.initialize('Test app');
  const design = DesignRevisionSchema.parse({
    ...view.design,
    requirements: [{ id: 'req', title: 'Return a value' }],
    tasks: [{ id: 'task', title: 'Implement the value', requirementIds: ['req'] }],
    checks: ['test', 'smoke'].map((kind) => ({
      id: kind,
      title: kind,
      kind,
      command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
      taskIds: ['task'],
    })),
  });
  const saved = await store.saveDraft(design, view.design.revision);
  await store.review('Reviewed test scope', designDigest(saved.design));
  await store.approve();
  app = new Application(path.join(directory, 'preferences'), {
    chooseDirectory: async () => undefined,
    chooseFile: async () => undefined,
    openExternal: async () => undefined,
    event: (event) => {
      if (event.type === 'project-changed') doubles.changed();
    },
  });
  await app.request('project.open', { path: root });
  await app.request('project.trust');
});
afterEach(async () => {
  await app?.dispose();
  if (
    directory &&
    path.dirname(directory) === os.tmpdir() &&
    path.basename(directory).startsWith('overhull-application-test-')
  )
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function reportReady(
  taskEvidence: Record<string, string> = { task: 'index.js implements the required value' },
): Promise<void> {
  await doubles.tool!('request_verification', {
    taskEvidence,
    blockers: [],
    summary: 'Implementation ready for host checks.',
  });
  doubles.emit!({ type: 'turn-complete', data: { status: 'completed' } });
}

describe('application implementation boundaries', () => {
  it.each(['thread', 'send'] as const)(
    'publishes released ownership after a %s startup failure and permits retry',
    async (stage) => {
      const message = `Agent ${stage} startup failed`;
      let changesBeforeFailure = 0;
      const fail = async () => {
        changesBeforeFailure = doubles.changed.mock.calls.length;
        throw new Error(message);
      };
      if (stage === 'thread') doubles.startThread.mockImplementationOnce(fail);
      else doubles.send.mockImplementationOnce(fail);

      await expect(app.request('run.start')).rejects.toThrow(message);
      expect(doubles.changed.mock.calls.length).toBeGreaterThan(changesBeforeFailure);
      const failed = await app.request('project.refresh');
      expect(failed.activeRunId).toBeUndefined();
      expect(failed.runs.at(-1)).toMatchObject({ status: 'blocked', summary: `Error: ${message}` });
      const failedId = failed.runs.at(-1)!.id;

      const retried = await app.request('run.start');
      expect(retried.runs).toHaveLength(2);
      expect(retried.activeRunId).toBe(retried.runs.at(-1)!.id);
      expect(retried.activeRunId).not.toBe(failedId);
      expect(retried.runs.at(-1)?.continuationOfRunId).toBe(failedId);
      expect(retried.runs[0].summary).toBe(`Error: ${message}`);
      const report = JSON.parse(
        await fs.readFile(path.join(root, '.sde', 'runs', `${retried.activeRunId}.json`), 'utf8'),
      );
      expect(report).not.toHaveProperty('activeRunId');
    },
  );

  it('reopens blocked history without claiming a live run and allows a new run', async () => {
    doubles.startThread.mockRejectedValueOnce(new Error('Agent authentication expired'));
    await expect(app.request('run.start')).rejects.toThrow('authentication expired');
    const reopened = (await app.request('project.open', { path: root }))!;
    expect(reopened.activeRunId).toBeUndefined();
    expect(reopened.runs.at(-1)).toMatchObject({
      status: 'blocked',
      summary: 'Error: Agent authentication expired',
    });
    const retried = await app.request('run.start');
    expect(retried.activeRunId).toBe(retried.runs.at(-1)!.id);
  });

  it.each([false, true])(
    'holds the checkout through verification cancellation cleanup (interrupt failure: %s)',
    async (interruptFailure) => {
      let release!: () => void;
      // Create the cleanup handle before any slow Git operation. A timed-out
      // readiness assertion must still release verification if it starts later.
      const verificationRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      let verificationSignal: AbortSignal | undefined;
      doubles.verify.mockImplementation(async (checks, options) => {
        verificationSignal = options.signal;
        await verificationRelease;
        return passingReport(checks, options);
      });
      const other = new Application(path.join(directory, 'cancellation-profile'), {
        chooseDirectory: async () => undefined,
        chooseFile: async () => undefined,
        openExternal: async () => undefined,
        event: () => undefined,
      });
      let cancellation: Promise<unknown> | undefined;
      try {
        await other.request('project.open', { path: root });
        await other.request('project.trust');
        await app.request('run.start');
        await reportReady();
        await vi.waitFor(() => expect(doubles.verify).toHaveBeenCalledTimes(1), {
          timeout: readinessTimeout,
        });
        if (interruptFailure)
          doubles.interrupt.mockRejectedValueOnce(
            new Error('Agent transport disconnected during interruption'),
          );
        let finished = false;
        cancellation = app.request('run.cancel').then(
          (result) => {
            finished = true;
            return result;
          },
          (error) => {
            finished = true;
            return error;
          },
        );
        await vi.waitFor(() => expect(verificationSignal?.aborted).toBe(true), { timeout: readinessTimeout });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(finished).toBe(false);
        await expect(other.request('run.start')).rejects.toThrow('owns this checkout');
        expect(doubles.send).toHaveBeenCalledTimes(1);
        release();
        await cancellation;
        expect((await app.request('project.refresh')).runs[0].status).toBe('cancelled');
        expect(doubles.send).toHaveBeenCalledTimes(1);
        await expect(other.request('run.start')).resolves.toBeTruthy();
      } finally {
        release?.();
        await cancellation;
        await other.dispose();
      }
    },
  );

  it('excludes a second application profile from the checkout and releases ownership after cancellation', async () => {
    const other = new Application(path.join(directory, 'second-profile'), {
      chooseDirectory: async () => undefined,
      chooseFile: async () => undefined,
      openExternal: async () => undefined,
      event: () => undefined,
    });
    try {
      await other.request('project.open', { path: root });
      await other.request('project.trust');
      await app.request('run.start');
      await expect(other.request('run.start')).rejects.toThrow('owns this checkout');
      expect(doubles.send).toHaveBeenCalledTimes(1);
      await app.request('run.cancel');
      await expect(other.request('run.start')).resolves.toBeTruthy();
      expect(doubles.send).toHaveBeenCalledTimes(2);
      await other.dispose();
      // Normal shutdown also releases the checkout for a different profile.
      await expect(app.request('run.start')).resolves.toBeTruthy();
    } finally {
      await other.dispose();
    }
  });

  it('closes an unresponsive final agent turn without changing completed evidence', async () => {
    await app.request('run.start');
    await reportReady();
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledTimes(2), { timeout: readinessTimeout });
    const verified = (await store.load()).runs[0];
    await doubles.tool!('complete_implementation', {
      outputCodeDigest: verified.outputCodeDigest,
      summary: 'Verified implementation is complete.',
    });
    // The final turn has not emitted turn-complete and never acknowledges a stop.
    let acknowledge!: () => void;
    doubles.interrupt.mockImplementationOnce(() => new Promise<void>((resolve) => (acknowledge = resolve)));
    doubles.dispose.mockClear();
    let closed = false;
    const closing = app.dispose().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
      expect(doubles.interrupt).not.toHaveBeenCalled();
      expect(doubles.dispose).toHaveBeenCalledTimes(1);
      expect((await store.load()).runs[0]).toMatchObject({
        id: verified.id,
        status: 'complete',
        outputCodeDigest: verified.outputCodeDigest,
        summary: 'Verified implementation is complete.',
      });
    } finally {
      acknowledge?.();
      await closing;
    }
  });

  it('preserves interrupted edits and holds ownership until shutdown verification cleanup finishes', async () => {
    let release!: () => void;
    const verificationRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verificationSignal: AbortSignal | undefined;
    doubles.verify.mockImplementation(async (checks, options) => {
      verificationSignal = options.signal;
      await verificationRelease;
      return passingReport(checks, options);
    });
    let closing: Promise<void> | undefined;
    try {
      const started = await app.request('run.start');
      const partialSource = 'export const value = 2; // Partial implementation retained on close\n';
      await fs.writeFile(path.join(root, 'index.js'), partialSource);
      await reportReady();
      await vi.waitFor(() => expect(doubles.verify).toHaveBeenCalledTimes(1), {
        timeout: readinessTimeout,
      });
      doubles.dispose.mockClear();
      let closed = false;
      closing = app.dispose().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(doubles.dispose).toHaveBeenCalledTimes(1), {
        timeout: readinessTimeout,
      });
      expect(verificationSignal?.aborted).toBe(true);
      expect(doubles.interrupt).not.toHaveBeenCalled();
      expect(closed).toBe(false);
      await expect(acquireRunLock(root, 'another-run')).rejects.toThrow('owns this checkout');
      release();
      await closing;
      expect(await fs.readFile(path.join(root, 'index.js'), 'utf8')).toBe(partialSource);
      const interrupted = (await store.load()).runs[0];
      expect(interrupted).toMatchObject({
        id: started.activeRunId,
        status: 'interrupted',
        checkpointDigest: await store.codeDigest(),
      });
      expect(interrupted.finishedAt).toBeTruthy();
      expect(interrupted.summary).toContain('Workspace closed. Partial edits retained.');
      expect(doubles.send).toHaveBeenCalledTimes(1);
      const releaseOwnership = await acquireRunLock(root, 'another-run');
      await releaseOwnership();
    } finally {
      release();
      await closing;
    }
  });

  it('replaces an unavailable local session with a fresh one from shared project context', async () => {
    const view = await app.request('project.refresh');
    const preferences = new Preferences(path.join(directory, 'preferences'));
    const key = `${view.design.roundId}:evaluate`;
    await preferences.setSession(view.root, key, 'removed-local-session');
    doubles.startThread
      .mockRejectedValueOnce(new Error('Thread not found: removed-local-session'))
      .mockResolvedValueOnce('fresh-local-session');
    await app.request('agent.send', { text: 'Explain the current approved design.', phase: 'evaluate' });
    expect(doubles.startThread).toHaveBeenCalledTimes(2);
    expect(doubles.startThread.mock.calls[0][0]).toMatchObject({
      threadId: 'removed-local-session',
      phase: 'evaluate',
      cwd: view.root,
    });
    expect(doubles.startThread.mock.calls[1][0]).not.toHaveProperty('threadId');
    expect(await preferences.session(view.root, key)).toBe('fresh-local-session');
    expect(doubles.send).toHaveBeenCalledTimes(1);
    expect((await app.request('project.refresh')).approvals).toHaveLength(1);
  });

  it('does not conceal authentication or provider failures behind fresh-session retries', async () => {
    const view = await app.request('project.refresh');
    const preferences = new Preferences(path.join(directory, 'preferences'));
    await preferences.setSession(view.root, `${view.design.roundId}:evaluate`, 'existing-session');
    doubles.startThread.mockRejectedValueOnce(new Error('Authentication expired'));
    await expect(
      app.request('agent.send', { text: 'Explain the design.', phase: 'evaluate' }),
    ).rejects.toThrow('Authentication expired');
    expect(doubles.startThread).toHaveBeenCalledTimes(1);
    expect(doubles.startThread.mock.calls[0][0]).toMatchObject({
      threadId: 'existing-session',
      cwd: view.root,
    });
    expect(doubles.send).not.toHaveBeenCalled();
  });

  it('shares agent questions and ordinary answers while redacting secret answers', async () => {
    await app.request('agent.send', { text: 'Ask about the implementation.', phase: 'evaluate' });
    doubles.emit!({
      type: 'question',
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      data: {
        questions: [
          { id: 'stack', question: 'Which runtime?', header: 'Runtime', isSecret: false },
          { id: 'key', question: 'Private API key?', header: 'Key', isSecret: true },
        ],
      },
    });
    await vi.waitFor(
      async () =>
        expect(
          (await app.request('project.refresh')).messages.some(
            (message) => message.role === 'assistant' && message.text.includes('Which runtime?'),
          ),
        ).toBe(true),
      { timeout: readinessTimeout },
    );
    const response = {
      answers: { stack: { answers: ['Node.js'] }, key: { answers: ['never-share-this-secret'] } },
    };
    await app.request('agent.respond', { id: 'question-1', response });
    expect(doubles.respond).toHaveBeenCalledWith('question-1', response);
    const messages = (await app.request('project.refresh')).messages;
    expect(messages.some((message) => message.text.includes('Which runtime?: Node.js'))).toBe(true);
    expect(messages.some((message) => message.text.includes('Private API key?: [Private answer sent]'))).toBe(
      true,
    );
    expect(JSON.stringify(messages)).not.toContain('never-share-this-secret');
    await expect(app.request('agent.respond', { id: 'question-1', response })).rejects.toThrow(
      'no longer pending',
    );
  });

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
    await app.request('run.start');
    await app.request('agent.cancel');
    const view = await app.request('project.refresh');
    expect(view.runs[0].status).toBe('cancelled');
    await expect(app.request('design.new', { feedbackIds: [] })).resolves.toBeTruthy();
  });

  it('blocks completion without coverage or host checks even if the agent claims success', async () => {
    const started = await app.request('run.start');
    await expect(
      doubles.tool!('complete_implementation', {
        outputCodeDigest: await store.codeDigest(),
        summary: 'Done',
      }),
    ).rejects.toThrow('verification');
    await reportReady({});
    await vi.waitFor(
      async () => {
        expect((await app.request('project.refresh')).runs[0].status).toBe('blocked');
      },
      { timeout: readinessTimeout },
    );
    expect(doubles.verify).not.toHaveBeenCalled();
    expect((await app.request('project.refresh')).activeRunId).toBe(started.activeRunId);
    await expect(app.request('run.start')).rejects.toThrow('Stop the implementation run');
    const stopped = await app.request('run.cancel');
    expect(stopped.activeRunId).toBeUndefined();
    expect(stopped.runs[0].status).toBe('cancelled');
  });

  it('prevents another mutable agent turn while host verification is running', async () => {
    let release!: () => void;
    const verificationRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    doubles.verify.mockImplementation(async (checks, options) => {
      await verificationRelease;
      return passingReport(checks, options);
    });
    try {
      await app.request('run.start');
      await reportReady();
      await vi.waitFor(() => expect(doubles.verify).toHaveBeenCalledTimes(1), { timeout: readinessTimeout });
      await expect(
        app.request('agent.send', { text: 'Change the implementation', phase: 'implement' }),
      ).rejects.toThrow(/verif/i);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledTimes(2), { timeout: readinessTimeout });
  });

  it('requires unchanged code when accepting the agent’s final verification confirmation', async () => {
    await app.request('run.start');
    await reportReady();
    await vi.waitFor(() => expect(doubles.send).toHaveBeenCalledTimes(2), { timeout: readinessTimeout });
    const view = await app.request('project.refresh');
    const digest = view.runs[0].outputCodeDigest;
    await fs.writeFile(path.join(root, 'index.js'), 'export const value = 2;\n');
    await expect(
      doubles.tool!('complete_implementation', { outputCodeDigest: digest, summary: 'Done' }),
    ).rejects.toThrow('stale');
    expect((await app.request('project.refresh')).runs[0].status).not.toBe('complete');
  });

  it('ignores late responses from a disconnected agent after switching projects', async () => {
    await app.request('agent.send', { text: 'Inspect this project', phase: 'evaluate' });
    const oldEmitter = doubles.emit!;
    await app.request('agent.cancel');
    const other = path.join(directory, 'other');
    await new GitService(directory).run(['clone', root, other]);
    await app.request('project.open', { path: other });
    oldEmitter({ type: 'message-complete', text: 'A late answer from the first project.' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      (await app.request('project.refresh')).messages.some((message) => message.text.includes('late answer')),
    ).toBe(false);
  });

  it('does not change the design round while an agent is still responding', async () => {
    await app.request('agent.send', { text: 'Explain this design', phase: 'evaluate' });
    const original = (await app.request('project.refresh')).design;
    await expect(app.request('design.new', { feedbackIds: [] })).rejects.toThrow(/agent|conversation|turn/i);
    expect((await app.request('project.refresh')).design.id).toBe(original.id);
  });

  it('requires project trust before project-bound agent diagnostics can launch the CLI', async () => {
    const untrusted = new Application(path.join(directory, 'untrusted-preferences'), {
      chooseDirectory: async () => undefined,
      chooseFile: async () => undefined,
      openExternal: async () => undefined,
      event: () => undefined,
    });
    try {
      await untrusted.request('project.open', { path: root });
      doubles.emit = undefined;
      await expect(untrusted.request('agent.diagnostics')).rejects.toThrow(/trust/i);
      expect(doubles.emit).toBeUndefined();
    } finally {
      await untrusted.dispose();
    }
  });

  it('stores full verification output only in local run logs', async () => {
    const now = new Date().toISOString();
    const output = 'Full local diagnostic with private environment context';
    const file = await saveRunLog(path.join(directory, 'preferences'), root, 'run-logs-test', [
      {
        checkId: 'test',
        title: 'Tests',
        status: 'failed',
        exitCode: 1,
        startedAt: now,
        finishedAt: now,
        output,
      },
    ]);
    expect(file.startsWith(path.join(directory, 'preferences'))).toBe(true);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).checks[0].output).toBe(output);
    expect((await store.git.status()).files.some((item) => item.path.includes('run-logs'))).toBe(false);
    await expect(saveRunLog(path.join(directory, 'preferences'), root, '../escape', [])).rejects.toThrow();
  });
});

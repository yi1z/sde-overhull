import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/main/application';
import { GitService } from '../src/main/git';
import { designDigest } from '../src/main/project';
import type { AgentEvent, AppEvent, ProjectView } from '../src/shared/types';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function findPrototypeHeading(blocks: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const block of blocks) {
    if (block.type === 'Heading') return block;
    const content = (block.props as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content)) {
      const found = findPrototypeHeading(content as Record<string, unknown>[]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Opt-in because this uses the developer's authenticated Codex installation.
 * Everything it creates is confined to a disposable repository. The host is
 * headless, but the Application facade, Codex adapter, MCP tools, Git approval,
 * process supervisor, and verification handshake are the production ones.
 */
describe.skipIf(process.env.SDE_LIVE_ACCEPTANCE !== '1')('real Codex development acceptance', () => {
  it('designs, accepts a manual edit, implements, verifies, starts services, and records evaluation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'overhull-acceptance-'));
    const root = join(temporary, 'project');
    const settings = join(temporary, 'local-settings');
    await mkdir(root);
    const git = new GitService(root);
    await git.run(['init']);
    await git.run(['config', 'user.name', 'Overhull Acceptance']);
    await git.run(['config', 'user.email', 'acceptance@example.invalid']);
    await writeFile(join(root, 'README.md'), '# Disposable Overhull acceptance project\n');
    await writeFile(join(root, '.gitignore'), 'node_modules/\ncoverage/\n*.log\n');
    await git.run(['add', 'README.md', '.gitignore']);
    await git.run(['commit', '-m', 'Initialize acceptance project']);
    const backendPort = await availablePort();
    let frontendPort = await availablePort();
    while (frontendPort === backendPort) frontendPort = await availablePort();
    const events: AppEvent[] = [];
    const errors: string[] = [];
    let completedTurns = 0;
    let app: Application;
    const print = (text: string) => console.log(`[live acceptance] ${text}`);
    app = new Application(settings, {
      chooseDirectory: async () => root,
      chooseFile: async () => undefined,
      openExternal: async () => {},
      event: (event) => {
        events.push(event);
        if (event.type !== 'agent') return;
        const agent = event.data as AgentEvent;
        if (agent.type === 'turn-complete') {
          completedTurns++;
          print(`Agent turn ${completedTurns} completed: ${(agent.data as any)?.status}`);
        }
        if (agent.type === 'message-complete') print((agent.text ?? '').slice(0, 1000));
        if (agent.type === 'error') errors.push(agent.text ?? 'Agent failed.');
        if (agent.type === 'approval' && agent.id !== undefined) {
          const method = agent.method ?? '';
          const response = method.includes('permissions/')
            ? { permissions: {}, scope: 'turn' }
            : { decision: 'accept' };
          // This one-run test explicitly authorizes commands in its disposable
          // project. Approval responses are deferred until the facade records ID.
          setTimeout(() => {
            void app
              .request('agent.respond', { id: agent.id!, response })
              .catch((error) => errors.push(String(error)));
          }, 10);
        }
        if (agent.type === 'question' && agent.id !== undefined) {
          const data = agent.data as { questions?: { id: string }[] };
          const response =
            agent.method === 'mcpServer/elicitation/request'
              ? { action: 'decline', content: null }
              : {
                  answers: Object.fromEntries(
                    (data.questions ?? []).map((question) => [
                      question.id,
                      {
                        answers: [
                          'Use the explicitly supplied minimal requirements; no extra features or external dependencies.',
                        ],
                      },
                    ]),
                  ),
                };
          setTimeout(() => {
            void app
              .request('agent.respond', { id: agent.id!, response })
              .catch((error) => errors.push(String(error)));
          }, 10);
        }
      },
    });
    let latest: ProjectView | undefined;
    const waitUntil = async (description: string, predicate: () => Promise<boolean>, timeout = 360000) => {
      const deadline = Date.now() + timeout;
      let nextProgress = Date.now() + 15000;
      while (!(await predicate())) {
        if (errors.length) throw new Error(`${description}: ${errors.join('\n')}`);
        if (Date.now() > deadline)
          throw new Error(`${description} timed out. Latest run: ${JSON.stringify(latest?.runs.at(-1))}`);
        if (Date.now() >= nextProgress) {
          print(`Waiting for ${description}...`);
          nextProgress = Date.now() + 15000;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // The facade emits the raw event before its async persistence completes.
      await new Promise((resolve) => setTimeout(resolve, 350));
    };
    try {
      latest = (await app.request('project.open', { path: root }))!;
      await app.request('project.trust');
      if (process.env.SDE_CODEX_PATH)
        await app.request('settings.save', { codexPath: process.env.SDE_CODEX_PATH });
      const diagnostics = await app.request('agent.diagnostics');
      expect(diagnostics.available, diagnostics.error).toBe(true);
      expect(diagnostics.authenticated, diagnostics.error).toBe(true);
      print('Authenticated Codex connected; requesting a real design.');
      await app.request('agent.send', {
        phase: 'design',
        text: `Design a deliberately tiny full-stack web app named Team Greeting. All product choices are settled; create the artifacts now using Overhull tools and then review the latest digest.
Use only Node.js built-ins and plain HTML/CSS/JS; no dependency installation, React, database, credentials, external services, or external network. Two separate Node HTTP services: backend on 127.0.0.1:${backendPort}, frontend on 127.0.0.1:${frontendPort}. The backend serves GET /api/message returning {"message":"Hello team"} and GET /health. The frontend serves a simple page headed "Team greeting" and proxies /api/message to the backend so its button can fetch and show the greeting without CORS. Both servers should return 404 for unknown routes. Use deterministic fixed ports from this message.
Create 2 or 3 requirements and tasks covering backend, frontend, and tests. Required check commands must be executable "node", args ["--test","test.cjs"] for a unit test and ["smoke.cjs"] for an HTTP smoke test. The smoke check must list serviceIds ["frontend"], and the frontend service must depend on backend. Implementation will define the service commands via save_services. Test scripts must terminate after success/failure; server scripts must stay alive until stopped. Prefer CommonJS .cjs files throughout. Add these precise implementation constraints and ports to the design summary/decisions so the later implementation thread sees them.
Create exactly four compact diagrams, kinds workflow, ui, database, backend; two or three typed nodes each with a labeled edge. The database diagram should explicitly document that this app has no persistent database and only a static message model. Create one Puck prototype with a Heading text "Team greeting", a Text greeting placeholder, and Button label "Load greeting". Use stable IDs. No blocking questions are needed. Call update_design, then read the current context and review_design with its current digest. Do not implement code yet.`,
      });
      await waitUntil('initial design', async () => completedTurns >= 1);
      latest = await app.request('project.refresh');
      expect(new Set(latest.design.diagrams.map((diagram) => diagram.kind))).toEqual(
        new Set(['workflow', 'ui', 'database', 'backend']),
      );
      expect(latest.design.prototypes).toHaveLength(1);
      expect(latest.design.requirements.length).toBeGreaterThanOrEqual(2);
      expect(latest.design.checks.some((check) => check.required && check.kind === 'test')).toBe(true);
      expect(latest.design.checks.some((check) => check.required && check.kind === 'smoke')).toBe(true);
      expect(latest.design.reviewedDigest).toBe(designDigest(latest.design));

      const manual = structuredClone(latest.design);
      manual.decisions.push(
        'Human design revision: the page heading must now be exactly "Team workspace". Keep all behavior and service ports unchanged.',
      );
      manual.requirements[0].acceptance += ' The visible page heading must be exactly Team workspace.';
      const heading = findPrototypeHeading(manual.prototypes[0].data.content);
      expect(heading).toBeDefined();
      (heading!.props as Record<string, unknown>).text = 'Team workspace';
      manual.diagrams[0].nodes[0].position.x = 173;
      latest = await app.request('design.save', { design: manual, expectedRevision: latest.design.revision });
      expect(latest.design.reviewedDigest).toBeUndefined();
      print('Manual prototype and diagram changes saved; requesting feasibility review.');
      await app.request('agent.send', {
        phase: 'design',
        text: 'I manually changed the prototype heading to "Team workspace" and moved a diagram node. Read the latest context, confirm feasibility and the effect of these changes, preserve all manual positions/content, and record review_design for the exact current digest. No further artifact edits or questions are needed.',
      });
      await waitUntil('manual-change review', async () => completedTurns >= 2);
      latest = await app.request('project.refresh');
      expect(latest.design.diagrams[0].nodes[0].position.x).toBe(173);
      expect(latest.design.reviewedDigest).toBe(designDigest(latest.design));
      latest = await app.request('design.approve');
      expect(latest.approvals.at(-1)?.commit).toMatch(/^[a-f0-9]{40}$/);
      print('Design approved in Git; starting real local implementation.');
      latest = await app.request('run.start');
      await waitUntil(
        'agent-verified implementation',
        async () => {
          latest = await app.request('project.refresh');
          return latest.runs.at(-1)?.status === 'complete';
        },
        600000,
      );
      await waitUntil('final agent turn', async () => completedTurns >= 4, 60000);
      latest = await app.request('project.refresh');
      const run = latest.runs.at(-1)!;
      expect(run.status).toBe('complete');
      expect(latest.verifiedRunId).toBe(run.id);
      expect(run.checks.length).toBeGreaterThanOrEqual(2);
      expect(run.checks.every((result) => result.status === 'passed')).toBe(true);
      expect(latest.design.tasks.every((task) => !!run.taskEvidence[task.id])).toBe(true);
      expect(latest.services.map((service) => service.id).sort()).toEqual(['backend', 'frontend']);
      print('Host tests passed and agent confirmed completion; exercising one-click startup.');
      const states = await app.request('services.start');
      expect(states.every((state) => state.state === 'ready')).toBe(true);
      const html = await (await fetch(`http://127.0.0.1:${frontendPort}`)).text();
      expect(html).toContain('Team workspace');
      expect(await (await fetch(`http://127.0.0.1:${frontendPort}/api/message`)).json()).toEqual({
        message: 'Hello team',
      });
      expect((await fetch(`http://127.0.0.1:${backendPort}/health`)).ok).toBe(true);
      await app.request('services.stop');
      latest = await app.request('evaluation.save', {
        id: randomUUID(),
        title: 'Show the time of the last greeting',
        body: 'The implemented greeting works. Consider a timestamp in the next design round.',
        kind: 'idea',
        priority: 'low',
        status: 'open',
        roundId: latest.design.roundId,
        runId: run.id,
        target: latest.design.prototypes[0].id,
        author: 'Acceptance reviewer',
        createdAt: new Date().toISOString(),
        comments: [],
        attachments: [],
      });
      expect(latest.feedback).toHaveLength(1);
      expect(latest.feedback[0].runId).toBe(run.id);
      latest = await app.request('design.new', { feedbackIds: [latest.feedback[0].id] });
      expect(latest.design.sourceFeedbackIds).toEqual([latest.feedback[0].id]);
      print(
        `PASS: approved design → manual change → ${run.checks.length} passing host checks → completed run → two ready services → evaluation → next round.`,
      );
    } catch (error) {
      print(`FAIL: ${String(error)}`);
      if (latest) print(`Run evidence: ${JSON.stringify(latest.runs.at(-1))}`);
      const recent = events.filter((event) => event.type === 'agent').slice(-12);
      print(`Recent agent events: ${JSON.stringify(recent).slice(-16000)}`);
      throw error;
    } finally {
      await app.dispose();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 900000);
});

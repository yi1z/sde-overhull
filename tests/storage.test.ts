import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesignRevisionSchema, EvaluationSchema, MessageSchema, RunSchema, ServiceSchema, type DesignRevision } from '../src/shared/types';
import { ProjectStore, designDigest } from '../src/main/project';
import { GitService } from '../src/main/git';
import { contentDigest, projectPath, writeJson } from '../src/main/files';

let root: string;
let store: ProjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-storage-test-'));
  const git = await GitService.initialize(root);
  await git.run(['config', 'user.name', 'Test Developer']); await git.run(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'index.js'), 'export const answer = 42;\n');
  await git.commit('Initial source', ['index.js']);
  store = new ProjectStore(root); await store.initialize('Test Project');
});
afterEach(async () => {
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('overhull-storage-test-')) await fs.rm(root, { recursive: true, force: true });
});

async function executableDesign(): Promise<DesignRevision> {
  const view = await store.load();
  const design = DesignRevisionSchema.parse({ ...view.design,
    requirements: [{ id: 'requirement', title: 'Return an answer', acceptance: 'Returns 42' }],
    tasks: [{ id: 'task', title: 'Implement answer', requirementIds: ['requirement'] }],
    checks: [
      { id: 'test', title: 'Unit tests', kind: 'test', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, taskIds: ['task'] },
      { id: 'smoke', title: 'Application smoke test', kind: 'smoke', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] }, taskIds: ['task'] },
    ],
    diagrams: [{ id: 'workflow', title: 'User workflow', kind: 'workflow', nodes: [{ id: 'start', type: 'action', position: { x: 0, y: 0 }, data: { label: 'Start', requirementIds: ['requirement'] } }], edges: [] }],
  });
  return (await store.saveDraft(design, view.design.revision)).design;
}

describe('project persistence', () => {
  it('keeps deterministic digests and rejects traversal or a symbolic-link escape', async () => {
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }));
    await expect(projectPath(root, '../outside')).rejects.toThrow('outside');
    await expect(projectPath(root, '.git/config')).rejects.toThrow('outside');
    const target = path.join(root, 'outside-link');
    try {
      await fs.symlink(os.tmpdir(), target, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(projectPath(root, 'outside-link/escaped.json')).rejects.toThrow('escapes');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
  });

  it('rejects stale design and artifact writes without losing manual changes', async () => {
    const design = await executableDesign();
    const original = design.diagrams[0];
    const changed = await store.patchArtifact({ kind: 'diagram', id: original.id, expectedRevision: original.revision, value: { ...original, title: 'Manually improved flow' } });
    await expect(store.patchArtifact({ kind: 'diagram', id: original.id, expectedRevision: original.revision, value: { ...original, title: 'Stale agent flow' } })).rejects.toThrow('changed');
    await expect(store.saveDraft({ ...design, title: 'Stale full document' }, design.revision)).rejects.toThrow('changed');
    expect((await store.load()).design.diagrams[0].title).toBe('Manually improved flow');
    expect(changed.design.revision).toBe(design.revision + 1);
    expect((await store.history()).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects dangling edges and group cycles before modifying disk', async () => {
    const design = await executableDesign();
    const invalid = structuredClone(design);
    invalid.diagrams[0].edges.push({ id: 'broken', source: 'start', target: 'missing', label: '', kind: 'control' });
    await expect(store.saveDraft(invalid, design.revision)).rejects.toThrow('missing endpoint');
    expect((await store.load()).design).toEqual(design);
    invalid.diagrams[0].edges = [];
    invalid.diagrams[0].nodes = [{ id: 'group', type: 'group', parentId: 'group', position: { x: 0, y: 0 }, data: { label: 'Cycle', description: '', fields: [], requirementIds: [] } }];
    await expect(store.saveDraft(invalid, design.revision)).rejects.toThrow('cycle');
  });

  it('approves only the reviewed digest and loads authoritative design from its Git commit', async () => {
    const design = await executableDesign();
    await expect(store.approve()).rejects.toThrow('review');
    await expect(store.review('Looks good', 'outdated')).rejects.toThrow('changed');
    await store.review('All requirements and checks are covered.', designDigest(design));
    const approvedView = await store.approve();
    const approval = approvedView.approvals[0]; expect(approval.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(approval.designDigest).toBe(designDigest(approvedView.design));
    const file = path.join(root, '.sde', 'designs', design.id, 'design.json');
    const forged = JSON.parse(await fs.readFile(file, 'utf8')); forged.title = 'Unapproved rewrite'; await writeJson(file, forged);
    const authoritative = await store.getApproved(approval);
    expect(authoritative.design.title).toBe(design.title);
    expect((await store.load()).readOnly).toBe(true);
    // A new draft starts from the actual approved content, even after accidental working-tree edits.
    const next = await store.newDraft([]);
    expect(next.design.title).toBe(design.title); expect(next.design.id).not.toBe(design.id);
  });

  it('keeps messages immutable and feedback separate from verification code digests', async () => {
    const design = await executableDesign(); await store.review('Reviewed', designDigest(design)); const view = await store.approve();
    const code = await store.codeDigest();
    const run = RunSchema.parse({ id: randomUUID(), designId: design.id, designDigest: view.approvals[0].designDigest, approvalCommit: view.approvals[0].commit, baselineCommit: view.git.head,
      status: 'complete', startedAt: new Date().toISOString(), outputCodeDigest: code });
    await store.saveRun(run);
    const message = MessageSchema.parse({ id: randomUUID(), conversationId: 'conversation', roundId: design.roundId, role: 'assistant', author: 'Codex', text: 'Ready for review', createdAt: new Date().toISOString(), phase: 'evaluate' });
    await store.saveMessage(message); await store.saveMessage(message);
    await expect(store.saveMessage({ ...message, text: 'Rewritten' })).rejects.toThrow('immutable');
    await store.saveFeedback(EvaluationSchema.parse({ id: randomUUID(), title: 'Improve result', kind: 'idea', priority: 'low', status: 'open', roundId: design.roundId, author: 'Developer', createdAt: new Date().toISOString() }));
    expect(await store.codeDigest()).toBe(code); expect((await store.load()).verifiedRunId).toBe(run.id);
    await fs.writeFile(path.join(root, 'index.js'), 'export const answer = 43;\n');
    expect(await store.codeDigest()).not.toBe(code); expect((await store.load()).verifiedRunId).toBeUndefined();
    await expect(store.assertSourceClean()).rejects.toThrow('index.js');
  });

  it('validates service dependencies and includes executable configuration in code digests', async () => {
    const before = await store.codeDigest();
    const service = ServiceSchema.parse({ id: 'api', name: 'API', command: { executable: process.execPath, args: ['server.js'] } });
    await store.saveServices([service]); expect(await store.codeDigest()).not.toBe(before);
    await expect(store.saveServices([{ ...service, dependsOn: ['api'] }])).rejects.toThrow('cycle');
    await expect(store.saveServices([{ ...service, command: { ...service.command, cwd: '..' } }])).rejects.toThrow('outside');
  });

  it('validates the trusted prototype palette and cross-screen links before saving', async () => {
    const design = await executableDesign();
    const screen = { id: 'home', title: 'Home', revision: 0, requirementIds: [], data: { root: {}, content: [{ type: 'Button', props: { id: 'continue', label: 'Continue', targetScreen: 'missing' } }] } };
    await expect(store.saveDraft({ ...design, prototypes: [screen] }, design.revision)).rejects.toThrow('unknown screen');
    screen.data.content[0].props.targetScreen = '';
    const view = await store.saveDraft({ ...design, prototypes: [screen] }, design.revision);
    expect((view.design.prototypes[0].data.content[0].props as Record<string, unknown>).variant).toBe('primary');
    screen.data.content[0].type = 'UntrustedJavaScript';
    await expect(store.saveDraft({ ...view.design, prototypes: [screen] }, view.design.revision)).rejects.toThrow('Unknown component');
  });

  it('loads future formats read-only and recovers the last valid revision after malformed data', async () => {
    const design = await executableDesign();
    await fs.writeFile(path.join(root, '.sde', 'designs', design.id, 'diagrams', 'workflow.json'), '{ malformed');
    const recovered = await store.load(); expect(recovered.readOnly).toBe(true); expect(recovered.design.title).toBe(design.title);
    expect(recovered.warnings.join(' ')).toContain('recoverable revision');
    const manifestFile = path.join(root, '.sde', 'project.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); manifest.schemaVersion = 2; await writeJson(manifestFile, manifest);
    await expect(store.saveMessage(MessageSchema.parse({ id: randomUUID(), conversationId: 'c', roundId: design.roundId, role: 'user', author: 'Developer', text: 'Hello', createdAt: new Date().toISOString(), phase: 'design' }))).rejects.toThrow('newer metadata');
    expect((await store.load()).readOnly).toBe(true);
  });

  it('treats a persisted active run as interrupted after reopening on another process', async () => {
    const design = await executableDesign();
    const run = RunSchema.parse({ id: randomUUID(), designId: design.id, designDigest: designDigest(design), approvalCommit: 'not-yet-approved', baselineCommit: (await store.git.head()), status: 'running', startedAt: new Date().toISOString() });
    await store.saveRun(run); expect((await store.load()).runs[0].status).toBe('running');
    expect((await new ProjectStore(root).load()).runs[0].status).toBe('interrupted');
  });
});

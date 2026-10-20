import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DesignRevisionSchema,
  EvaluationSchema,
  MessageSchema,
  RunSchema,
  ServiceSchema,
  type DesignRevision,
} from '../src/shared/types';
import { ProjectStore, designDigest } from '../src/main/project';
import { GitService } from '../src/main/git';
import { contentDigest, projectPath, writeJson } from '../src/main/files';

let root: string;
let store: ProjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-storage-test-'));
  const git = await GitService.initialize(root);
  await git.run(['config', 'user.name', 'Test Developer']);
  await git.run(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(root, 'index.js'), 'export const answer = 42;\n');
  await git.commit('Initial source', ['index.js']);
  store = new ProjectStore(root);
  await store.initialize('Test Project');
});
afterEach(async () => {
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('overhull-storage-test-'))
    await fs.rm(root, { recursive: true, force: true });
});

async function executableDesign(): Promise<DesignRevision> {
  const view = await store.load();
  const design = DesignRevisionSchema.parse({
    ...view.design,
    requirements: [{ id: 'requirement', title: 'Return an answer', acceptance: 'Returns 42' }],
    tasks: [{ id: 'task', title: 'Implement answer', requirementIds: ['requirement'] }],
    checks: [
      {
        id: 'test',
        title: 'Unit tests',
        kind: 'test',
        command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
        taskIds: ['task'],
      },
      {
        id: 'smoke',
        title: 'Application smoke test',
        kind: 'smoke',
        command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
        taskIds: ['task'],
      },
    ],
    diagrams: [
      {
        id: 'workflow',
        title: 'User workflow',
        kind: 'workflow',
        nodes: [
          {
            id: 'start',
            type: 'action',
            position: { x: 0, y: 0 },
            data: { label: 'Start', requirementIds: ['requirement'] },
          },
        ],
        edges: [],
      },
    ],
  });
  return (await store.saveDraft(design, view.design.revision)).design;
}

describe('project persistence', () => {
  it('keeps deterministic digests and rejects traversal or a symbolic-link escape', async () => {
    expect(contentDigest({ b: 2, a: 1 })).toBe(contentDigest({ a: 1, b: 2 }));
    await expect(projectPath(root, '../outside')).rejects.toThrow('outside');
    await expect(projectPath(root, '.git/config')).rejects.toThrow('outside');
    await expect(projectPath(root, '.GIT/config')).rejects.toThrow('outside');
    await expect(projectPath(root, '.git./config')).rejects.toThrow('outside');
    await expect(projectPath(root, 'index.js:stream')).rejects.toThrow('outside');
    const target = path.join(root, 'outside-link');
    try {
      await fs.symlink(os.tmpdir(), target, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(projectPath(root, 'outside-link/escaped.json')).rejects.toThrow('escapes');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    try {
      await fs.symlink(
        path.join(root, '.git'),
        path.join(root, 'git-alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(projectPath(root, 'git-alias/config')).rejects.toThrow('outside');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('rejects stale design and artifact writes without losing manual changes', async () => {
    const design = await executableDesign();
    const original = design.diagrams[0];
    const changed = await store.patchArtifact({
      kind: 'diagram',
      id: original.id,
      expectedRevision: original.revision,
      value: { ...original, title: 'Manually improved flow' },
    });
    await expect(
      store.patchArtifact({
        kind: 'diagram',
        id: original.id,
        expectedRevision: original.revision,
        value: { ...original, title: 'Stale agent flow' },
      }),
    ).rejects.toThrow('changed');
    await expect(
      store.saveDraft({ ...design, title: 'Stale full document' }, design.revision),
    ).rejects.toThrow('changed');
    expect((await store.load()).design.diagrams[0].title).toBe('Manually improved flow');
    expect(changed.design.revision).toBe(design.revision + 1);
    expect((await store.history()).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects dangling edges and group cycles before modifying disk', async () => {
    const design = await executableDesign();
    const invalid = structuredClone(design);
    invalid.diagrams[0].edges.push({
      id: 'broken',
      source: 'start',
      target: 'missing',
      label: '',
      kind: 'control',
    });
    await expect(store.saveDraft(invalid, design.revision)).rejects.toThrow('missing endpoint');
    expect((await store.load()).design).toEqual(design);
    invalid.diagrams[0].edges = [];
    invalid.diagrams[0].nodes = [
      {
        id: 'group',
        type: 'group',
        parentId: 'group',
        position: { x: 0, y: 0 },
        data: { label: 'Cycle', description: '', fields: [], requirementIds: [] },
      },
    ];
    await expect(store.saveDraft(invalid, design.revision)).rejects.toThrow('cycle');
  });

  it('approves only the reviewed digest and loads authoritative design from its Git commit', async () => {
    const design = await executableDesign();
    await expect(store.approve()).rejects.toThrow('review');
    await expect(store.review('Looks good', 'outdated')).rejects.toThrow('changed');
    await store.review('All requirements and checks are covered.', designDigest(design));
    const approvedView = await store.approve();
    const approval = approvedView.approvals[0];
    expect(approval.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(approval.designDigest).toBe(designDigest(approvedView.design));
    const file = path.join(root, '.sde', 'designs', design.id, 'design.json');
    const forged = JSON.parse(await fs.readFile(file, 'utf8'));
    forged.title = 'Unapproved rewrite';
    await writeJson(file, forged);
    const authoritative = await store.getApproved(approval);
    expect(authoritative.design.title).toBe(design.title);
    expect((await store.load()).readOnly).toBe(true);
    await writeJson(path.join(root, '.sde', 'designs', design.id, 'diagrams', 'workflow.json'), {
      ...design.diagrams[0],
      title: 'Accidental artifact edit',
    });
    // A new draft starts from the actual approved content, even after accidental working-tree edits.
    const next = await store.newDraft([]);
    expect(next.design.title).toBe(design.title);
    expect(next.design.id).not.toBe(design.id);
  });

  it('keeps messages immutable and feedback separate from verification code digests', async () => {
    const design = await executableDesign();
    await store.review('Reviewed', designDigest(design));
    const view = await store.approve();
    const code = await store.codeDigest();
    const run = RunSchema.parse({
      id: randomUUID(),
      designId: design.id,
      designDigest: view.approvals[0].designDigest,
      approvalCommit: view.approvals[0].commit,
      baselineCommit: view.git.head,
      status: 'complete',
      startedAt: new Date().toISOString(),
      outputCodeDigest: code,
      taskEvidence: { task: 'index.js implements the answer' },
      checks: design.checks.map((check) => ({
        checkId: check.id,
        title: check.title,
        status: 'passed',
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        output: 'passed',
        codeDigest: code,
      })),
    });
    await store.saveRun(run);
    const message = MessageSchema.parse({
      id: randomUUID(),
      conversationId: 'conversation',
      roundId: design.roundId,
      role: 'assistant',
      author: 'Codex',
      text: 'Ready for review',
      createdAt: new Date().toISOString(),
      phase: 'evaluate',
    });
    await store.saveMessage(message);
    await store.saveMessage(message);
    await expect(store.saveMessage({ ...message, text: 'Rewritten' })).rejects.toThrow('immutable');
    await store.saveFeedback(
      EvaluationSchema.parse({
        id: randomUUID(),
        title: 'Improve result',
        kind: 'idea',
        priority: 'low',
        status: 'open',
        roundId: design.roundId,
        author: 'Developer',
        createdAt: new Date().toISOString(),
      }),
    );
    expect(await store.codeDigest()).toBe(code);
    expect((await store.load()).verifiedRunId).toBe(run.id);
    await fs.writeFile(path.join(root, 'index.js'), 'export const answer = 43;\n');
    expect(await store.codeDigest()).not.toBe(code);
    expect((await store.load()).verifiedRunId).toBeUndefined();
    await expect(store.assertSourceClean()).rejects.toThrow('index.js');
  });

  it('validates service dependencies and includes executable configuration in code digests', async () => {
    const before = await store.codeDigest();
    const service = ServiceSchema.parse({
      id: 'api',
      name: 'API',
      command: { executable: process.execPath, args: ['server.js'] },
    });
    await store.saveServices([service]);
    expect(await store.codeDigest()).not.toBe(before);
    await expect(store.saveServices([{ ...service, dependsOn: ['api'] }])).rejects.toThrow('cycle');
    await expect(
      store.saveServices([{ ...service, command: { ...service.command, cwd: '..' } }]),
    ).rejects.toThrow('outside');
  });

  it('includes initialized submodule commits, dirty files, and untracked source in verification digests', async () => {
    const dependencySource = path.join(root, 'dependency-source');
    const dependency = await GitService.initialize(dependencySource);
    await dependency.run(['config', 'user.name', 'Test Developer']);
    await dependency.run(['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(dependencySource, 'dependency.js'), 'export const value = 1;\n');
    await dependency.commit('Initial dependency', ['dependency.js']);
    await fs.writeFile(path.join(root, '.gitignore'), 'dependency-source/\n');
    await store.git.run([
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      './dependency-source',
      'vendor/dependency',
    ]);
    await store.git.commit('Add dependency', ['.gitignore', '.gitmodules', 'vendor/dependency']);
    const moduleRoot = path.join(root, 'vendor', 'dependency');
    const moduleGit = new GitService(moduleRoot);
    await moduleGit.run(['config', 'user.name', 'Test Developer']);
    await moduleGit.run(['config', 'user.email', 'test@example.invalid']);
    const original = await store.codeDigest();
    await fs.writeFile(path.join(moduleRoot, 'dependency.js'), 'export const value = 2;\n');
    const dirty = await store.codeDigest();
    expect(dirty).not.toBe(original);
    await fs.writeFile(path.join(moduleRoot, 'additional.js'), 'export const additional = true;\n');
    const untracked = await store.codeDigest();
    expect(untracked).not.toBe(dirty);
    await moduleGit.commit('Updated dependency', ['dependency.js', 'additional.js']);
    expect(await store.codeDigest()).not.toBe(untracked);
    await expect(store.assertSourceClean()).rejects.toThrow('vendor/dependency');
  });

  it('does not hide source changes when a tracked source file is renamed into metadata', async () => {
    await store.git.run(['mv', 'index.js', '.sde/notes.txt']);
    expect(
      (await store.git.status()).files.find((file) => file.path === '.sde/notes.txt')?.originalPath,
    ).toBe('index.js');
    await expect(store.assertSourceClean()).rejects.toThrow('source');
    await expect(store.approve()).rejects.toThrow('source changes');
  });

  it('validates the trusted prototype palette and cross-screen links before saving', async () => {
    const design = await executableDesign();
    const screen = {
      id: 'home',
      title: 'Home',
      revision: 0,
      requirementIds: [],
      data: {
        root: {},
        content: [{ type: 'Button', props: { id: 'continue', label: 'Continue', targetScreen: 'missing' } }],
      },
    };
    await expect(store.saveDraft({ ...design, prototypes: [screen] }, design.revision)).rejects.toThrow(
      'unknown screen',
    );
    screen.data.content[0].props.targetScreen = '';
    const view = await store.saveDraft({ ...design, prototypes: [screen] }, design.revision);
    expect((view.design.prototypes[0].data.content[0].props as Record<string, unknown>).variant).toBe(
      'primary',
    );
    screen.data.content[0].type = 'UntrustedJavaScript';
    await expect(
      store.saveDraft({ ...view.design, prototypes: [screen] }, view.design.revision),
    ).rejects.toThrow('Unknown component');
  });

  it('loads future formats read-only and recovers the last valid revision after malformed data', async () => {
    const design = await executableDesign();
    await fs.writeFile(
      path.join(root, '.sde', 'designs', design.id, 'diagrams', 'workflow.json'),
      '{ malformed',
    );
    const recovered = await store.load();
    expect(recovered.readOnly).toBe(true);
    expect(recovered.design.title).toBe(design.title);
    expect(recovered.warnings.join(' ')).toContain('recoverable revision');
    const manifestFile = path.join(root, '.sde', 'project.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.schemaVersion = 2;
    await writeJson(manifestFile, manifest);
    await expect(
      store.saveMessage(
        MessageSchema.parse({
          id: randomUUID(),
          conversationId: 'c',
          roundId: design.roundId,
          role: 'user',
          author: 'Developer',
          text: 'Hello',
          createdAt: new Date().toISOString(),
          phase: 'design',
        }),
      ),
    ).rejects.toThrow('newer metadata');
    expect((await store.load()).readOnly).toBe(true);
  });

  it('detects schema-valid mixed artifact revisions and preserves complete recovery snapshots', async () => {
    const previous = await executableDesign();
    const oldDescriptor = await fs.readFile(
      path.join(root, '.sde', 'designs', previous.id, 'design.json'),
      'utf8',
    );
    const next = structuredClone(previous);
    next.diagrams[0].nodes[0].position.x = 480;
    const saved = (await store.saveDraft(next, previous.revision)).design;
    // Simulate a crash after component files are replaced but before the descriptor is committed.
    await fs.writeFile(path.join(root, '.sde', 'designs', previous.id, 'design.json'), oldDescriptor);
    const recovered = await new ProjectStore(root).load();
    expect(recovered.readOnly).toBe(true);
    expect(recovered.warnings.join(' ')).toContain('mixed');
    expect(recovered.design).toEqual(saved);
    expect((await store.history()).some((item) => item.revision === previous.revision)).toBe(true);
    await expect(store.saveDraft(previous, previous.revision)).rejects.toThrow('mixed');
    const rawDiagram = JSON.parse(
      await fs.readFile(path.join(root, '.sde', 'designs', previous.id, 'diagrams', 'workflow.json'), 'utf8'),
    );
    expect(rawDiagram.nodes[0].position.x).toBe(480);
  });

  it('reads existing legacy descriptors and detects their snapshot mismatch without rewriting them', async () => {
    const design = await executableDesign();
    const descriptorPath = path.join(root, '.sde', 'designs', design.id, 'design.json');
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    delete descriptor.artifactDigests;
    await writeJson(descriptorPath, descriptor);
    const legacy = await store.load();
    expect(legacy.readOnly).toBe(false);
    expect(legacy.design).toEqual(design);
    const diagramPath = path.join(root, '.sde', 'designs', design.id, 'diagrams', 'workflow.json');
    await writeJson(diagramPath, { ...design.diagrams[0], title: 'Partial next revision' });
    const mixed = await store.load();
    expect(mixed.readOnly).toBe(true);
    expect(mixed.design).toEqual(design);
    expect(mixed.warnings.join(' ')).toContain('complete revision snapshot');
    expect(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).artifactDigests).toBeUndefined();
  });

  it('rechecks completion evidence instead of trusting a complete status in pulled run records', async () => {
    const design = await executableDesign();
    await store.review('Reviewed', designDigest(design));
    const view = await store.approve();
    const digest = await store.codeDigest();
    const valid = RunSchema.parse({
      id: 'run',
      designId: design.id,
      designDigest: view.approvals[0].designDigest,
      approvalCommit: view.approvals[0].commit,
      baselineCommit: view.git.head,
      status: 'complete',
      startedAt: '2026-01-01T00:00:00.000Z',
      outputCodeDigest: digest,
      taskEvidence: { task: 'Implemented in index.js' },
      checks: design.checks.map((check) => ({
        checkId: check.id,
        title: check.title,
        status: 'passed',
        exitCode: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        output: 'passed',
        codeDigest: digest,
      })),
    });
    const invalid = [
      { ...valid, taskEvidence: {} },
      { ...valid, taskEvidence: { task: '  ' } },
      { ...valid, blockers: ['Unresolved bug'] },
      { ...valid, approvalCommit: 'f'.repeat(40) },
      { ...valid, checks: valid.checks.slice(1) },
      { ...valid, checks: valid.checks.map((check) => ({ ...check, codeDigest: 'stale-code' })) },
      { ...valid, checks: [...valid.checks, { ...valid.checks[0], status: 'failed' as const, exitCode: 1 }] },
      { ...valid, status: 'cancelled' as const },
    ];
    for (const run of invalid) {
      await store.saveRun(run);
      const reloaded = await new ProjectStore(root).load();
      expect(reloaded.runs).toHaveLength(1);
      expect(reloaded.verifiedRunId).toBeUndefined();
    }
    await store.saveRun(valid);
    expect((await new ProjectStore(root).load()).verifiedRunId).toBe('run');
  });

  it('treats a persisted active run as interrupted after reopening on another process', async () => {
    const design = await executableDesign();
    const run = RunSchema.parse({
      id: randomUUID(),
      designId: design.id,
      designDigest: designDigest(design),
      approvalCommit: 'not-yet-approved',
      baselineCommit: await store.git.head(),
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    await store.saveRun(run);
    expect((await store.load()).runs[0].status).toBe('running');
    expect((await new ProjectStore(root).load()).runs[0].status).toBe('interrupted');
  });
});

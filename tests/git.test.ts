import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git';
import { ProjectStore } from '../src/main/project';
import { DesignRevisionSchema, MessageSchema, EvaluationSchema, RunSchema } from '../src/shared/types';
import { prototypeDataExample } from '../src/shared/prototypes';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-git-test-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (
    directory &&
    path.dirname(directory) === os.tmpdir() &&
    path.basename(directory).startsWith('overhull-git-test-')
  )
    await fs.rm(directory, { recursive: true, force: true });
});
async function configure(git: GitService): Promise<void> {
  await git.run(['config', 'user.name', 'Test Developer']);
  await git.run(['config', 'user.email', 'test@example.invalid']);
  await git.run(['config', 'core.autocrlf', 'false']);
}

describe('Git collaboration', () => {
  it('isolates the selected checkout from inherited repository and index overrides', async () => {
    const selectedRoot = path.join(directory, 'selected');
    const selected = await GitService.initialize(selectedRoot);
    await configure(selected);
    await fs.writeFile(path.join(selectedRoot, 'selected.txt'), 'selected');
    const selectedHead = await selected.commit('Selected repository', ['selected.txt']);
    const otherRoot = path.join(directory, 'other');
    const other = await GitService.initialize(otherRoot);
    await configure(other);
    await fs.writeFile(path.join(otherRoot, 'other.txt'), 'other');
    await other.commit('Different repository', ['other.txt']);
    vi.stubEnv('GIT_DIR', path.join(otherRoot, '.git'));
    vi.stubEnv('GIT_WORK_TREE', otherRoot);
    vi.stubEnv('GIT_INDEX_FILE', path.join(directory, 'unrelated-index'));
    vi.stubEnv('GIT_GLOB_PATHSPECS', '1');
    expect(await selected.head()).toBe(selectedHead);
    expect((await selected.status()).files).toHaveLength(0);
    await fs.writeFile(path.join(selectedRoot, 'selected.txt'), 'changed selected');
    await selected.commit('Change selected', ['selected.txt']);
    expect(await other.run(['show', 'HEAD:other.txt'])).toBe('other');
  });

  it('commits selected working-tree files without committing or clearing unrelated staging', async () => {
    const root = path.join(directory, 'repo');
    const git = await GitService.initialize(root);
    await configure(git);
    await fs.writeFile(path.join(root, 'selected.txt'), 'base');
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'base');
    await git.commit('Initial', ['selected.txt', 'unrelated.txt']);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'staged unrelated');
    await git.run(['add', 'unrelated.txt']);
    await fs.writeFile(path.join(root, 'selected.txt'), 'selected change');
    await git.commit('Selected only', ['selected.txt']);
    expect(await git.run(['show', 'HEAD:unrelated.txt'])).toBe('base');
    expect(await git.run(['show', ':unrelated.txt'])).toBe('staged unrelated');
    expect((await git.status()).files).toEqual([
      expect.objectContaining({ path: 'unrelated.txt', index: 'M', worktree: ' ' }),
    ]);
    git.setBusy(true);
    await expect(git.pull()).rejects.toThrow('implementation');
  });

  it('includes the original path when committing a selected rename', async () => {
    const root = path.join(directory, 'repo');
    const git = await GitService.initialize(root);
    await configure(git);
    await fs.writeFile(path.join(root, 'before.txt'), 'Preserve my content');
    await git.commit('Initial', ['before.txt']);
    await git.run(['mv', 'before.txt', 'after.txt']);
    expect((await git.status()).files[0]).toMatchObject({ path: 'after.txt', originalPath: 'before.txt' });
    await git.commit('Rename selected file', ['after.txt']);
    expect((await git.run(['ls-tree', '--name-only', 'HEAD'])).trim()).toBe('after.txt');
    expect((await git.status()).files).toHaveLength(0);
  });

  it('synchronizes populated designs, prototypes, conversations, run reports and anchored feedback across two independent clones', async () => {
    const remote = path.join(directory, 'remote.git');
    await fs.mkdir(remote);
    await new GitService(remote).run(['init', '--bare', '-b', 'main']);
    const firstRoot = path.join(directory, 'first');
    const first = await GitService.initialize(firstRoot);
    await configure(first);
    await first.run(['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(firstRoot, 'README.md'), '# Shared project\n');
    await first.commit('Initial code baseline', ['README.md']);
    const firstStore = new ProjectStore(firstRoot);
    const initial = await firstStore.initialize('Shared project');
    const draft = DesignRevisionSchema.parse({
      ...initial.design,
      title: 'Shared project workspace',
      summary: 'Create projects from a shared workspace and persist their status.',
      requirements: [
        {
          id: 'requirement-projects',
          title: 'Create projects',
          acceptance: 'A saved project remains visible after reload.',
        },
      ],
      tasks: [
        {
          id: 'task-projects',
          title: 'Implement project creation and persistence',
          requirementIds: ['requirement-projects'],
        },
      ],
      checks: [
        {
          id: 'check-unit',
          title: 'Project persistence tests',
          kind: 'test',
          required: true,
          command: { executable: 'node', args: ['--test'] },
          taskIds: ['task-projects'],
        },
        {
          id: 'check-smoke',
          title: 'Workspace smoke check',
          kind: 'smoke',
          required: true,
          command: { executable: 'node', args: ['smoke.mjs'] },
          taskIds: ['task-projects'],
        },
      ],
      decisions: ['Expose project status in the workspace table.'],
      diagrams: [
        {
          id: 'diagram-projects',
          title: 'Project persistence',
          kind: 'backend',
          revision: 0,
          nodes: [
            {
              id: 'screen-workspace',
              type: 'screen',
              position: { x: 40, y: 120 },
              data: { label: 'Project workspace', requirementIds: ['requirement-projects'] },
            },
            {
              id: 'group-backend',
              type: 'group',
              position: { x: 340, y: 40 },
              width: 420,
              height: 380,
              data: { label: 'Backend' },
            },
            {
              id: 'api-projects',
              type: 'api',
              parentId: 'group-backend',
              position: { x: 40, y: 60 },
              data: { label: 'POST /projects', description: 'Validate project name and write the record.' },
            },
            {
              id: 'entity-projects',
              type: 'entity',
              parentId: 'group-backend',
              position: { x: 40, y: 210 },
              data: {
                label: 'projects',
                fields: [
                  { name: 'id', type: 'uuid', primary: true },
                  { name: 'name', type: 'text' },
                  { name: 'owner_id', type: 'uuid', foreign: true },
                ],
              },
            },
          ],
          edges: [
            {
              id: 'request-projects',
              source: 'screen-workspace',
              target: 'api-projects',
              label: 'Create project',
              kind: 'control',
            },
            {
              id: 'write-projects',
              source: 'api-projects',
              target: 'entity-projects',
              label: 'Persists',
              kind: 'relationship',
              cardinality: '1:N',
            },
          ],
        },
      ],
      prototypes: [
        {
          id: 'prototype-workspace',
          title: 'Project workspace screen',
          revision: 0,
          requirementIds: ['requirement-projects'],
          data: structuredClone(prototypeDataExample),
        },
      ],
    });
    await firstStore.saveDraft(draft, initial.design.revision);
    await firstStore.review(
      'The diagram, editable prototype, implementation task, and required checks agree.',
    );
    const approved = await firstStore.approve();
    const approval = approved.approvals[0];
    const conversation = [
      MessageSchema.parse({
        id: 'message-one',
        conversationId: initial.design.roundId,
        roundId: initial.design.roundId,
        role: 'user',
        author: 'First',
        text: 'Build a shared app',
        phase: 'design',
        createdAt: '2026-10-20T00:00:00Z',
      }),
      MessageSchema.parse({
        id: 'message-agent',
        conversationId: initial.design.roundId,
        roundId: initial.design.roundId,
        role: 'assistant',
        author: 'Codex',
        replyTo: 'message-one',
        artifactId: 'diagram-projects',
        text: 'The workspace calls POST /projects, which validates and persists the project. The prototype shows the shared workspace.',
        phase: 'design',
        createdAt: '2026-10-20T00:01:00Z',
      }),
    ];
    for (const message of conversation) await firstStore.saveMessage(message);
    // This report is transport-fixture evidence, not a claim that a real agent run passed.
    const report = RunSchema.parse({
      id: 'run-projects',
      designId: approved.design.id,
      designDigest: approval.designDigest,
      approvalCommit: approval.commit,
      baselineCommit: approval.baselineCommit,
      status: 'failed',
      startedAt: '2026-10-20T00:10:00Z',
      finishedAt: '2026-10-20T00:11:00Z',
      checkpointDigest: await firstStore.codeDigest(),
      taskEvidence: {
        'task-projects':
          'The committed README records the starting scope; implementation remains incomplete.',
      },
      checks: [
        {
          checkId: 'check-smoke',
          title: 'Workspace smoke check',
          status: 'blocked',
          exitCode: null,
          startedAt: '2026-10-20T00:10:00Z',
          finishedAt: '2026-10-20T00:11:00Z',
          output: 'The workspace has not been implemented; no passing check is claimed.',
        },
      ],
      blockers: ['Project creation still needs implementation.'],
      summary: 'Collaboration fixture: preserve an incomplete implementation report and its evidence.',
    });
    await firstStore.saveRun(report);
    await first.commit('Share project', ['.sde']);
    await first.push();
    const secondRoot = path.join(directory, 'second');
    await new GitService(directory).run(['-c', 'core.autocrlf=false', 'clone', remote, secondRoot]);
    const second = new GitService(secondRoot);
    await configure(second);
    const secondStore = new ProjectStore(secondRoot);
    const loaded = await secondStore.load();
    expect(loaded.manifest.id).toBe(initial.manifest.id);
    expect(loaded.design).toEqual(approved.design);
    expect(loaded.design.diagrams[0].nodes.find((node) => node.id === 'api-projects')).toMatchObject({
      parentId: 'group-backend',
      position: { x: 40, y: 60 },
    });
    expect(loaded.design.diagrams[0].edges[1].cardinality).toBe('1:N');
    expect(loaded.design.prototypes[0].data).toEqual(approved.design.prototypes[0].data);
    expect(loaded.messages).toEqual(conversation);
    expect(loaded.runs).toEqual([report]);
    expect(loaded.verifiedRunId).toBeUndefined();
    expect((await secondStore.getApproved()).approval.commit).toBe(approval.commit);
    const feedback = EvaluationSchema.parse({
      id: 'feedback-one',
      title: 'Add filtering',
      body: 'Filter the project workspace by status after completing project creation.',
      kind: 'idea',
      priority: 'medium',
      status: 'open',
      roundId: loaded.design.roundId,
      runId: loaded.runs[0].id,
      target: loaded.design.prototypes[0].id,
      author: 'Second',
      createdAt: '2026-10-20T01:00:00Z',
      comments: [
        {
          id: 'comment-filter',
          author: 'Second',
          text: 'Keep the diagram-projects screen-workspace flow aligned with this screen.',
          createdAt: '2026-10-20T01:01:00Z',
        },
      ],
    });
    await secondStore.saveFeedback(feedback);
    const continuation = MessageSchema.parse({
      id: 'message-teammate',
      conversationId: loaded.design.roundId,
      roundId: loaded.design.roundId,
      role: 'user',
      author: 'Second',
      phase: 'evaluate',
      artifactId: 'prototype-workspace',
      replyTo: 'message-agent',
      text: 'I pulled the design and incomplete run report. Please consider status filtering in the next iteration.',
      createdAt: '2026-10-20T01:02:00Z',
    });
    await secondStore.saveMessage(continuation);
    await second.commit('Share anchored feedback and teammate continuation', [
      '.sde/feedback',
      '.sde/messages',
    ]);
    await second.push();
    await first.pull();
    for (const store of [firstStore, secondStore]) {
      const synchronized = await store.load();
      expect(synchronized.design).toEqual(approved.design);
      expect(synchronized.messages).toEqual([...conversation, continuation]);
      expect(synchronized.runs).toEqual([report]);
      expect(synchronized.feedback).toEqual([feedback]);
      const anchor = synchronized.feedback[0];
      expect(synchronized.runs.find((run) => run.id === anchor.runId)?.designId).toBe(synchronized.design.id);
      expect(synchronized.design.prototypes.some((screen) => screen.id === anchor.target)).toBe(true);
      expect(anchor.roundId).toBe(synchronized.design.roundId);
      expect(synchronized.verifiedRunId).toBeUndefined();
      expect(synchronized.warnings).toEqual([]);
      expect(synchronized.git.files).toEqual([]);
    }
  });

  it('surfaces divergence, preserves both conflicting versions, and resolves an explicit merge', async () => {
    const remote = path.join(directory, 'remote.git');
    await fs.mkdir(remote);
    await new GitService(remote).run(['init', '--bare', '-b', 'main']);
    const firstRoot = path.join(directory, 'first');
    const first = await GitService.initialize(firstRoot);
    await configure(first);
    await first.run(['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(firstRoot, 'design.txt'), 'original\n');
    await first.commit('Initial', ['design.txt']);
    await first.push();
    const secondRoot = path.join(directory, 'second');
    await new GitService(directory).run(['clone', remote, secondRoot]);
    const second = new GitService(secondRoot);
    await configure(second);
    await fs.writeFile(path.join(firstRoot, 'design.txt'), 'first idea\n');
    await first.commit('First idea', ['design.txt']);
    await fs.writeFile(path.join(secondRoot, 'design.txt'), 'second idea\n');
    await second.commit('Second idea', ['design.txt']);
    await second.push();
    await expect(first.pull()).rejects.toThrow('diverged');
    await expect(first.merge()).rejects.toThrow();
    expect((await first.status()).conflicts).toEqual(['design.txt']);
    const conflict = await first.conflict('design.txt');
    expect(conflict.ours).toBe('first idea\n');
    expect(conflict.theirs).toBe('second idea\n');
    await expect(
      first.resolveConflict('design.txt', '<<<<<<< ours\nfirst idea\n=======\nsecond idea\n>>>>>>> theirs\n'),
    ).rejects.toThrow('markers');
    await first.resolveConflict('design.txt', 'combined idea\n');
    await expect(first.commit('Incorrect partial merge', ['design.txt'])).rejects.toThrow('Finish the merge');
    await first.finishMerge();
    await first.push();
    await second.pull();
    expect(await fs.readFile(path.join(secondRoot, 'design.txt'), 'utf8')).toBe('combined idea\n');
  });
});

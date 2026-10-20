import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git';
import { ProjectStore } from '../src/main/project';
import { MessageSchema, EvaluationSchema } from '../src/shared/types';

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

  it('synchronizes project conversations and evaluation content across two independent clones', async () => {
    const remote = path.join(directory, 'remote.git');
    await fs.mkdir(remote);
    await new GitService(remote).run(['init', '--bare', '-b', 'main']);
    const firstRoot = path.join(directory, 'first');
    const first = await GitService.initialize(firstRoot);
    await configure(first);
    await first.run(['remote', 'add', 'origin', remote]);
    const firstStore = new ProjectStore(firstRoot);
    const initial = await firstStore.initialize('Shared project');
    await firstStore.saveMessage(
      MessageSchema.parse({
        id: 'message-one',
        conversationId: 'conversation',
        roundId: initial.design.roundId,
        role: 'user',
        author: 'First',
        text: 'Build a shared app',
        phase: 'design',
        createdAt: '2026-10-20T00:00:00Z',
      }),
    );
    await first.commit('Share project', ['.sde']);
    await first.push();
    const secondRoot = path.join(directory, 'second');
    await new GitService(directory).run(['clone', remote, secondRoot]);
    const second = new GitService(secondRoot);
    await configure(second);
    const secondStore = new ProjectStore(secondRoot);
    const loaded = await secondStore.load();
    expect(loaded.manifest.id).toBe(initial.manifest.id);
    expect(loaded.messages[0].text).toBe('Build a shared app');
    await secondStore.saveFeedback(
      EvaluationSchema.parse({
        id: 'feedback-one',
        title: 'Add filtering',
        kind: 'idea',
        priority: 'medium',
        status: 'open',
        roundId: loaded.design.roundId,
        author: 'Second',
        createdAt: '2026-10-20T01:00:00Z',
      }),
    );
    await second.commit('Share feedback', ['.sde/feedback']);
    await second.push();
    await first.pull();
    expect((await firstStore.load()).feedback[0].title).toBe('Add filtering');
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

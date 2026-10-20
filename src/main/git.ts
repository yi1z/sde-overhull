import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, projectPath } from './files';
import type { GitFile, GitStatus, GitConflict } from '../shared/types';

export class GitError extends Error {
  constructor(message: string, public exitCode: number, public args: string[]) { super(message); this.name = 'GitError'; }
}

const mutations = new Map<string, Promise<unknown>>();

/** Git executes with argument arrays and the user's existing credential helper. */
export class GitService {
  private busy = false;
  constructor(public readonly root: string) {}
  setBusy(busy: boolean): void { this.busy = busy; }

  async run(args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; input?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.root, windowsHide: true, shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let length = 0;
      const collect = (target: Buffer[]) => (data: Buffer) => {
        length += data.length;
        if (length > 32 * 1024 * 1024) { child.kill(); reject(new Error('Git output exceeded 32 MB; narrow the requested diff.')); return; }
        target.push(data);
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.once('error', reject);
      child.once('close', (code) => {
        const output = Buffer.concat(stdout).toString('utf8');
        if (code === 0 || options.allowFailure) resolve(output);
        else reject(new GitError(Buffer.concat(stderr).toString('utf8').trim() || `Git exited with status ${code}.`, code ?? -1, args));
      });
      child.stdin.end(options.input);
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Git changes are disabled while implementation is running.');
    const prior = mutations.get(this.root) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => {
      if (this.busy) throw new Error('Git changes are disabled while implementation is running.');
      return operation();
    });
    mutations.set(this.root, current);
    try { return await current; } finally { if (mutations.get(this.root) === current) mutations.delete(this.root); }
  }

  async head(): Promise<string> { return (await this.run(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).trim(); }
  async identity(): Promise<{ name: string; email: string }> {
    const [name, email] = await Promise.all([
      this.run(['config', 'user.name'], { allowFailure: true }), this.run(['config', 'user.email'], { allowFailure: true }),
    ]);
    if (!name.trim() || !email.trim()) throw new Error('Set your Git user.name and user.email before committing designs.');
    return { name: name.trim(), email: email.trim() };
  }

  async status(): Promise<GitStatus & { upstream?: string }> {
    const [raw, branch, head, upstream, remote] = await Promise.all([
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }), this.head(),
      this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true }),
      this.run(['remote', 'get-url', 'origin'], { allowFailure: true }),
    ]);
    const chunks = raw.split('\0'); const files: GitFile[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const entry = chunks[index]; if (!entry) continue;
      files.push({ path: entry.slice(3), index: entry[0], worktree: entry[1], conflicted: ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(entry.slice(0, 2)) });
      if ('RC'.includes(entry[0]) || 'RC'.includes(entry[1])) index++;
    }
    const upstreamName = upstream.trim() && !upstream.includes('@{upstream}') ? upstream.trim() : undefined;
    const counts = upstreamName && head ? (await this.run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number) : [0, 0];
    return { branch: branch.trim() || '(detached)', head, upstream: upstreamName, remote: remote.trim() || undefined,
      ahead: counts[0] || 0, behind: counts[1] || 0, files,
      conflicts: files.filter((change) => change.conflicted).map((change) => change.path),
    };
  }

  async assertNoConflicts(): Promise<void> {
    const conflicts = (await this.status()).conflicts;
    if (conflicts.length) throw new Error(`Resolve Git conflicts first: ${conflicts.join(', ')}`);
  }

  async diff(relative?: string, staged = false): Promise<string> {
    if (relative) await projectPath(this.root, relative);
    const head = await this.head();
    const args = ['diff', '--no-ext-diff', '--no-color', ...(staged || !head ? ['--cached'] : ['HEAD']), '--', ...(relative ? [relative] : [])];
    const diff = await this.run(args);
    if (diff || !relative || staged) return diff;
    const status = await this.status();
    if (status.files.some((change) => change.path === relative && change.index === '?')) {
      const file = await projectPath(this.root, relative);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return 'New binary or large file.';
      return `New file: ${relative}\n${await fs.readFile(file, 'utf8')}`;
    }
    return diff;
  }

  async commit(message: string, paths: string[]): Promise<string> {
    return this.mutate(async () => {
      if (!message.trim()) throw new Error('A commit message is required.');
      if (!paths.length) throw new Error('Select files to commit.');
      await this.assertNoConflicts(); await this.identity();
      if (await this.isMergeInProgress()) throw new Error('A merge is in progress. Finish the merge to commit all resolved and automatically merged files together.');
      const selected = [...new Set(paths)];
      for (const relative of selected) await projectPath(this.root, relative);
      const temporaryIndex = path.join(os.tmpdir(), `sde-index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: temporaryIndex };
      try {
        const head = await this.head();
        await this.run(head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });
        await this.run(['add', '--all', '--', ...selected], { env });
        const changed = await this.run(['diff', '--cached', '--name-only'], { env });
        if (!changed.trim()) throw new Error('Selected files have no changes to commit.');
        await this.run(['commit', '-m', message], { env });
        // Clear only selected paths from the real index; unrelated staging is preserved.
        await this.run(['reset', '--quiet', 'HEAD', '--', ...selected]);
        return this.head();
      } finally {
        await fs.unlink(temporaryIndex).catch(() => undefined);
        await fs.unlink(`${temporaryIndex}.lock`).catch(() => undefined);
      }
    });
  }

  async fetch(): Promise<void> { await this.mutate(async () => { await this.run(['fetch', '--prune', 'origin']); }); }
  async push(): Promise<void> {
    await this.mutate(async () => {
      const status = await this.status();
      if (status.branch === '(detached)') throw new Error('Select a branch before pushing.');
      if (!status.remote) throw new Error('Configure an origin remote before pushing.');
      await this.run(status.upstream ? ['push'] : ['push', '--set-upstream', 'origin', status.branch]);
    });
  }
  async pull(): Promise<void> {
    await this.mutate(async () => {
      await this.assertNoConflicts();
      if ((await this.status()).files.length) throw new Error('Commit your local changes before pulling.');
      try { await this.run(['pull', '--ff-only']); } catch (error) {
        const message = (error as Error).message;
        if (/fast-forward|diverg/i.test(message)) throw new Error('Branches have diverged. Fetch and use Merge to resolve the changes explicitly.');
        throw error;
      }
    });
  }
  async merge(ref = '@{upstream}'): Promise<void> {
    await this.mutate(async () => {
      await this.assertNoConflicts();
      if ((await this.status()).files.length) throw new Error('Commit your local changes before merging.');
      if (ref.startsWith('-') || /[\r\n\0]/.test(ref)) throw new Error('Invalid merge reference.');
      await this.run(['merge', '--no-edit', ref]);
    });
  }
  async abortMerge(): Promise<void> { await this.mutate(async () => { await this.run(['merge', '--abort']); }); }
  async finishMerge(message = 'Merge synchronized project changes'): Promise<string> {
    return this.mutate(async () => {
      await this.assertNoConflicts();
      const mergeHead = await this.run(['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true });
      if (!mergeHead.trim()) throw new Error('No merge is in progress.');
      await this.run(['commit', '-m', message]); return this.head();
    });
  }
  async isMergeInProgress(): Promise<boolean> {
    return Boolean((await this.run(['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true })).trim());
  }
  async conflict(relative: string): Promise<GitConflict> {
    const file = await projectPath(this.root, relative);
    if (!(await this.status()).conflicts.includes(relative)) throw new Error('This file has no unresolved conflict.');
    const stage = async (number: number): Promise<string> => {
      try { return await this.run(['show', `:${number}:${relative}`]); } catch { return ''; }
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    return { path: relative, base, ours, theirs };
  }
  async resolveConflict(relative: string, content: string | null): Promise<void> {
    await this.mutate(async () => {
      const file = await projectPath(this.root, relative);
      if (!(await this.status()).conflicts.includes(relative)) throw new Error('This file has no unresolved conflict.');
      if (content !== null && /^(<{7}|={7}|>{7})(?: |$)/m.test(content)) throw new Error('Remove conflict markers before resolving this file.');
      if (content === null) await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      else await atomicWrite(file, content);
      await this.run(['add', '--all', '--', relative]);
    });
  }
  async isAncestor(commit: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) return false;
    try { await this.run(['merge-base', '--is-ancestor', commit, 'HEAD']); return true; } catch { return false; }
  }
  async show(commit: string, relative: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('Expected a commit SHA.');
    await projectPath(this.root, relative);
    return this.run(['show', `${commit}:${relative.replace(/\\/g, '/')}`]);
  }
  async fileCommit(relative: string): Promise<string> {
    await projectPath(this.root, relative);
    return (await this.run(['log', '-1', '--format=%H', '--', relative])).trim();
  }
  async createBranch(name: string): Promise<void> {
    await this.mutate(async () => { await this.assertNoConflicts(); await this.run(['check-ref-format', '--branch', name]); await this.run(['switch', '-c', name]); });
  }
  async switchBranch(name: string): Promise<void> {
    await this.mutate(async () => {
      await this.assertNoConflicts();
      if ((await this.status()).files.length) throw new Error('Commit your local changes before switching branches.');
      await this.run(['check-ref-format', '--branch', name]); await this.run(['switch', name]);
    });
  }
  static async initialize(root: string): Promise<GitService> {
    await fs.mkdir(root, { recursive: true });
    const git = new GitService(root); await git.run(['init', '-b', 'main']); return git;
  }
  static async clone(url: string, root: string): Promise<GitService> {
    if (!/^(https:\/\/|ssh:\/\/|git@)/i.test(url) || /[\r\n\0]/.test(url)) throw new Error('Enter an HTTPS or SSH repository URL.');
    const parent = path.dirname(root); await fs.mkdir(parent, { recursive: true });
    const git = new GitService(parent); await git.run(['clone', '--', url, root]); return new GitService(root);
  }
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitService } from '../src/main/git';
import { acquireRunLock, type ReleaseRunLock } from '../src/main/run-lock';

let root: string;
const releases: ReleaseRunLock[] = [];
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overhull-run-lock-test-'));
  await GitService.initialize(root);
});
afterEach(async () => {
  for (const release of releases.splice(0)) await release();
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill();
      await exit;
    }
  }
  if (root && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('overhull-run-lock-test-'))
    await fs.rm(root, { recursive: true, force: true });
});

function metadata(pid: number, runId = 'previous-run') {
  return {
    schemaVersion: 1,
    pid,
    runId,
    token: randomUUID(),
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
}
async function lockFile(): Promise<string> {
  return path.resolve(
    root,
    (await new GitService(root).run(['rev-parse', '--git-path', 'overhull-run.lock'])).trim(),
  );
}
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  return pid;
}

describe('checkout run lock', () => {
  it('allows exactly one concurrent acquisition and supports idempotent release', async () => {
    const results = await Promise.allSettled([acquireRunLock(root, 'first'), acquireRunLock(root, 'second')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<ReleaseRunLock>;
    releases.push(winner.value);
    await Promise.all([winner.value(), winner.value()]);
    releases.push(await acquireRunLock(root, 'next'));
  });

  it('refuses a lock held by another live process', async () => {
    const file = await lockFile();
    const script = `const fs=require('node:fs');const os=require('node:os');const crypto=require('node:crypto');fs.writeFileSync(process.argv[1],JSON.stringify({schemaVersion:1,pid:process.pid,runId:'child-run',token:crypto.randomUUID(),hostname:os.hostname(),createdAt:new Date().toISOString()}),{flag:'wx'});process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script, file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code) reject(new Error(`Child failed: ${code}`));
      });
    });
    await expect(acquireRunLock(root, 'blocked')).rejects.toThrow('child-run');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).pid).toBe(child.pid);
  });

  it('reclaims a stale lock only when its recorded process no longer exists', async () => {
    const file = await lockFile();
    await fs.writeFile(file, JSON.stringify(metadata(await deadPid())));
    releases.push(await acquireRunLock(root, 'recovered'));
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(owner.pid).toBe(process.pid);
    expect(owner.runId).toBe('recovered');
  });

  it('does not remove a replacement owner when releasing an older lock', async () => {
    const release = await acquireRunLock(root, 'original');
    const file = await lockFile();
    const replacement = metadata(process.pid, 'replacement');
    await fs.writeFile(file, JSON.stringify(replacement));
    await release();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).token).toBe(replacement.token);
  });

  it('refuses malformed, foreign-host, and interrupted-recovery locks conservatively', async () => {
    const file = await lockFile();
    await fs.writeFile(file, '{incomplete');
    await expect(acquireRunLock(root, 'invalid')).rejects.toThrow('invalid metadata');
    await fs.writeFile(file, JSON.stringify({ ...metadata(await deadPid()), hostname: 'another-computer' }));
    await expect(acquireRunLock(root, 'foreign')).rejects.toThrow('owns this checkout');
    await fs.writeFile(file, JSON.stringify(metadata(await deadPid())));
    await fs.writeFile(`${file}.reclaim`, JSON.stringify(metadata(await deadPid(), 'interrupted-recovery')));
    await expect(acquireRunLock(root, 'recovery')).rejects.toThrow('recovery');
  });

  it('uses the actual Git metadata directory for a linked worktree', async () => {
    const git = new GitService(root);
    await git.run(['config', 'user.name', 'Test']);
    await git.run(['config', 'user.email', 'test@example.invalid']);
    await fs.writeFile(path.join(root, 'source.txt'), 'source');
    await git.commit('Initial', ['source.txt']);
    const worktree = path.join(root, 'linked');
    await git.run(['worktree', 'add', '-b', 'feature', worktree]);
    const release = await acquireRunLock(worktree, 'linked-run');
    releases.push(release);
    const actual = path.resolve(
      worktree,
      (await new GitService(worktree).run(['rev-parse', '--git-path', 'overhull-run.lock'])).trim(),
    );
    expect(JSON.parse(await fs.readFile(actual, 'utf8')).runId).toBe('linked-run');
    releases.push(await acquireRunLock(root, 'main-run'));
  });
});

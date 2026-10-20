import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdSchema } from '../shared/types';
import { GitService } from './git';

type LockOwner = {
  schemaVersion: 1;
  pid: number;
  runId: string;
  token: string;
  hostname: string;
  createdAt: string;
};
export type ReleaseRunLock = () => Promise<void>;

export class RunLockError extends Error {
  constructor(
    message: string,
    public readonly lockPath: string,
    public readonly owner?: LockOwner,
  ) {
    super(`${message}\nLock: ${lockPath}`);
    this.name = 'RunLockError';
  }
}

function isOwner(value: unknown): value is LockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<LockOwner>;
  return (
    owner.schemaVersion === 1 &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid! > 0 &&
    typeof owner.runId === 'string' &&
    typeof owner.token === 'string' &&
    owner.token.length >= 16 &&
    typeof owner.hostname === 'string' &&
    typeof owner.createdAt === 'string'
  );
}

function ownerMayBeAlive(owner: LockOwner): boolean {
  // A lock on a shared filesystem may belong to a different host; a local PID
  // probe cannot establish that remote process is dead.
  if (owner.hostname !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readOwner(file: string): Promise<LockOwner | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = undefined;
      }
      if (isOwner(value)) return value;
      // An exclusive creator may still be writing its small metadata record.
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        continue;
      }
      throw new RunLockError(
        'The run lock has incomplete or invalid metadata. Confirm no implementation is running before removing this lock manually.',
        file,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return null;
}

async function createExclusive(file: string, owner: LockOwner): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(file).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

async function releaseOwned(file: string, owner: LockOwner): Promise<void> {
  const current = await readOwner(file);
  if (!current || current.token !== owner.token || current.pid !== owner.pid || current.runId !== owner.runId)
    return;
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** One mutating implementation per Git checkout, including across app profiles. */
export async function acquireRunLock(root: string, runId: string): Promise<ReleaseRunLock> {
  IdSchema.parse(runId);
  const git = new GitService(root);
  const gitPath = (await git.run(['rev-parse', '--git-path', 'overhull-run.lock'])).trim();
  if (!gitPath) throw new Error('Cannot locate the checkout Git directory.');
  const lockPath = path.resolve(root, gitPath);
  const owner: LockOwner = {
    schemaVersion: 1,
    pid: process.pid,
    runId,
    token: randomUUID(),
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
  const makeRelease = (): ReleaseRunLock => {
    let release: Promise<void> | undefined;
    // Concurrent/repeated releases share one operation and cannot delete a new owner.
    return () => (release ??= releaseOwned(lockPath, owner));
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await createExclusive(lockPath, owner);
      return makeRelease();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readOwner(lockPath);
    if (!existing) continue;
    if (ownerMayBeAlive(existing))
      throw new RunLockError(
        `Another implementation run (${existing.runId}, PID ${existing.pid}) owns this checkout. Stop that run before starting another.`,
        lockPath,
        existing,
      );

    // A separate exclusive reclamation guard prevents two stale-lock claimants
    // from deleting a freshly acquired lock based on the same obsolete read.
    const reclaimPath = `${lockPath}.reclaim`;
    try {
      await createExclusive(reclaimPath, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new RunLockError(
        'Run-lock recovery is already in progress or was interrupted. Retry shortly; if the recovery lock persists, confirm no implementation is running before removing it manually.',
        reclaimPath,
      );
    }
    try {
      const current = await readOwner(lockPath);
      if (current && ownerMayBeAlive(current))
        throw new RunLockError(
          `Another implementation run (${current.runId}, PID ${current.pid}) owns this checkout.`,
          lockPath,
          current,
        );
      if (current) await fs.unlink(lockPath);
      try {
        await createExclusive(lockPath, owner);
        return makeRelease();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await releaseOwned(reclaimPath, owner);
    }
  }
  throw new RunLockError(
    'Another process acquired the run lock. Retry after its implementation finishes.',
    lockPath,
  );
}

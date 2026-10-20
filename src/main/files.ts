import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ZodTypeAny, output } from 'zod';

/** Deterministic JSON is both readable in Git and stable for content digests. */
export function canonicalJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([key, val]) => [key, ordered(val)]),
      );
    }
    return item;
  };
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Resolve a repository-relative path, refusing traversal and symlink escapes. */
export async function projectPath(root: string, relative: string, allowGit = false): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0'))
    throw new Error('Expected a repository-relative path.');
  const normalized = relative.replace(/\\/g, '/');
  const protectedGitPath = (value: string) =>
    value
      .replace(/\\/g, '/')
      .split('/')
      .some((part) => part.replace(/[. ]+$/, '').toLowerCase() === '.git');
  if (
    normalized.split('/').some((part) => part === '..') ||
    normalized.includes(':') ||
    (!allowGit && protectedGitPath(normalized))
  ) {
    throw new Error('Path is outside the permitted project files.');
  }
  const actualRoot = await fs.realpath(root);
  const target = path.resolve(actualRoot, normalized);
  const relativeTarget = path.relative(actualRoot, target);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget))
    throw new Error('Path escapes the project.');
  // Resolve every existing parent rather than merely comparing textual prefixes.
  let probe = target;
  while (!(await exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error('Cannot resolve project path.');
    probe = parent;
  }
  const realProbe = await fs.realpath(probe);
  const relativeProbe = path.relative(actualRoot, realProbe);
  if (relativeProbe.startsWith('..') || path.isAbsolute(relativeProbe))
    throw new Error('Symbolic link escapes the project.');
  if (!allowGit && protectedGitPath(relativeProbe))
    throw new Error('Path is outside the permitted project files.');
  return target;
}

const writes = new Map<string, Promise<void>>();

/** Serializes writes to one destination and atomically replaces it on success. */
export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const prior = writes.get(file) ?? Promise.resolve();
  const current = prior
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, file);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
  writes.set(file, current);
  try {
    await current;
  } finally {
    if (writes.get(file) === current) writes.delete(file);
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  return atomicWrite(file, canonicalJson(value));
}

export async function readJson<T extends ZodTypeAny>(file: string, schema: T): Promise<output<T>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path.basename(file)}: ${(error as Error).message}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid ${path.basename(file)}: ${result.error.message}`);
  return result.data;
}

export async function jsonFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

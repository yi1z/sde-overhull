import { createHash } from 'node:crypto';
import path from 'node:path';
import { CheckResultSchema, IdSchema, type CheckResult } from '../shared/types';
import { writeJson } from './files';

/** Full process output is machine-local and must never enter .sde run reports. */
export async function saveRunLog(
  directory: string,
  root: string,
  runId: string,
  results: CheckResult[],
): Promise<string> {
  const id = IdSchema.parse(runId);
  const projectKey = createHash('sha256').update(path.resolve(root)).digest('hex');
  const file = path.join(path.resolve(directory), 'run-logs', projectKey, `${id}.json`);
  await writeJson(file, {
    schemaVersion: 1,
    projectRoot: path.resolve(root),
    runId: id,
    savedAt: new Date().toISOString(),
    checks: results.map((result) => CheckResultSchema.parse(result)),
  });
  return file;
}

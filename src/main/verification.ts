import type { CheckResult, ServiceDefinition, VerificationCheck } from '../shared/types'
import { runCommand, ServiceSupervisor } from './services'

export interface VerificationOptions {
  root: string
  codeDigest: () => Promise<string>
  services?: ServiceSupervisor
  serviceDefinitions?: ServiceDefinition[]
  env?: Record<string, string>
  signal?: AbortSignal
  onOutput?: (checkId: string, output: string) => void
}

export interface VerificationReport {
  checks: CheckResult[]
  codeDigest: string
  unchanged: boolean
}

/** The caller must suspend agent writes for the duration of this function. */
export async function runVerification(checks: VerificationCheck[], options: VerificationOptions): Promise<VerificationReport> {
  const initialDigest = await options.codeDigest()
  const results: CheckResult[] = []
  const initiallyOwned = new Set(options.services?.ownedIds() ?? [])
  try {
    for (const check of checks) {
      const startedAt = new Date().toISOString()
      if (options.signal?.aborted) {
        results.push({ checkId: check.id, title: check.title, status: 'cancelled', exitCode: null, startedAt, finishedAt: new Date().toISOString(), output: 'Verification cancelled.', codeDigest: initialDigest })
        continue
      }
      try {
        if (!check.command?.executable.trim()) throw new Error('This required check has no executable command.')
        if (check.serviceIds.length) {
          if (!options.services) throw new Error('The check requires services, but no service supervisor is available.')
          await options.services.start(options.serviceDefinitions ?? [], options.env, check.serviceIds)
        }
        const result = await runCommand(check.command, { root: options.root, env: options.env, signal: options.signal, onOutput: (text) => options.onOutput?.(check.id, text) })
        const status = result.cancelled ? 'cancelled' : result.error && result.exitCode === null && !result.timedOut ? 'blocked' : result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed'
        results.push({ checkId: check.id, title: check.title, status, exitCode: result.exitCode, startedAt, finishedAt: new Date().toISOString(), output: [result.output, result.error].filter(Boolean).join('\n'), codeDigest: initialDigest })
      } catch (error) {
        results.push({ checkId: check.id, title: check.title, status: options.signal?.aborted ? 'cancelled' : 'blocked', exitCode: null, startedAt, finishedAt: new Date().toISOString(), output: error instanceof Error ? error.message : String(error), codeDigest: initialDigest })
      }
    }
  } finally {
    if (options.services) await options.services.stop(options.services.ownedIds().filter((id) => !initiallyOwned.has(id)))
  }
  const finalDigest = await options.codeDigest()
  const unchanged = initialDigest === finalDigest
  if (!unchanged) {
    for (const result of results) {
      if (result.status === 'passed') {
        result.status = 'failed'
        result.output += '\nSource or executable configuration changed during verification. Re-run the checks against the final code.'
      }
    }
  }
  return { checks: results, codeDigest: finalDigest, unchanged }
}

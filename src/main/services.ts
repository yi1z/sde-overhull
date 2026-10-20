import spawn from 'cross-spawn'
import { type ChildProcess } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createConnection } from 'node:net'
import type { Command, ServiceDefinition, ServiceStatus } from '../shared/types'

const OUTPUT_LIMIT = 1024 * 1024

export interface CommandResult {
  exitCode: number | null
  output: string
  cancelled: boolean
  timedOut: boolean
  error?: string
}

export async function commandDirectory(root: string, cwd = '.'): Promise<string> {
  if (isAbsolute(cwd)) throw new Error('Command working directories must be relative to the project.')
  const canonicalRoot = await realpath(root)
  const directory = await realpath(resolve(canonicalRoot, cwd))
  const difference = relative(canonicalRoot, directory)
  if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new Error('Command working directory escapes the project.')
  return directory
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Operation cancelled.'))
  return new Promise((resolvePause, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new Error('Operation cancelled.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolvePause()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Stop only a process created by this application, and its process group. */
export async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (process.platform === 'win32') {
    const closed = new Promise<void>((resolveStop) => child.once('close', () => resolveStop()))
    await new Promise<void>((resolveStop) => {
      const kill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      kill.once('error', () => { child.kill(); resolveStop() })
      kill.once('close', (code) => { if (code !== 0) child.kill(); resolveStop() })
    })
    await Promise.race([closed, pause(2000)])
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* Already exited. */ } }
  await Promise.race([new Promise<void>((resolveStop) => child.once('close', () => resolveStop())), pause(1200)])
  // A child can outlive its process-group leader. The original detached group
  // remains ours even after that leader exits, so clean it up as well.
  try { process.kill(-pid, 'SIGKILL') } catch { /* Group already gone. */ }
}

export async function runCommand(command: Command, options: {
  root: string
  env?: Record<string, string>
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}): Promise<CommandResult> {
  if (options.signal?.aborted) return { exitCode: null, output: 'Cancelled before execution.', cancelled: true, timedOut: false }
  let cwd: string
  try { cwd = await commandDirectory(options.root, command.cwd) } catch (error) {
    return { exitCode: null, output: '', cancelled: false, timedOut: false, error: error instanceof Error ? error.message : String(error) }
  }
  return new Promise<CommandResult>((resolveRun) => {
    let output = ''
    let cancelled = false
    let timedOut = false
    let settled = false
    let errorMessage: string | undefined
    const child = spawn(command.executable, command.args, { cwd, env: { ...process.env, ...options.env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (data: Buffer) => {
      const text = data.toString('utf8')
      output = (output + text).slice(-OUTPUT_LIMIT)
      options.onOutput?.(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolveRun({ exitCode, output, cancelled, timedOut, error: errorMessage })
    }
    const abort = () => { cancelled = true; void stopOwnedProcess(child).finally(() => finish(null)) }
    const timer = setTimeout(() => {
      timedOut = true
      errorMessage = `Command exceeded its ${command.timeoutMs} ms timeout.`
      void stopOwnedProcess(child).finally(() => finish(null))
    }, command.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => { errorMessage = error.message; finish(null) })
    child.once('close', (code) => finish(code))
    if (options.signal?.aborted) abort()
  })
}

export function serviceOrder(definitions: ServiceDefinition[], ids?: string[]): ServiceDefinition[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  if (byId.size !== definitions.length) throw new Error('Service IDs must be unique.')
  const active = new Set<string>()
  const visited = new Set<string>()
  const ordered: ServiceDefinition[] = []
  const visit = (id: string) => {
    const definition = byId.get(id)
    if (!definition) throw new Error(`Unknown service dependency: ${id}`)
    if (active.has(id)) throw new Error(`Service dependency cycle includes ${id}.`)
    if (visited.has(id)) return
    active.add(id)
    for (const dependency of definition.dependsOn) visit(dependency)
    active.delete(id)
    visited.add(id)
    ordered.push(definition)
  }
  for (const id of ids ?? definitions.map((definition) => definition.id)) visit(id)
  return ordered
}

export async function tcpAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const connection = createConnection({ host, port })
    const finish = (ready: boolean) => { connection.removeAllListeners(); connection.destroy(); resolveCheck(ready) }
    connection.setTimeout(350)
    connection.once('connect', () => finish(true))
    connection.once('error', () => finish(false))
    connection.once('timeout', () => finish(false))
  })
}

async function readinessMatches(definition: ServiceDefinition, signal?: AbortSignal): Promise<boolean> {
  const readiness = definition.readiness
  if (!readiness || readiness.type === 'delay') return true
  if (readiness.type === 'tcp') {
    if (!readiness.port || readiness.port > 65535) throw new Error(`Service ${definition.name} needs a valid readiness port.`)
    return tcpAvailable(readiness.port)
  }
  const url = readiness.url ?? definition.url
  if (!url) throw new Error(`Service ${definition.name} needs a readiness URL.`)
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Readiness URLs must use HTTP or HTTPS.')
  try {
    const response = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(1200), ...(signal ? [signal] : [])]), redirect: 'error' })
    await response.body?.cancel()
    return response.ok
  } catch { return false }
}

export class ServiceSupervisor {
  private readonly states = new Map<string, ServiceStatus>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly startSequence: string[] = []
  private starting?: AbortController
  private busy = false

  constructor(private readonly root: string, private readonly onLog: (serviceId: string, text: string) => void = () => {}, private readonly onStatus: (statuses: ServiceStatus[]) => void = () => {}) {}

  status(): ServiceStatus[] { return [...this.states.values()].map((status) => ({ ...status })) }
  ownedIds(): string[] { return [...this.children.keys()] }

  private setState(status: ServiceStatus): void {
    this.states.set(status.id, status)
    this.onStatus(this.status())
  }

  async start(definitions: ServiceDefinition[], env: Record<string, string> = {}, ids?: string[]): Promise<ServiceStatus[]> {
    if (this.busy) throw new Error('Services are already starting. Wait or stop them first.')
    const ordered = serviceOrder(definitions, ids)
    this.busy = true
    const controller = new AbortController()
    this.starting = controller
    const newlyOwned: string[] = []
    try {
      for (const definition of ordered) {
        if (controller.signal.aborted) throw new Error('Service startup cancelled.')
        if (this.states.get(definition.id)?.state === 'ready' && this.children.has(definition.id)) continue
        for (const key of definition.env) {
          if (!(env[key] ?? process.env[key])) throw new Error(`Service ${definition.name} requires environment variable ${key}. Configure it in local service settings.`)
        }
        if (definition.external) {
          const ready = definition.readiness && definition.readiness.type !== 'delay' && await readinessMatches(definition, controller.signal)
          this.setState({ id: definition.id, name: definition.name, state: ready ? 'ready' : 'external', message: ready ? 'External dependency is available.' : 'Start this external dependency yourself, then retry.' })
          if (!ready) throw new Error(`External dependency ${definition.name} is not ready.`)
          continue
        }
        const command = definition.platforms?.[process.platform] ?? definition.command
        const cwd = await commandDirectory(this.root, command.cwd)
        let port = definition.readiness?.type === 'tcp' ? definition.readiness.port : undefined
        const healthUrl = definition.readiness?.type === 'http' ? definition.readiness.url ?? definition.url : definition.url
        if (healthUrl) {
          const parsed = new URL(healthUrl)
          if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
        }
        if (port && await tcpAvailable(port)) throw new Error(`Port ${port} for ${definition.name} is already in use. Stop the other process or change the service configuration.`)
        this.setState({ id: definition.id, name: definition.name, state: 'starting' })
        const child = spawn(command.executable, command.args, { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        this.children.set(definition.id, child)
        this.startSequence.push(definition.id)
        newlyOwned.push(definition.id)
        child.stdout?.on('data', (data: Buffer) => this.onLog(definition.id, data.toString('utf8')))
        child.stderr?.on('data', (data: Buffer) => this.onLog(definition.id, data.toString('utf8')))
        child.once('error', (error) => this.setState({ id: definition.id, name: definition.name, state: 'failed', message: error.message }))
        child.once('exit', (code, signal) => {
          if (this.children.get(definition.id) !== child) return
          this.children.delete(definition.id)
          this.setState({ id: definition.id, name: definition.name, state: 'failed', message: `Service exited (${signal ?? code ?? 'unknown'}).` })
        })
        const deadline = Date.now() + (definition.readiness?.timeoutMs ?? 30_000)
        if (!definition.readiness || definition.readiness.type === 'delay') {
          await pause(definition.readiness?.timeoutMs ?? 350, controller.signal)
        } else {
          while (!await readinessMatches(definition, controller.signal)) {
            const state = this.states.get(definition.id)
            if (state?.state === 'failed') throw new Error(`${definition.name}: ${state.message}`)
            if (Date.now() >= deadline) throw new Error(`${definition.name} did not become ready within ${definition.readiness.timeoutMs} ms.`)
            await pause(150, controller.signal)
          }
        }
        const state = this.states.get(definition.id)
        if (state?.state === 'failed' || child.exitCode !== null || child.signalCode !== null) throw new Error(`${definition.name}: ${state?.message ?? 'process exited during startup'}`)
        this.setState({ id: definition.id, name: definition.name, state: 'ready', pid: child.pid })
      }
      return this.status()
    } catch (error) {
      const failed = ordered.find((definition) => this.states.get(definition.id)?.state === 'starting')
      await this.stop(newlyOwned)
      const detail = error instanceof Error ? error.message : String(error)
      if (failed) this.setState({ id: failed.id, name: failed.name, state: 'failed', message: detail })
      throw error
    } finally {
      if (this.starting === controller) this.starting = undefined
      this.busy = false
    }
  }

  async stop(ids?: string[]): Promise<ServiceStatus[]> {
    if (!ids) this.starting?.abort()
    const selected = ids ? new Set(ids) : undefined
    for (const id of [...this.startSequence].reverse()) {
      if (selected && !selected.has(id)) continue
      const child = this.children.get(id)
      const previous = this.states.get(id)
      this.children.delete(id)
      if (child) await stopOwnedProcess(child)
      if (previous && previous.state !== 'failed') this.setState({ id, name: previous.name, state: 'stopped' })
      const index = this.startSequence.indexOf(id)
      if (index >= 0) this.startSequence.splice(index, 1)
    }
    return this.status()
  }

  async restart(definitions: ServiceDefinition[], env: Record<string, string> = {}): Promise<ServiceStatus[]> {
    await this.stop()
    if (this.busy) throw new Error('Wait for the cancelled startup to finish before restarting.')
    return this.start(definitions, env)
  }
}

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { CommandSchema, ServiceSchema, CheckSchema } from '../src/shared/types'
import { commandDirectory, runCommand, serviceOrder, ServiceSupervisor, tcpAvailable } from '../src/main/services'
import { runVerification } from '../src/main/verification'
import { McpGateway } from '../src/main/mcp'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'overhull-runtime-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function service(id: string, port: number, dependsOn: string[] = []) {
  return ServiceSchema.parse({
    id, name: id, dependsOn,
    command: { executable: process.execPath, args: ['-e', `require('http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1')`] },
    readiness: { type: 'http', url: `http://127.0.0.1:${port}`, timeoutMs: 8000 }
  })
}

describe('owned local processes', () => {
  it('executes arguments literally, reports failures, and rejects cwd escapes', async () => {
    const root = await workspace()
    const command = CommandSchema.parse({ executable: process.execPath, args: ['-e', 'console.log(process.argv[1]); process.exit(3)', 'a & b $(secret)'] })
    const result = await runCommand(command, { root })
    expect(result.exitCode).toBe(3)
    expect(result.output).toContain('a & b $(secret)')
    await expect(commandDirectory(root, '..')).rejects.toThrow('escapes')
  })

  it('cancels and times out running commands', async () => {
    const root = await workspace()
    const command = CommandSchema.parse({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 150 })
    const timed = await runCommand(command, { root })
    expect(timed.timedOut).toBe(true)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const cancelled = await runCommand({ ...command, timeoutMs: 10000 }, { root, signal: controller.signal })
    expect(cancelled.cancelled).toBe(true)
  })

  it('validates service graphs and starts dependencies before consumers', async () => {
    const root = await workspace()
    const backend = service('backend', await freePort())
    const frontend = service('frontend', await freePort(), ['backend'])
    expect(serviceOrder([frontend, backend]).map((item) => item.id)).toEqual(['backend', 'frontend'])
    expect(() => serviceOrder([{ ...backend, dependsOn: ['frontend'] }, frontend])).toThrow('cycle')
    const ready: string[] = []
    const supervisor = new ServiceSupervisor(root, () => {}, (states) => { for (const state of states) if (state.state === 'ready' && !ready.includes(state.id)) ready.push(state.id) })
    cleanups.push(() => supervisor.stop())
    await supervisor.start([frontend, backend])
    expect(ready).toEqual(['backend', 'frontend'])
    expect(supervisor.ownedIds()).toHaveLength(2)
    await supervisor.start([frontend, backend])
    expect(supervisor.ownedIds()).toHaveLength(2)
    await supervisor.stop()
    expect(await tcpAvailable(Number(new URL(backend.readiness!.url!).port))).toBe(false)
    expect(await tcpAvailable(Number(new URL(frontend.readiness!.url!).port))).toBe(false)
  }, 20000)

  it('never kills a process occupying a requested service port', async () => {
    const root = await workspace()
    const external = createServer((socket) => socket.end())
    await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => external.close(() => resolve())))
    const port = (external.address() as { port: number }).port
    const supervisor = new ServiceSupervisor(root)
    cleanups.push(() => supervisor.stop())
    await expect(supervisor.start([service('collision', port)])).rejects.toThrow('already in use')
    await supervisor.stop()
    expect(await tcpAvailable(port)).toBe(true)
  })

  it('reports unavailable external prerequisites and missing environment', async () => {
    const root = await workspace()
    const supervisor = new ServiceSupervisor(root)
    cleanups.push(() => supervisor.stop())
    await expect(supervisor.start([ServiceSchema.parse({ id: 'docker', name: 'Docker database', external: true, command: { executable: 'docker' } })])).rejects.toThrow('not ready')
    await expect(supervisor.start([{ ...service('db', await freePort()), env: ['OVERHULL_TEST_ENV_THAT_DOES_NOT_EXIST'] }])).rejects.toThrow('requires environment')
  })
})

describe('verification evidence', () => {
  it('records actual results and invalidates successful checks if source changes', async () => {
    const root = await workspace()
    const check = CheckSchema.parse({ id: 'test', title: 'Tests', kind: 'test', command: { executable: process.execPath, args: ['-e', 'console.log("passed")'] } })
    let digests = 0
    const report = await runVerification([check], { root, codeDigest: async () => ++digests === 1 ? 'before' : 'after' })
    expect(report.unchanged).toBe(false)
    expect(report.checks[0].status).toBe('failed')
    expect(report.checks[0].output).toContain('changed during verification')
  })

  it('treats missing commands and cancellation as blocked/cancelled, never passing', async () => {
    const root = await workspace()
    const check = CheckSchema.parse({ id: 'missing', title: 'Missing tool', kind: 'test', command: { executable: 'overhull-definitely-missing-executable' } })
    const report = await runVerification([check], { root, codeDigest: async () => 'same' })
    expect(report.checks[0].status).toBe('blocked')
    const signal = AbortSignal.abort()
    const cancelled = await runVerification([check], { root, codeDigest: async () => 'same', signal })
    expect(cancelled.checks[0].status).toBe('cancelled')
  })

  it('stops temporary smoke services but preserves previously running owned services', async () => {
    const root = await workspace()
    const existing = service('existing', await freePort())
    const temporary = service('temporary', await freePort())
    const supervisor = new ServiceSupervisor(root)
    cleanups.push(() => supervisor.stop())
    await supervisor.start([existing])
    const check = CheckSchema.parse({ id: 'smoke', title: 'Smoke', kind: 'smoke', serviceIds: ['temporary'], command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } })
    const report = await runVerification([check], { root, codeDigest: async () => 'same', services: supervisor, serviceDefinitions: [existing, temporary] })
    expect(report.checks[0].status).toBe('passed')
    expect(supervisor.ownedIds()).toEqual(['existing'])
  }, 20000)
})

describe('local MCP gateway', () => {
  it('requires local bearer authentication and exposes only registered tools', async () => {
    const calls: string[] = []
    const gateway = new McpGateway([{ name: 'read_context', description: 'Read context', inputSchema: { type: 'object', properties: {} }, readOnly: true }], async (name) => { calls.push(name); return { revision: 4 } })
    const endpoint = await gateway.start()
    cleanups.push(() => gateway.close())
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_context', arguments: {} } })
    expect((await fetch(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401)
    const headers = { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }
    expect((await fetch(endpoint.url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body })).status).toBe(403)
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(endpoint.url, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode) })
      outgoing.once('error', reject)
      outgoing.end(body)
    })
    expect(wrongHost).toBe(403)
    const response = await fetch(endpoint.url, { method: 'POST', headers, body })
    expect(await response.json()).toMatchObject({ result: { content: [{ type: 'text', text: '{"revision":4}' }], isError: false } })
    expect(calls).toEqual(['read_context'])
    const unknown = await fetch(endpoint.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shell' } }) })
    expect(await unknown.json()).toMatchObject({ error: { code: -32602 } })
  })

  it('negotiates the protocol and reports tool domain errors without crashing', async () => {
    const gateway = new McpGateway([{ name: 'update', description: 'Update draft', inputSchema: { type: 'object' } }], async () => { throw new Error('Revision is stale.') })
    const endpoint = await gateway.start()
    cleanups.push(() => gateway.close())
    const call = async (method: string, params: unknown = {}) => (await fetch(endpoint.url, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
    expect(await call('initialize', { protocolVersion: '2025-03-26' })).toMatchObject({ result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } })
    expect(await call('tools/call', { name: 'update' })).toMatchObject({ result: { isError: true, content: [{ text: 'Revision is stale.' }] } })
  })
})

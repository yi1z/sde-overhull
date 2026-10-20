import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAdapter } from '../src/main/codex'
import type { AgentEvent } from '../src/shared/types'
import { McpGateway } from '../src/main/mcp'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'overhull-codex-'))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'server.cjs')
  const trace = join(root, 'trace.jsonl')
  await writeFile(path, `
const fs=require('fs');const readline=require('readline');
const output=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let initialized=false;let currentTurn='';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(${JSON.stringify(trace)},line+'\\n');
 if(m.method==='initialize')return output({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized)return output({id:m.id,error:{message:'Not initialized'}});
 if(m.method==='account/read')return output({id:m.id,result:{account:{type:'chatgpt',email:'test@example.invalid'},requiresOpenaiAuth:true}});
 if(m.method==='model/list')return output({id:m.id,result:{data:[{model:'test-model',displayName:'Test model'}]}});
 if(m.method==='thread/start'||m.method==='thread/resume')return output({id:m.id,result:{thread:{id:'thread-1'}}});
 if(m.method==='turn/start'){
  currentTurn='turn-1';output({method:'turn/started',params:{threadId:'thread-1',turn:{id:currentTurn}}});
  output({id:m.id,result:{turn:{id:currentTurn}}});
  output({method:'item/agentMessage/delta',params:{threadId:'thread-1',itemId:'answer-1',delta:'Hello '}});
  output({id:91,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:currentTurn,command:'node --version'}});return;
 }
 if(m.id===91&&m.result){
  output({method:'item/completed',params:{threadId:'thread-1',item:{id:'answer-1',type:'agentMessage',text:'Hello world'}}});
  return output({method:'turn/completed',params:{threadId:'thread-1',turn:{id:currentTurn,status:'completed'}}});
 }
 if(m.method==='turn/interrupt'){
  output({id:m.id,result:{}});return output({method:'turn/completed',params:{threadId:'thread-1',turn:{id:currentTurn,status:'interrupted'}}});
 }
 if(m.id!==undefined)output({id:m.id,result:{}});
});
`)
  const events: AgentEvent[] = []
  const adapter = new CodexAdapter({ executable: process.execPath, executableArgs: [path], cwd: root, onEvent: (event) => events.push(event), requestTimeoutMs: 3000 })
  cleanup.push(() => adapter.dispose())
  return { adapter, root, events, trace }
}

async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected Codex event was not received.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Codex app-server integration', () => {
  it('initializes, reads authentication/catalog, streams a turn and handles approval', async () => {
    const { adapter, root, events } = await fixture()
    expect(await adapter.diagnostics()).toMatchObject({ available: true, authenticated: true, models: [{ id: 'test-model' }] })
    expect(await adapter.startThread({ cwd: root, phase: 'design' })).toBe('thread-1')
    await adapter.send('Design a tool')
    await until(() => events.some((event) => event.type === 'approval'))
    expect(events.find((event) => event.type === 'message-delta')?.text).toBe('Hello ')
    expect(adapter.active).toBe(true)
    adapter.respond(91, { decision: 'accept' })
    await until(() => events.some((event) => event.type === 'turn-complete'))
    expect(events.find((event) => event.type === 'message-complete')?.text).toBe('Hello world')
    expect(events.find((event) => event.type === 'turn-complete')?.data).toMatchObject({ status: 'completed' })
    expect(adapter.active).toBe(false)
    expect(() => adapter.respond(91, {})).toThrow('no longer pending')
  })

  it('uses exact sandbox values, blocks overlapping turns, and resumes read-only for final review', async () => {
    const { adapter, root, trace, events } = await fixture()
    await adapter.startThread({ cwd: root, phase: 'implement', model: 'test-model' })
    await adapter.send('Implement')
    await expect(adapter.send('Second writer')).rejects.toThrow('already working')
    await adapter.interrupt()
    await until(() => events.some((event) => event.type === 'turn-complete'))
    await adapter.startThread({ cwd: root, phase: 'evaluate', threadId: 'thread-1' })
    const messages = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(messages.find((message) => message.method === 'thread/start').params.sandbox).toBe('workspace-write')
    expect(messages.find((message) => message.method === 'thread/resume').params).toMatchObject({ sandbox: 'read-only', excludeTurns: true, approvalsReviewer: 'user' })
  })

  it('reports unavailable executables as actionable diagnostics', async () => {
    const adapter = new CodexAdapter({ executable: 'overhull-codex-command-not-installed', requestTimeoutMs: 1000 })
    cleanup.push(() => adapter.dispose())
    expect(await adapter.diagnostics()).toMatchObject({ available: false, models: [] })
  })

  it.skipIf(process.env.SDE_LIVE_CODEX !== '1')('connects a real installed Codex agent to the authenticated project tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'overhull-live-codex-'))
    cleanup.push(() => rm(root, { force: true, recursive: true }))
    let called = false
    const gateway = new McpGateway([{ name: 'read_context', description: 'Read the current Overhull project context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true }], async () => { called = true; return { project: 'Overhull integration check', marker: 'overhull-connected' } })
    const endpoint = await gateway.start()
    cleanup.push(() => gateway.close())
    const events: AgentEvent[] = []
    const adapter = new CodexAdapter({ executable: process.env.SDE_CODEX_PATH || 'codex', cwd: root, mcp: endpoint, onEvent: (event) => events.push(event) })
    cleanup.push(() => adapter.dispose())
    const diagnostics = await adapter.diagnostics()
    expect(diagnostics.available, diagnostics.error).toBe(true)
    expect(diagnostics.authenticated, diagnostics.error).toBe(true)
    await adapter.startThread({ cwd: root, phase: 'design', instructions: 'Use the Overhull MCP read_context tool exactly once. Do not use shell commands, modify files, or call other tools. After reading context, reply with its marker.' })
    await adapter.send('Read the Overhull project context and reply with its marker.')
    await until(() => events.some((event) => event.type === 'turn-complete' || event.type === 'error'), 120000)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(called).toBe(true)
    expect(events.some((event) => event.type === 'message-complete' && event.text?.includes('overhull-connected'))).toBe(true)
    expect(events.find((event) => event.type === 'turn-complete')?.data).toMatchObject({ status: 'completed' })
  }, 180000)
})

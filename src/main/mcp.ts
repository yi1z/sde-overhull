import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
}

export type GatewayDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * A deliberately stateless Streamable HTTP MCP server. The gateway never exposes
 * shell or filesystem primitives: each listed tool is implemented by the app's
 * domain facade. Authentication and loopback checks apply to every request.
 */
export class McpGateway {
  private server?: Server;
  private authorization = '';
  private authority = '';
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly tools: GatewayTool[],
    private readonly dispatch: GatewayDispatch,
  ) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.server) throw new Error('The project tool gateway is already running.');
    const token = randomBytes(32).toString('hex');
    this.authorization = `Bearer ${token}`;
    this.closed = false;
    this.server = createServer((request, response) => {
      const pending = this.handle(request, response).catch(() => {
        if (!response.headersSent) this.json(response, 500, { error: 'Tool gateway failed.' });
        else response.end();
      });
      this.inflight.add(pending);
      void pending.finally(() => this.inflight.delete(pending));
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Cannot bind the project tool gateway.');
    this.authority = `127.0.0.1:${address.port}`;
    return { url: `http://${this.authority}/mcp`, token };
  }

  async close(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    // A disconnected HTTP client does not cancel an already-dispatched domain
    // mutation. Drain it before the facade is allowed to switch repositories.
    await Promise.allSettled([...this.inflight]);
    this.authorization = '';
  }

  private authorized(request: IncomingMessage): boolean {
    const incoming = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(this.authorization);
    return incoming.length === expected.length && expected.length > 0 && timingSafeEqual(incoming, expected);
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed) return this.json(response, 503, { error: 'Gateway closed.' });
    if (
      request.headers.host !== this.authority ||
      request.headers.origin ||
      request.socket.remoteAddress !== '127.0.0.1'
    ) {
      return this.json(response, 403, { error: 'Only the local agent may access project tools.' });
    }
    if (!this.authorized(request)) return this.json(response, 401, { error: 'Authentication required.' });
    if (request.url !== '/mcp') return this.json(response, 404, { error: 'Not found.' });
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return this.json(response, 405, { error: 'Use POST for this stateless MCP endpoint.' });
    }
    if (!request.headers['content-type']?.startsWith('application/json'))
      return this.json(response, 415, { error: 'Expected application/json.' });

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        this.json(response, 413, { error: 'Tool request exceeds 4 MiB.' });
        request.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let message: {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.json(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON.' },
      });
    }
    if (
      !message ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    ) {
      return this.json(response, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid JSON-RPC request.' },
      });
    }
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const reply = (result: unknown) => this.json(response, 200, { jsonrpc: '2.0', id: message.id, result });
    const fail = (code: number, detail: string) =>
      this.json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: detail } });
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested)
          ? requested
          : '2025-03-26';
      return reply({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'sde-overhull', version: '0.1.0' },
        instructions:
          'Use these tools to maintain the shared design and evaluation workspace. Read context before editing. Every artifact change must use its current revision. Human approval and Git synchronization are performed only by the desktop UI.',
      });
    }
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') {
      return reply({
        tools: this.tools.map(({ readOnly, ...tool }) => ({
          ...tool,
          annotations: { readOnlyHint: readOnly ?? false, destructiveHint: false, openWorldHint: false },
        })),
      });
    }
    if (message.method !== 'tools/call') return fail(-32601, `Unsupported method: ${message.method}`);
    const name = message.params?.name;
    if (typeof name !== 'string' || !this.tools.some((tool) => tool.name === name))
      return fail(-32602, 'Unknown project tool.');
    const args = message.params?.arguments ?? {};
    if (args === null || typeof args !== 'object' || Array.isArray(args))
      return fail(-32602, 'Tool arguments must be an object.');
    try {
      const result = await this.dispatch(name, args as Record<string, unknown>);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }],
        isError: false,
      });
    } catch (error) {
      return reply({
        content: [
          { type: 'text', text: error instanceof Error ? error.message : 'The project tool failed.' },
        ],
        isError: true,
      });
    }
  }
}

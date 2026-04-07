/**
 * MCP Server — JSON-RPC 2.0 over stdio
 *
 * Implements the Model Context Protocol (MCP) so that LLM agents
 * (Claude Code, Cursor, etc.) can use sentinel-bridge tools natively
 * without HTTP workarounds.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * Spec: https://modelcontextprotocol.io
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const process: {
  stdin: { on(event: string, cb: (...args: any[]) => void): void; setEncoding(enc: string): void };
  stdout: { write(data: string): boolean };
  stderr: { write(data: string): boolean };
  exit(code?: number): void;
  on(event: string, cb: (...args: any[]) => void): void;
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolHandler {
  (params: Record<string, unknown>): Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {
  private readonly tools = new Map<string, { definition: McpTool; handler: McpToolHandler }>();
  private readonly serverInfo: { name: string; version: string };

  constructor(serverInfo: { name: string; version: string }) {
    this.serverInfo = serverInfo;
  }

  registerTool(definition: McpTool, handler: McpToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  /**
   * Start listening on stdin and writing responses to stdout.
   * This blocks until stdin closes.
   */
  start(): void {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          void this.handleLine(line);
        }
      }
    });

    process.stdin.on('end', () => {
      process.exit(0);
    });

    process.stderr.write(`[sentinel-bridge MCP] Server ready with ${this.tools.size} tools\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    // Notifications (no id) don't get responses
    if (request.id === undefined) {
      return;
    }

    try {
      const result = await this.dispatch(request);
      this.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32603, message },
      });
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize();
      case 'tools/list':
        return this.handleToolsList();
      case 'tools/call':
        return this.handleToolsCall(request.params ?? {});
      case 'ping':
        return {};
      default:
        throw Object.assign(
          new Error(`Method not found: ${request.method}`),
          { code: -32601 },
        );
    }
  }

  private handleInitialize(): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: this.serverInfo,
    };
  }

  private handleToolsList(): unknown {
    const tools = Array.from(this.tools.values()).map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }));
    return { tools };
  }

  private async handleToolsCall(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    try {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      const result = await tool.handler(args);
      return {
        content: [
          { type: 'text', text: JSON.stringify(result) },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  }

  private send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

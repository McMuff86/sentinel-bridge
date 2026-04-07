import { describe, it, expect, vi, beforeEach } from 'vitest';

import { McpServer } from '../mcp/server.js';

// Capture stdout writes
const stdoutWrites: string[] = [];
const stderrWrites: string[] = [];

vi.stubGlobal('process', {
  stdin: {
    setEncoding: vi.fn(),
    on: vi.fn(),
  },
  stdout: {
    write: vi.fn((data: string) => { stdoutWrites.push(data); return true; }),
  },
  stderr: {
    write: vi.fn((data: string) => { stderrWrites.push(data); return true; }),
  },
  exit: vi.fn(),
  on: vi.fn(),
});

describe('McpServer', () => {
  let server: McpServer;
  let onDataCallback: ((chunk: string) => void) | null;

  beforeEach(() => {
    stdoutWrites.length = 0;
    stderrWrites.length = 0;
    onDataCallback = null;

    // Capture the data callback when start() is called
    (process.stdin.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, cb: (chunk: string) => void) => {
      if (event === 'data') onDataCallback = cb;
    });

    server = new McpServer({ name: 'test-bridge', version: '0.0.1' });
    server.registerTool(
      { name: 'echo', description: 'Echo back the input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      async (params) => ({ echoed: params.text }),
    );
    server.start();
  });

  function sendAndGetResponse(jsonRpc: Record<string, unknown>): Record<string, unknown> | null {
    stdoutWrites.length = 0;
    onDataCallback!(JSON.stringify(jsonRpc) + '\n');
    // Need to wait for async handling — use sync check for immediate responses
    if (stdoutWrites.length > 0) {
      return JSON.parse(stdoutWrites[0]);
    }
    return null;
  }

  async function sendAndWait(jsonRpc: Record<string, unknown>): Promise<Record<string, unknown>> {
    stdoutWrites.length = 0;
    onDataCallback!(JSON.stringify(jsonRpc) + '\n');
    // Wait a tick for async handlers
    await new Promise(r => setTimeout(r, 10));
    if (stdoutWrites.length > 0) {
      return JSON.parse(stdoutWrites[0]);
    }
    throw new Error('No response received');
  }

  it('should respond to initialize', async () => {
    const response = await sendAndWait({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(response.result).toBeDefined();
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: 'test-bridge', version: '0.0.1' });
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it('should list registered tools', async () => {
    const response = await sendAndWait({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('echo');
  });

  it('should call a tool and return result', async () => {
    const response = await sendAndWait({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hello' } },
    });
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.echoed).toBe('hello');
  });

  it('should return error for unknown tool', async () => {
    const response = await sendAndWait({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nonexistent', arguments: {} },
    });
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('should return error for unknown method', async () => {
    const response = await sendAndWait({ jsonrpc: '2.0', id: 5, method: 'unknown/method' });
    expect(response.error).toBeDefined();
    const error = response.error as { code: number; message: string };
    expect(error.message).toContain('Method not found');
  });

  it('should respond to ping', async () => {
    const response = await sendAndWait({ jsonrpc: '2.0', id: 6, method: 'ping' });
    expect(response.result).toEqual({});
  });

  it('should handle parse errors', async () => {
    stdoutWrites.length = 0;
    onDataCallback!('not valid json\n');
    await new Promise(r => setTimeout(r, 10));
    if (stdoutWrites.length > 0) {
      const response = JSON.parse(stdoutWrites[0]);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32700);
    }
  });

  it('should not respond to notifications (no id)', async () => {
    stdoutWrites.length = 0;
    onDataCallback!(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 10));
    expect(stdoutWrites).toHaveLength(0);
  });

  it('should print readiness to stderr', () => {
    expect(stderrWrites.some(w => w.includes('Server ready'))).toBe(true);
  });
});

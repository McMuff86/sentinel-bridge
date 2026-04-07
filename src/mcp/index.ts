#!/usr/bin/env node
/**
 * sentinel-bridge MCP Server
 *
 * Exposes all 33 sb_* tools via the Model Context Protocol (stdio).
 * Run with: node dist/mcp/index.js
 *
 * Configure in Claude Code:
 *   claude mcp add sentinel-bridge -- node /path/to/sentinel-bridge/dist/mcp/index.js
 *
 * Or in .claude/settings.json / .mcp.json:
 *   { "mcpServers": { "sentinel-bridge": { "command": "node", "args": ["/path/to/dist/mcp/index.js"] } } }
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const process: {
  on(event: string, cb: (...args: any[]) => void): void;
  exit(code?: number): void;
};

import { SessionManager } from '../session-manager.js';
import { McpServer } from './server.js';
import { buildMcpTools } from './tools.js';

const manager = new SessionManager({
  defaultFallbackChain: ['claude', 'codex', 'grok', 'ollama'],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 60_000 },
});

const server = new McpServer({
  name: 'sentinel-bridge',
  version: '0.2.0',
});

for (const { definition, handler } of buildMcpTools(manager)) {
  server.registerTool(definition, handler);
}

server.start();

process.on('SIGINT', async () => {
  await manager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await manager.shutdown();
  process.exit(0);
});

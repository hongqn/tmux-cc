#!/usr/bin/env node
/**
 * MCP Tools Server for the tmux-cc provider plugin.
 *
 * Dynamically discovers all available gateway tools from the installed
 * OpenClaw package at startup, then delegates execute() calls to the
 * native tool handlers. No hardcoded tool definitions.
 *
 * Since OpenClaw's runtime modules require CJS `require()`, tool discovery
 * and execution are performed via a CJS Node.js subprocess. Tool definitions
 * (name, description, schema) are loaded once at startup; each tool call
 * spawns a short-lived subprocess for execution.
 *
 * This script is started by Claude Code as an MCP server subprocess.
 * It connects via stdio transport (JSON-RPC).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";

/**
 * Inline CJS script that finds the openclaw install directory and loads
 * createOpenClawTools(). Shared between discovery and execution.
 */
const FIND_OPENCLAW_SNIPPET = `
const { readdirSync, realpathSync } = require('fs');
const { join, dirname } = require('path');
const { execSync: _x } = require('child_process');
function findOpenClawTools() {
  const dirs = ['/usr/lib/node_modules/openclaw', '/usr/local/lib/node_modules/openclaw'];
  try {
    const bin = _x('which openclaw', { encoding: 'utf-8' }).trim();
    const d = dirname(realpathSync(bin));
    if (!dirs.includes(d)) dirs.unshift(d);
  } catch {}
  for (const dir of dirs) {
    try {
      const distDir = join(dir, 'dist');
      const rf = readdirSync(distDir).find(f => f.startsWith('openclaw-tools.runtime-') && f.endsWith('.js'));
      if (!rf) continue;
      const mod = require(join(distDir, rf));
      if (typeof mod.createOpenClawTools === 'function') return mod.createOpenClawTools({});
    } catch {}
  }
  return null;
}
`;

interface ToolDefinition {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Discover tool definitions (name, description, schema) from the installed
 * openclaw package. Runs a CJS subprocess to avoid ESM/CJS conflicts.
 */
function discoverTools(): ToolDefinition[] {
  const script = `${FIND_OPENCLAW_SNIPPET}
const tools = findOpenClawTools();
if (!tools) { process.stdout.write('[]'); process.exit(0); }
const defs = tools.map(t => ({ name: t.name, label: t.label, description: t.description, parameters: t.parameters }));
process.stdout.write('__MCP_JSON__' + JSON.stringify(defs));
`;

  try {
    const output = execFileSync("node", ["-e", script], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const jsonStart = output.indexOf("__MCP_JSON__");
    const jsonStr = jsonStart >= 0 ? output.slice(jsonStart + 12) : output.trim();
    const parsed = JSON.parse(jsonStr) as ToolDefinition[];
    console.error(`[mcp-server] Discovered ${parsed.length} tools from openclaw`);
    return parsed;
  } catch (err) {
    console.error(`[mcp-server] Tool discovery failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Execute a tool by delegating to the native handler in a CJS subprocess.
 */
function executeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const script = `${FIND_OPENCLAW_SNIPPET}
(async () => {
  const tools = findOpenClawTools();
  if (!tools) { process.stdout.write('__MCP_JSON__' + JSON.stringify({ error: 'openclaw not found' })); process.exit(0); }
  const tool = tools.find(t => t.name === process.env._TN);
  if (!tool) { process.stdout.write('__MCP_JSON__' + JSON.stringify({ error: 'Unknown tool: ' + process.env._TN })); process.exit(0); }
  try {
    const result = await tool.execute('mcp', JSON.parse(process.env._TA));
    process.stdout.write('__MCP_JSON__' + JSON.stringify({ content: result.content }));
  } catch (e) {
    process.stdout.write('__MCP_JSON__' + JSON.stringify({ error: e.message || String(e) }));
  }
  process.exit(0);
})();
`;

  return new Promise((resolve) => {
    try {
      const output = execFileSync("node", ["-e", script], {
        encoding: "utf-8",
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, _TN: toolName, _TA: JSON.stringify(args) },
      });
      const jsonStart = output.indexOf("__MCP_JSON__");
      const jsonStr = jsonStart >= 0 ? output.slice(jsonStart + 12) : output.trim();
      const result = JSON.parse(jsonStr);
      if (result.error) {
        resolve({ content: [{ type: "text", text: `Error: ${result.error}` }] });
      } else {
        resolve(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({ content: [{ type: "text", text: `Execution error: ${msg}` }] });
    }
  });
}

/**
 * Create and configure the MCP server with lazy-loaded tools.
 * Tool discovery is deferred to the first tools/list call to avoid
 * blocking the MCP handshake (discovery takes ~6s on slow machines).
 */
export function createMcpServer(): Server {
  let toolDefs: ToolDefinition[] | null = null;

  function ensureTools(): ToolDefinition[] {
    if (toolDefs === null) {
      toolDefs = discoverTools();
      console.error(
        `[mcp-server] Registered ${toolDefs.length} tools: ${toolDefs.map((t) => t.name).join(", ")}`,
      );
    }
    return toolDefs;
  }

  const server = new Server(
    { name: "gateway-tools", version: "3.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ensureTools().map((t) => ({
      name: t.name,
      description: t.description ?? `${t.label ?? t.name} tool`,
      inputSchema: t.parameters ?? { type: "object" as const, properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const defs = ensureTools();
    const def = defs.find((t) => t.name === name);
    if (!def) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    const result = await executeTool(name, (args ?? {}) as Record<string, unknown>);
    return {
      content: result.content.map((c) => ({ type: c.type as "text", text: c.text })),
    };
  });

  console.error("[mcp-server] Server started (tools will be discovered on first use)");
  return server;
}

/**
 * Start the MCP server with stdio transport.
 */
export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run as a script
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-server.ts") || process.argv[1].endsWith("mcp-server.js"));

if (isMainModule) {
  void startMcpServer();
}

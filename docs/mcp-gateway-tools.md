# MCP Gateway Tools Server

## Overview

`src/mcp-server.ts` implements an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes the OpenClaw gateway's system tools to Claude Code. It **dynamically discovers** all available tools from the installed OpenClaw package at startup — no hardcoded tool definitions.

This gives Claude Code the ability to send messages, manage cron jobs, spawn sessions, check system status, and more — all the capabilities that the gateway normally provides to its native agents. When OpenClaw is upgraded or plugins add new tools, they are automatically available without any tmux-cc changes.

## Architecture

```
┌─────────────────────────────────────┐
│           Claude Code               │
│  (running in tmux window)           │
│                                     │
│  Discovers MCP server via           │
│  .claude/settings.json              │
│         │                           │
│         │ stdio (JSON-RPC)          │
│         ▼                           │
│  ┌──────────────┐                   │
│  │ mcp-server.ts│ (subprocess)      │
│  │ gateway-tools│                   │
│  └──────┬───────┘                   │
│         │                           │
└─────────┼───────────────────────────┘
          │ CJS subprocess: node -e
          │ → createOpenClawTools()
          ▼
┌─────────────────────────────────────┐
│   OpenClaw Runtime (CJS modules)    │
│   createOpenClawTools() → 18 tools  │
│   tool.execute(id, args)            │
└─────────────────────────────────────┘
```

### How It Gets Configured

When tmux-cc creates a new Claude Code session, `ClaudeCodeAdapter.setupWorkspace()` writes a `.claude/settings.json` file into the working directory:

```json
{
  "mcpServers": {
    "gateway-tools": {
      "command": "npx",
      "args": ["tsx", "/path/to/tmux-cc/src/mcp-server.ts"],
      "env": {
        "GATEWAY_CLI_COMMAND": "openclaw"
      }
    }
  }
}
```

Claude Code reads this file on startup and launches `mcp-server.ts` as a child process with stdio transport.

## Dynamic Tool Discovery

At startup, the MCP server:

1. Spawns a CJS Node.js subprocess (`node -e`)
2. Finds the OpenClaw installation directory
3. Loads `createOpenClawTools()` from `dist/openclaw-tools.runtime-*.js`
4. Serializes tool definitions (name, description, JSON Schema) to stdout
5. Parses the JSON and registers all tools with the MCP server

This approach is necessary because OpenClaw's bundled runtime modules use CJS `require()` internally, while the MCP server runs under tsx in ESM mode. Direct `import()` or `createRequire()` fails due to ESM-only transitive dependencies (e.g., pi-ai). The CJS subprocess sidesteps this entirely.

### Tool Execution

Each tool call also spawns a CJS subprocess that:
1. Loads `createOpenClawTools()`
2. Finds the matching tool by name
3. Calls `tool.execute(toolCallId, args)`
4. Returns the result as JSON

A `__MCP_JSON__` delimiter separates the JSON payload from module loading noise (e.g., `[tmux-cc] module instance loaded` messages).

## Tools

All 18 tools are discovered dynamically. As of the current OpenClaw version:

| Tool | Description |
|------|-------------|
| `canvas` | Canvas operations |
| `nodes` | Node management |
| `cron` | Cron job CRUD + execution |
| `message` | Multi-channel messaging |
| `tts` | Text-to-speech |
| `image_generate` | Image generation |
| `gateway` | Gateway management |
| `agents_list` | List available agents |
| `sessions_list` | List conversation sessions |
| `sessions_history` | Session conversation history |
| `sessions_send` | Send message to another session |
| `sessions_yield` | Yield control in a session |
| `sessions_spawn` | Spawn background agent session |
| `subagents` | Sub-agent management |
| `session_status` | System health/status |
| `web_search` | Web search |
| `web_fetch` | Fetch web pages |
| `browser` | Browser automation |

Tool names, descriptions, and JSON schemas come directly from `createOpenClawTools()`. When OpenClaw adds or modifies tools, the changes are picked up automatically on the next Claude Code session start.

## Implementation Details

### ESM/CJS Interop Strategy

The MCP server file (`mcp-server.ts`) uses ESM imports for the MCP SDK, but tool loading uses `execFileSync("node", ["-e", script])` to run discovery and execution in a pure CJS context. Key design decisions:

- **`execFileSync`** (not `execSync`): Avoids shell interpretation of the inline script
- **`__MCP_JSON__` delimiter**: OpenClaw modules log to stdout during initialization; the delimiter cleanly separates JSON output from noise
- **Environment variables** (`_TN`, `_TA`): Tool name and args passed via env to avoid complex shell escaping
- **`dirname()` not regex**: Node 22's TypeScript evaluator (`evalTypeScript`) chokes on certain regex patterns in `-e` scripts

### Timeouts

- **Discovery**: 15 seconds (one-time at startup)
- **Tool execution**: 120 seconds (per call)

### Server Lifecycle

```
1. ClaudeCodeAdapter.setupWorkspace() writes .claude/settings.json
2. Claude Code starts → reads settings.json → launches mcp-server.ts via npx tsx
3. mcp-server.ts spawns CJS subprocess → discovers 18 tools
4. Registers ListTools + CallTool handlers with MCP Server
5. Connects via StdioServerTransport
6. Claude Code discovers tools and can call them during conversations
7. Each tool call spawns a CJS subprocess for execution
8. Server runs until Claude Code process exits
```

## Testing

The MCP server can be tested manually:

```bash
# Start the server in stdio mode
npx tsx src/mcp-server.ts

# Verify tool discovery in stderr output:
# [mcp-server] Discovered 18 tools from openclaw
# [mcp-server] Registered 18 tools: canvas, nodes, cron, ...
```

Integration testing is done implicitly when Claude Code sessions use gateway tools during real conversations.

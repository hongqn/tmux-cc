# MCP Gateway Tools Server

## Overview

`src/mcp-server.ts` implements an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes the OpenClaw gateway's system tools to Claude Code. It acts as a bridge: Claude Code speaks MCP over stdio, and the server translates each tool call into the corresponding `openclaw` CLI command.

This gives Claude Code the ability to send messages, manage cron jobs, spawn sessions, check system status, and more REDACTED all the capabilities that the gateway normally provides to its native agents.

## Architecture

```
REDACTED
REDACTED           Claude Code               REDACTED
REDACTED  (running in tmux window)           REDACTED
REDACTED                                     REDACTED
REDACTED  Discovers MCP server via           REDACTED
REDACTED  .claude/settings.json              REDACTED
REDACTED         REDACTED                           REDACTED
REDACTED         REDACTED stdio (JSON-RPC)          REDACTED
REDACTED         REDACTED                           REDACTED
REDACTED  REDACTED                   REDACTED
REDACTED  REDACTED mcp-server.tsREDACTED (subprocess)      REDACTED
REDACTED  REDACTED gateway-toolsREDACTED                   REDACTED
REDACTED  REDACTED                   REDACTED
REDACTED         REDACTED                           REDACTED
REDACTED
          REDACTED execSync("openclaw ...")
          REDACTED
REDACTED
REDACTED      OpenClaw Gateway CLI           REDACTED
REDACTED  (message, cron, agent, status)     REDACTED
REDACTED
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

Claude Code reads this file on startup and launches `mcp-server.ts` as a child process with stdio transport. The server runs for the lifetime of the Claude Code session.

## Tools

### `message`

Multi-action channel messaging tool. Supports sending, broadcasting, reacting, editing, deleting, reading, pinning/unpinning messages, and creating polls across all configured channels (Telegram, Discord, Slack, WhatsApp, Signal, etc.).

**Actions:**

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `send` | Send a message to a channel | `channel`, `target`, `message`, `media`, `replyTo`, `threadId`, `silent`, `buttons` |
| `broadcast` | Send to all configured channels | `message`, `media`, `silent` |
| `react` | Add/remove emoji reaction | `messageId`, `emoji`, `removeReaction` |
| `edit` | Edit an existing message | `messageId`, `message` |
| `delete` | Delete a message | `messageId` |
| `read` | Read recent messages | `limit` |
| `pin` / `unpin` | Pin/unpin a message | `messageId` |
| `pins` | List pinned messages | `limit` |
| `poll` | Create a poll | `pollQuestion`, `pollOptions`, `pollMulti`, `pollAnonymous` |

**CLI mapping:** `openclaw message <action> [flags] --json`

### `sessions_send`

Send a message into another conversation session. Enables inter-session communication REDACTED one agent can dispatch work to another.

| Parameter | Description |
|-----------|-------------|
| `sessionKey` | Target session key (e.g., `agent:ops:main`) |
| `label` | Fuzzy match on session label |
| `agentId` | Agent id filter |
| `message` | Message text to inject |
| `timeoutSeconds` | Timeout (default: 120s) |

**CLI mapping:** `openclaw agent --message <msg> --session-id <key> --json`

### `sessions_list`

List conversation sessions with optional filters.

| Parameter | Description |
|-----------|-------------|
| `active` | Only sessions updated in the past N minutes |
| `agentId` | Filter by agent id |
| `allAgents` | Show sessions across all agents |

**CLI mapping:** `openclaw sessions --json [flags]`

### `cron`

Manage gateway cron jobs. Supports the full CRUD lifecycle plus execution and history.

**Actions:**

| Action | Description | Key Parameters |
|--------|-------------|----------------|
| `status` | Show cron subsystem status | REDACTED |
| `list` | List all cron jobs | `includeDisabled` |
| `add` | Create a new cron job | `name`, `cron`/`every`/`at`, `systemEvent`/`messagePayload`, `session`, `model`, `thinking` |
| `edit` | Edit an existing job | `jobId` + any add fields |
| `remove` | Delete a job | `jobId` |
| `run` | Manually trigger a job | `jobId`, `due` |
| `runs` | View job run history | `jobId`, `limit` |
| `enable` / `disable` | Toggle job state | `jobId` |

**CLI mapping:** `openclaw cron <subcommand> [flags] --json`

### `session_status`

Show system health including channel connectivity, recent session recipients, and model usage/quota.

| Parameter | Description |
|-----------|-------------|
| `deep` | Probe all channels (60s timeout) |
| `usage` | Include model provider usage data |

**CLI mapping:** `openclaw status --json [flags]`

### `sessions_spawn`

Spawn an isolated background agent session for a task. Runs independently and results can be checked later.

| Parameter | Description |
|-----------|-------------|
| `task` | Task prompt for the spawned session |
| `agentId` | Agent id override |
| `model` | Model override |
| `thinking` | Thinking level |
| `deliver` | Deliver results back to current chat |
| `deliverChannel` | Delivery channel override |
| `deliverTo` | Delivery destination override |

**CLI mapping:** `openclaw agent --message <task> --json [flags]`

### `tts`

Convert text to speech. Audio is delivered through the messaging channel.

| Parameter | Description |
|-----------|-------------|
| `text` | Text to convert |
| `channel` | Target channel for output format |

**CLI mapping:** Routes through `openclaw agent` with a TTS prompt.

### `image`

Analyze images with a vision model. Only needed when images weren't already provided in the user's message.

| Parameter | Description |
|-----------|-------------|
| `prompt` | What to analyze |
| `image` | Single image path or URL |
| `images` | Multiple image paths/URLs (up to 20) |
| `model` | Model override |

**CLI mapping:** Routes through `openclaw agent` with an image analysis prompt.

## Implementation Details

### CLI Execution

All tools delegate to the `openclaw` CLI via `execSync`:

```typescript
function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS): string {
  const cmd = [CLI_COMMAND, ...args].join(" ");
  return execSync(cmd, { encoding: "utf-8", timeout: timeoutMs }).trim();
}
```

- Default timeout: **30 seconds** (`CLI_TIMEOUT_MS`)
- Agent operations: **120 seconds** (`AGENT_TIMEOUT_MS`)
- Deep status probes: **60 seconds**

The CLI command is configurable via `GATEWAY_CLI_COMMAND` environment variable (defaults to `"openclaw"`).

### Anti-Fingerprinting

Tool names, descriptions, and output text intentionally avoid "openclaw" branding. The MCP server is named `"gateway-tools"` and all tool descriptions use generic terminology. This prevents the underlying platform from leaking into agent responses.

### Server Lifecycle

```
1. ClaudeCodeAdapter.setupWorkspace() writes .claude/settings.json
2. Claude Code starts REDACTED reads settings.json REDACTED launches mcp-server.ts via npx tsx
3. mcp-server.ts creates McpServer, registers all tools, connects via StdioServerTransport
4. Claude Code discovers tools and can call them during conversations
5. Server runs until Claude Code process exits
```

### Tool Output Format

All tools request JSON output from the CLI (`--json` flag) and return raw text content to Claude Code:

```typescript
return { content: [{ type: "text", text: output || "Done." }] };
```

### Limitations

- **Synchronous execution**: Uses `execSync`, which blocks the MCP server process during each CLI call. This is acceptable because the server handles one request at a time over stdio.
- **No streaming**: CLI output is captured in full before returning. Long-running operations (like `sessions_spawn`) block until completion or timeout.
- **TTS and Image tools**: These don't map directly to CLI commands REDACTED they route through `openclaw agent` with constructed prompts, which is an indirect but functional approach.

## Testing

The MCP server does not currently have dedicated unit tests. It can be tested manually:

```bash
# Start the server in stdio mode
npx tsx src/mcp-server.ts

# It reads JSON-RPC requests from stdin and writes responses to stdout
```

Integration testing is done implicitly when Claude Code sessions use gateway tools during real conversations.

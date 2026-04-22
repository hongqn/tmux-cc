# tmux-cc Provider Plugin

An OpenClaw provider plugin that delegates all AI inference to [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) running in persistent tmux sessions.

Instead of calling Anthropic's API directly, this plugin sends user messages to Claude Code via `tmux send-keys` and reads responses by polling Claude Code's JSONL transcript files. Claude Code handles its own context management, tool use, and authentication.

## How It Works

```
User → Telegram/Discord/etc. → OpenClaw Gateway
  → tmux send-keys (message text)
  → Claude Code CLI (in tmux window)
  → JSONL transcript polling
  → response back to user
```

Each OpenClaw conversation session maps to a dedicated tmux window running a Claude Code instance. Sessions are reused across messages in the same conversation and cleaned up after idle timeout.

## Prerequisites

- **tmux** installed and in PATH
- **Claude Code CLI** (`claude`) installed and authenticated
  - `npm install -g @anthropic-ai/claude-code` or equivalent
  - Run `claude` once manually to complete authentication
- **Node.js 22+**

## Installation

Clone or copy this plugin into your OpenClaw extensions directory:

```bash
git clone https://github.com/hongqn/tmux-cc ~/.openclaw/extensions/tmux-cc
```

Then enable the plugin:

```bash
openclaw config set plugins.tmux-cc.enabled true
```

## Configuration

All settings are optional. Configure via `openclaw config set`:

| Key                                     | Default           | Description                                  |
| --------------------------------------- | ----------------- | -------------------------------------------- |
| `plugins.tmux-cc.workingDirectory`  | `process.cwd()`   | Working directory for Claude Code sessions   |
| `plugins.tmux-cc.claudeCommand`     | `claude`          | Path to Claude Code CLI executable           |
| `plugins.tmux-cc.tmuxSession`       | `openclaw-cc` | Name of the tmux session to use              |
| `plugins.tmux-cc.pollingIntervalMs` | `1000`            | Polling interval for transcript reading (ms) |
| `plugins.tmux-cc.responseTimeoutMs` | `300000`          | Max time to wait for a response (ms)         |
| `plugins.tmux-cc.idleTimeoutMs`     | `1800000`         | Idle timeout before session cleanup (ms)     |
| `plugins.tmux-cc.defaultModel`      | `sonnet-4.6`      | Default Claude model                         |

### Model Selection

Select a model by setting the gateway model to one of:

- `tmux-cc/opus-4.6`
- `tmux-cc/sonnet-4.6`
- `tmux-cc/sonnet-4.5`
- `tmux-cc/haiku-4.5`

```bash
openclaw config set models.default tmux-cc/sonnet-4.6
```

## Context and CLAUDE.md

Claude Code manages its own context. Place a `CLAUDE.md` (or `AGENTS.md`) file in the configured `workingDirectory` to provide instructions. Claude Code loads these files automatically.

OpenClaw's system prompt is **not** injected — Claude Code handles all context assembly.

## MCP Tools Bridge

The plugin includes an MCP server that exposes select gateway capabilities to Claude Code:

| Tool                   | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `send_session_message` | Send a message to another conversation session        |
| `list_sessions`        | List active conversation sessions                     |
| `session_history`      | Fetch message history for a session                   |
| `send_channel_message` | Send a message to a channel (Telegram, Discord, etc.) |
| `manage_cron`          | Manage scheduled tasks                                |
| `generate_image`       | Generate images                                       |
| `text_to_speech`       | Convert text to speech                                |

The MCP server is configured automatically in `.claude/settings.json` in the working directory.

## Session Management

- Each conversation gets a dedicated tmux window within the configured tmux session
- Windows are named `cc-<sanitized-session-key>`
- Idle sessions are cleaned up after the configured timeout (default 30 minutes)
- If Claude Code crashes, it is automatically restarted with `--resume` to restore context

### Viewing Sessions

```bash
# List tmux windows
tmux list-windows -t openclaw-cc

# Attach to a session to observe
tmux attach -t openclaw-cc

# Select a specific window
tmux select-window -t openclaw-cc:<window-name>
```

## Image Support

Images sent via messaging channels are saved to `.openclaw-images/` in the working directory and referenced in the message text. Claude Code can then use its built-in file reading to analyze the images.

## Troubleshooting

### Claude Code not responding

1. Check tmux session exists: `tmux has-session -t openclaw-cc`
2. Attach and check for errors: `tmux attach -t openclaw-cc`
3. Verify Claude Code is authenticated: run `claude` manually

### Permission prompts blocking

The plugin uses `--dangerously-skip-permissions` flag. If you see permission prompts, ensure Claude Code CLI supports this flag (requires recent version).

### Transcript not found

Claude Code writes transcripts to `~/.claude/projects/<encoded-cwd>/`. Verify the working directory matches where Claude Code creates its project files.

## Development

```bash
# Run tests
npx vitest run

# Run with verbose output
npx vitest run --reporter=verbose
```

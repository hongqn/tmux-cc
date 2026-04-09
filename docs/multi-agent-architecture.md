# Multi-Agent Architecture Plan

> Goal: Introduce an abstraction layer so tmux-cc can drive **any** interactive CLI
> agent in tmux REDACTED not just Claude Code. Target agents: **Copilot CLI**, **Codex**,
> and future CLI tools.

## Current State

Today every source file is wired directly to Claude Code conventions:

| Layer | Claude-Code Coupling |
|-------|---------------------|
| `tmux-manager.ts` | REDACTED Generic REDACTED pure tmux operations |
| `session-persistence.ts` | REDACTED Generic REDACTED keyREDACTEDID JSON store |
| `session-map.ts` | ðREDACTED CC-specific: `/model` command, `REDACTED` prompt, `esc to int` status |
| `transcript-reader.ts` | ðREDACTED CC-specific: `~/.claude/projects/` path encoding, JSONL schema |
| `stream-fn.ts` | ðREDACTED CC-specific: polling loop hardcodes transcript parsing, completion detection |
| `types.ts` | ðREDACTED CC-specific: `TranscriptEntry` schema with thinking/tool_use blocks |
| `index.ts` | ðREDACTED CC-specific: workspace setup (CLAUDE.md, `.claude/` dir, MCP settings) |

## Target Architecture

```
REDACTED
REDACTED  index.ts  (plugin entry point)                         REDACTED
REDACTED  REDACTED Registers providers per agent (tmux-cc, tmux-copilot)REDACTED
REDACTED  REDACTED Resolves agent adapter by provider/model             REDACTED
REDACTED
                 REDACTED
                 REDACTED
REDACTED
REDACTED  stream-fn.ts  (agent-agnostic orchestrator)            REDACTED
REDACTED  REDACTED Extracts user messages from OpenClaw context         REDACTED
REDACTED  REDACTED Manages streaming event lifecycle                    REDACTED
REDACTED  REDACTED Delegates agent-specific work to AgentAdapter        REDACTED
REDACTED
                 REDACTED uses AgentAdapter interface
                 REDACTED
REDACTED
REDACTED              AgentAdapter (interface)                    REDACTED
REDACTED                                                         REDACTED
REDACTED  launch / resume / sendMessage                          REDACTED
REDACTED  discoverTranscript / readEntries / isComplete          REDACTED
REDACTED  isReady / isProcessing / switchModel                   REDACTED
REDACTED  setupWorkspace                                         REDACTED
REDACTED
        REDACTED              REDACTED              REDACTED
        REDACTED              REDACTED              REDACTED
REDACTED REDACTED REDACTED
REDACTED claude-code/ REDACTED REDACTED copilot/  REDACTED REDACTED codex/    REDACTED
REDACTED  adapter.ts  REDACTED REDACTED adapter.tsREDACTED REDACTED adapter.tsREDACTED
REDACTED  types.ts    REDACTED REDACTED types.ts  REDACTED REDACTED types.ts  REDACTED
REDACTED  workspace.tsREDACTED REDACTED           REDACTED REDACTED           REDACTED
REDACTED REDACTED REDACTED
        REDACTED
        REDACTED
REDACTED
REDACTED  Shared infrastructure (unchanged)                      REDACTED
REDACTED  tmux-manager.ts REDACTED session-map.ts REDACTED session-persistence REDACTED
REDACTED
```

## AgentAdapter Interface

```typescript
interface AgentAdapter {
  /** Unique agent identifier, e.g. "claude-code", "copilot-cli", "codex" */
  readonly id: string;

  // REDACTED Lifecycle REDACTED

  /** Build the shell command to launch the agent in a tmux window. */
  buildLaunchCommand(opts: {
    model: string;
    resumeSessionId?: string;
    cwd: string;
    extraEnv?: Record<string, string>;
  }): { cmd: string; env?: Record<string, string> };

  /**
   * Wait for the agent TUI to be ready to accept input.
   * Handles first-run prompts, permission dialogs, etc.
   */
  waitForReady(
    tmuxSession: string,
    windowName: string,
    timeoutMs: number,
  ): Promise<void>;

  /**
   * One-time workspace setup (e.g. write CLAUDE.md, MCP settings).
   * Called once per gateway boot, not per session.
   */
  setupWorkspace?(cwd: string, config: AgentConfig): Promise<void>;

  // REDACTED Input REDACTED

  /**
   * Prepare text before sending to the agent.
   * May escape special characters, add wrappers, etc.
   */
  prepareInput?(text: string): string;

  /**
   * Switch the agent's model in an existing session.
   * Returns false if the agent doesn't support mid-session switching.
   */
  switchModel?(
    tmuxSession: string,
    windowName: string,
    newModel: string,
  ): Promise<boolean>;

  // REDACTED Output / Transcript REDACTED

  /** Directory where the agent writes transcripts/logs for a given cwd. */
  transcriptDir(cwd: string): string;

  /** File extension for transcript files (e.g. ".jsonl"). */
  readonly transcriptExt: string;

  /**
   * Parse one line of the transcript file into a generic entry.
   * Returns null for lines that should be skipped.
   */
  parseTranscriptLine(line: string): AgentEntry | null;

  /**
   * Extract the agent's session/conversation ID from a transcript file
   * (path or first few lines).
   */
  extractSessionId(transcriptPath: string, firstEntry?: AgentEntry): string | undefined;

  /**
   * Given accumulated entries for the current turn, determine whether
   * the agent has finished responding.
   */
  isResponseComplete(entries: AgentEntry[]): {
    complete: boolean;
    text: string;
    thinking?: string;
    stopReason?: string;
  };

  // REDACTED TUI State REDACTED

  /**
   * Check whether the agent is currently processing (thinking / running
   * a tool). Used as a fallback when transcript-level completion detection
   * is ambiguous.
   */
  isProcessing(
    tmuxSession: string,
    windowName: string,
  ): Promise<boolean>;
}
```

### AgentEntry REDACTED Generic Transcript Entry

```typescript
interface AgentEntry {
  role: "user" | "assistant" | "system";
  /** Structured content blocks (agent-specific, but normalised) */
  content: AgentContentBlock[];
  sessionId?: string;
  timestamp?: string;
  /** Raw parsed object for adapter-specific use */
  raw?: unknown;
}

type AgentContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string }
  | { type: "meta"; key: string; value: unknown };
```

## Agent Comparison

| Aspect | Claude Code | Copilot CLI | Codex |
|--------|------------|-----------|-------|
| **Binary** | `claude` | `copilot-cli` | `codex` |
| **Launch flags** | `--model X --permission-mode bypassPermissions` | TBD REDACTED likely `--model X` | TBD REDACTED likely `--model X` |
| **Resume** | `--resume <sessionId>` | TBD | TBD |
| **Transcript location** | `~/.claude/projects/<cwd>/` | TBD REDACTED may use stdout or different dir | TBD |
| **Transcript format** | JSONL with `type`, `message`, `stop_reason` | TBD | TBD |
| **Thinking blocks** | Explicit `{type: "thinking"}` | Likely absent | Likely absent |
| **Completion signal** | `stop_reason: "end_turn"` or `turn_duration` system entry | TBD REDACTED maybe exit or prompt | TBD |
| **Ready prompt** | `REDACTED` (U+276F) after permission prompts | TBD | TBD |
| **Processing indicator** | `esc to int` in pane content | TBD | TBD |
| **Model switching** | `/model <name>` REPL command | TBD REDACTED maybe not supported | TBD |
| **MCP support** | Yes, via `.claude/settings.json` | TBD | TBD |

> **Note**: Copilot CLI and Codex details are TBD REDACTED will be filled in once we
> investigate their actual CLI behaviour. The adapter pattern lets us add them
> incrementally without touching the core orchestrator.

## Migration Plan

### Phase 1: Extract Claude Code Adapter (no new agents)

**Goal**: Move all CC-specific logic behind the `AgentAdapter` interface without
changing external behaviour. All existing tests must pass.

1. Create `src/adapters/` directory structure:
   ```
   src/adapters/
     types.ts              REDACTED AgentAdapter, AgentEntry, AgentContentBlock interfaces
     claude-code/
       adapter.ts          REDACTED ClaudeCodeAdapter implements AgentAdapter
       types.ts            REDACTED CC-specific TranscriptEntry, TranscriptContentBlock
       transcript.ts       REDACTED Extracted from transcript-reader.ts (CC parsing logic)
       workspace.ts        REDACTED Extracted from index.ts (CLAUDE.md, MCP settings)
   ```

2. Refactor `stream-fn.ts`:
   - Accept `AgentAdapter` as a parameter instead of importing CC functions directly
   - Replace `readNewEntries` + `extractAssistantResponse` with adapter calls
   - Replace transcript path discovery with `adapter.transcriptDir()` + generic file watching

3. Refactor `session-map.ts`:
   - Accept `AgentAdapter` for `waitForReady`, `isProcessing`, `switchModel`
   - Keep generic session lifecycle (create, restart, cleanup)

4. Keep `tmux-manager.ts` and `session-persistence.ts` unchanged (already generic)

5. Update `index.ts`:
   - Instantiate `ClaudeCodeAdapter`
   - Pass it through to stream-fn and session-map

### Phase 2: Add Second Agent (Copilot CLI or Codex)

**Goal**: Prove the abstraction works by adding a real second agent.

1. Investigate the target agent's CLI behaviour:
   - How it launches, what flags it takes
   - Where/how it writes output (file? stdout? log dir?)
   - How to detect completion
   - TUI quirks (prompts, permission dialogs)

2. Create `src/adapters/copilot/adapter.ts` (or `codex/`):
   - Implement `AgentAdapter` for the target
   - Write tests against real CLI output samples

3. Register as a new provider in `index.ts`:
   - e.g. `tmux-copilot/gpt-5.4`
   - New model catalog entry in `openclaw.plugin.json`

4. Deploy and test on one machine first

### Phase 3: Polish

- Shared test helpers for adapter conformance testing
- Documentation for "how to add a new agent"
- Consider config-driven adapter registration (agents.json) instead of code

## File Change Summary

| Current File | Change |
|-------------|--------|
| `src/types.ts` | Extract CC types REDACTED `src/adapters/claude-code/types.ts`. Keep generic `AgentConfig` |
| `src/transcript-reader.ts` | Split: generic JSONL utils stay, CC parsing REDACTED `adapters/claude-code/transcript.ts` |
| `src/stream-fn.ts` | Accept `AgentAdapter` param; replace CC calls with adapter methods |
| `src/session-map.ts` | Accept `AgentAdapter` for waitForReady/isProcessing/switchModel |
| `src/tmux-manager.ts` | No change (already generic) |
| `src/session-persistence.ts` | No change (already generic) |
| `src/mcp-server.ts` | Move to `adapters/claude-code/mcp.ts` (CC-specific) |
| `index.ts` | Instantiate adapter; register per-agent providers |
| `openclaw.plugin.json` | Add new provider sections when new agents are added |

## Open Questions

1. **Plugin name**: Should the plugin remain `tmux-cc` or rename to `tmux-agents`?
   Renaming affects all 3 machines' extension paths and openclaw.json configs.

2. **Provider naming**: Current `tmux-cc/sonnet-4.6`. For Copilot, `tmux-copilot/gpt-5.4`?
   Or unified namespace like `tmux/cc-sonnet-4.6`, `tmux/copilot-gpt-5.4`?

3. **Stdout-based agents**: Some CLI agents may not write transcript files REDACTED
   they stream to stdout. The adapter should support this mode (capture pane
   content instead of reading files).

4. **Shared sessions**: Should different agents share the same session-map,
   or separate maps per agent? (Separate is safer.)

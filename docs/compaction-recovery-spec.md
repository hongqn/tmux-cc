# Copilot CLI Compaction Recovery — Spec

## Problem

Copilot CLI auto-compacts when the agent's context approaches its token budget.
Compaction summarizes earlier messages and replaces them with a shorter
`summaryContent`. After compaction, the agent often loses track of the in-flight
task and begins **re-doing work that was already completed**.

Compaction happens **mid-interaction** (between the agent's sub-turns within a
single user request), so the agent cannot be notified synchronously — by the
time we detect it in `events.jsonl`, the agent is already continuing to process
based on the summarized context.

Copilot CLI exposes no post-compaction hook (`hook.start`/`hook.end` events are
limited to `userPromptSubmitted`, `preToolUse`, `postToolUse`, `sessionEnd`,
`errorOccurred`), so the recovery has to live in `tmux-cc`.

## Goal

When Copilot CLI compacts mid-turn, inject a short steering message on the
**next** user message to remind the agent to read the checkpoint file before
acting, preventing repeated work.

- Only applies to **Copilot CLI** sessions. Claude Code is out of scope.
- **No config toggle** — always on.
- Implementation mirrors KSSP suffix: a conditional prefix on the user's next
  message.

## Event shape we rely on

Two events appear in `~/.copilot/session-state/<sid>/events.jsonl` around every
compaction:

```jsonl
{"type":"session.compaction_start","data":{"systemTokens":...,"conversationTokens":...,"toolDefinitionsTokens":...}, ...}
{"type":"session.compaction_complete","data":{
  "success": true,
  "preCompactionTokens": 102597,
  "preCompactionMessagesLength": 197,
  "summaryContent": "<overview>...",
  "checkpointNumber": 1,
  "checkpointPath": "/Users/.../checkpoints/001-multi-model-config-...md",
  "compactionTokensUsed": {...}
}, ...}
```

The `checkpointPath` is the absolute path to a checkpoint file that Copilot
CLI auto-generates. The checkpoint uses a rich six-section template
(`<overview>`, `<history>`, `<work_done>`, `<technical_details>`,
`<important_files>`, `<next_steps>`) and is sufficient on its own for the
agent to recover state.

## Design (Approach "C")

Out of three options (A: inject mid-processing, B: inject at next ask_user, C:
inject on next user message), we pick **C** because:

- **A** is infeasible: Copilot CLI's TUI discards `sendKeys` while the agent
  is processing.
- **B** requires polling-loop interception, re-entry, and decisions about
  which response to emit — too much state-machine weight for the value.
- **C** reuses the existing "append suffix to user text" path (mirrors KSSP).
  Failure mode: the current in-flight response may be imperfect; user's next
  message (whatever it is) arrives with the guidance attached and re-orients
  the agent cleanly.

### Flow

1. Poll loop reads `events.jsonl` and parses events into `TranscriptEntry`.
2. When `session.compaction_complete` appears, we store its `checkpointPath`
   on `SessionState.pendingCompactionCheckpoint`.
3. On the next user message sent through this session's `sendMessage`, we
   **prefix** the message with a compaction-recovery prelude, then append
   KSSP as usual. The `pendingCompactionCheckpoint` field is cleared after
   use.
4. If multiple compactions happen before the next user message, only the
   **latest** `checkpointPath` is kept (overwrite; checkpoint files are
   cumulative).

### Steering prelude content

Constant template, parameterized on checkpointPath:

```
[Context compaction just occurred. Before responding, read the checkpoint at
{checkpointPath} to recover your task state, paying special attention to
<work_done> and <next_steps>. Do NOT redo work already listed as completed.]

{userText}

{KSSP_SUFFIX}
```

- English is used so the prelude parses cleanly against the English system
  prompt and agent-facing instructions.
- The prelude is a single self-contained bracket block so the agent can
  distinguish it from user text.
- `<work_done>` and `<next_steps>` are named explicitly because they are the
  two sections the agent needs to avoid duplication and keep progress.

## Files to change

| File | Change |
|---|---|
| `src/types.ts` | Add optional `pendingCompactionCheckpoint?: string` field to `SessionState`. |
| `src/copilot-transcript-reader.ts` | In `parseEvent`, add a branch for `session.compaction_complete` returning a `{type:"system", subtype:"compaction_complete"}` entry with the `checkpointPath` attached (extend `TranscriptEntry` with an optional `checkpointPath?: string`). |
| `src/stream-fn.ts` | In `pollForResponse`, after reading new entries, scan for the `compaction_complete` system entry and update `session.pendingCompactionCheckpoint`. Then in the existing path that builds the final `sendMessage` / `sendKeys` text (Step 7 and the re-send path at Step 8.5), if `session.pendingCompactionCheckpoint` is set, prepend the steering prelude and clear the field. Same for the steering-queue path in `checkSteering`. |
| `src/adapters/copilot-cli.ts` | No change to `sendMessage` signature needed; the prefix is built inside `stream-fn.ts` (which owns `SessionState`) before handing final text to the adapter. |

### Why the prefix is built in `stream-fn.ts` and not inside the adapter

`sendMessage` currently accepts only `(tmuxSession, windowName, text, sessionKey)`.
Passing `SessionState` in would bleed session-map internals into the adapter
interface. It is cleaner to let `stream-fn.ts` (which already owns the
`SessionState` and is agent-agnostic) wrap the text once, right before calling
`adapter.sendMessage`.

### Claude Code adapter

No changes. The transcript-reader path for CC does not emit
`compaction_complete` entries, so `pendingCompactionCheckpoint` will never be
set for CC sessions and the prefix will never fire.

## Tests

- Unit test in `src/copilot-transcript-reader.test.ts` (or equivalent):
  `session.compaction_complete` parses into a system entry with the expected
  `subtype` and `checkpointPath`.
- Unit test in `src/stream-fn.test.ts` (if present) or new test file: when
  `SessionState.pendingCompactionCheckpoint` is set and we drive the send
  path, the outgoing text begins with the steering prelude and the field is
  cleared afterwards.
- Integration smoke: unchanged path (no compaction) produces identical output
  to today (no prelude leak).

## Non-goals / out of scope

- Claude Code compaction recovery. (Different transcript format, different
  mechanism; revisit if needed separately.)
- Configurable prelude text / user-tunable template.
- Mid-turn interception (Approach B). Revisit only if C proves insufficient
  in practice.
- Post-compaction summary rewrite, hook-based injection, or any change to
  Copilot CLI configuration.

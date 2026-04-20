import { createHash, randomUUID } from "node:crypto";
/**
 * Custom StreamFn implementation for the tmux-cc provider.
 *
 * This StreamFn extracts new user messages from OpenClaw's context,
 * sends them to the agent via tmux send-keys, polls the transcript
 * for the response, and emits AssistantMessageEventStream events.
 *
 * Agent-specific logic (transcript parsing, process detection, etc.)
 * is delegated to an {@link AgentAdapter}.
 */
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { AgentAdapter } from "./adapters/types.js";
import { deleteSession, getOrCreateSession, resolveAgentId, resolveSessionKeyName, restartSession, scheduleEagerCleanup } from "./session-map.js";
import { getStableSessionKey, persistSession, persistStableSessionKey } from "./session-persistence.js";
import { sendKeys, sendTmuxKey, capturePane, killWindow, readCrashLog } from "./tmux-manager.js";
// Transcript-reader imports used as fallback when no adapter is provided
import {
  readNewEntries as trReadNewEntries,
  extractAssistantResponse as trExtractResponse,
  findTranscriptBySessionId as trFindBySessionId,
  findNewTranscript as trFindNew,
  findGrowingTranscript as trFindGrowing,
  findLatestTranscript as trFindLatest,
  extractSessionId as trExtractSessionId,
} from "./transcript-reader.js";
// tmux-manager CC-specific fallbacks
import {
  isProcessAlive as tmuxIsProcessAlive,
  isClaudeProcessing as tmuxIsClaudeProcessing,
  readExitCode as tmuxReadExitCode,
} from "./tmux-manager.js";
import type { TmuxClaudeConfig, SessionState, AssistantResponse, TranscriptEntry } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface StreamFnOptions {
  /** Plugin configuration. */
  config: TmuxClaudeConfig;
  /** Agent adapter for agent-specific operations. */
  adapter?: AgentAdapter;
  /** Fallback adapter used when the primary adapter's validateSession returns a fallback. */
  fallbackAdapter?: AgentAdapter;
  /** Provider ID (e.g., "tmux-cc", "tmux-copilot") REDACTED used in response metadata. */
  providerId?: string;
}

/**
 * Derive a stable session key from the conversation context.
 *
 * Prefers the provider-level `sessionId` forwarded by pi-agent-core
 * (set by OpenClaw from its internal session key). This is unique per
 * conversation and eliminates cross-group collisions.
 *
 * Falls back to a SHA-256 hash of the first user message when sessionId
 * is unavailable (e.g. direct API testing).
 */
export function deriveSessionKey(messages: Message[], sessionId?: string): string {
  if (sessionId) {
    const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    return `tmux-${hash}`;
  }

  const firstUserMsg = messages.find((m) => m.role === "user") as UserMessage | undefined;
  if (!firstUserMsg) {
    return `tmux-${randomUUID().slice(0, 12)}`;
  }

  let text: string;
  if (typeof firstUserMsg.content === "string") {
    text = firstUserMsg.content;
  } else {
    text = firstUserMsg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as TextContent).text)
      .join("");
  }

  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `tmux-${hash}`;
}

/**
 * Create the StreamFn for the tmux-cc provider.
 *
 * The returned function:
 * 1. Derives a session key from the first user message (stable per conversation)
 * 2. Extracts new user message text from context (ignores system prompt, history, tools)
 * 3. Handles image attachments by saving to temp files
 * 4. Sends the message to Claude Code via tmux send-keys
 * 5. Polls the JSONL transcript until the response is complete
 * 6. Emits the response as an AssistantMessageEventStream
 */
export function createTmuxClaudeStreamFn(opts: StreamFnOptions) {
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const primaryAdapter = opts.adapter;
  const fallbackAdapter = opts.fallbackAdapter;
  const providerId = opts.providerId ?? "tmux-cc";

  return (_model: unknown, context: Context, options?: Record<string, unknown>) => {
    const stream = createAssistantMessageEventStream();
    // Cancellation signal REDACTED set when the consumer calls return() or abort signal fires (e.g., /stop)
    let cancelled = false;
    let cancelSession: SessionState | null = null;
    // Set when the stream has completed normally REDACTED prevents return() from sending Escape
    let streamDone = false;
    // Guard against sending Escape multiple times (abort handler + poll + return())
    let escSent = false;

    const signal = options?.signal as AbortSignal | undefined;
    const sessionId = options?.sessionId as string | undefined;

    // Extract getSteeringMessages from options REDACTED pi-agent-core spreads its
    // config into the third argument of streamFn, so this is available at
    // runtime even though it's not in the declared type.
    const getSteeringMessages = options?.getSteeringMessages as
      | (() => unknown[] | Promise<unknown[]>)
      | undefined;

    /** Send Escape to CC exactly once, then Ctrl-U to clear any stale input. */
    const interruptCC = async (source: string) => {
      if (escSent) return;
      escSent = true;
      if (cancelSession && !streamDone) {
        try {
          await sendTmuxKey(config.tmuxSession, cancelSession.windowName, "Escape");
          // Small delay to let CC return to prompt, then clear any stale text in input buffer
          await sleep(200);
          await sendTmuxKey(config.tmuxSession, cancelSession.windowName, "C-u");
          console.log(`[tmux-cc] sent Escape + Ctrl-U to interrupt CC (${source})`);
        } catch {
          // Window may already be gone
        }
      }
    };

    // Listen to the abort signal from the caller (pi-agent forwards this from /stop)
    if (signal) {
      if (signal.aborted) {
        cancelled = true;
      } else {
        signal.addEventListener("abort", () => {
          console.log(`[tmux-cc] abort signal received REDACTED cancelling stream`);
          cancelled = true;
          interruptCC("abort signal");
        }, { once: true });
      }
    }

    const run = async () => {
      let streamStarted = false;
      // Mutable: may switch to fallbackAdapter when validateSession returns a fallback
      let adapter = primaryAdapter;
      let runConfig = config;
      try {
        // Step 1: Resolve the openclaw session key name (e.g. "agent:main:main")
        // BEFORE deriving the tmux session key, so the same logical conversation
        // always maps to the same tmux window REDACTED even when the gateway issues a
        // new session UUID (eviction). User-initiated /new and /reset are
        // handled separately by the before_reset hook (see index.ts), which
        // explicitly tears down the window when intentional refresh is needed.
        const agentAccountId = await resolveAgentId(sessionId);
        const sessionKeyName = await resolveSessionKeyName(sessionId, agentAccountId ?? undefined);

        // Recover a previously-used sessionKey so msg 1 (sessionKeyName race
        // REDACTED sessions.json not yet written) and msg 2 (sessionKeyName now
        // resolvable, different hash) share a tmux window. Try sessionKeyName
        // first (covers gateway eviction where sessionId changes but the key
        // name stays the same), then sessionId (covers the first-message
        // race). Derive fresh only when no prior mapping exists.
        let sessionKey: string | undefined;
        let sessionKeySource: string = "derived";
        if (sessionKeyName) {
          const recovered = getStableSessionKey(sessionKeyName);
          if (recovered) { sessionKey = recovered; sessionKeySource = "stable(sessionKeyName)"; }
        }
        if (!sessionKey && sessionId) {
          const recovered = getStableSessionKey(sessionId);
          if (recovered) { sessionKey = recovered; sessionKeySource = "stable(sessionId)"; }
        }
        if (!sessionKey) {
          sessionKey = deriveSessionKey(context.messages, sessionKeyName ?? sessionId);
        }

        // Persist the mapping under every identifier available so a later
        // call REDACTED even one racing through the resolveSessionKeyName gap, or
        // arriving post-eviction with a fresh sessionId REDACTED recovers the same
        // sessionKey.
        if (sessionId) persistStableSessionKey(sessionId, sessionKey);
        if (sessionKeyName) persistStableSessionKey(sessionKeyName, sessionKey);

        console.log(`[tmux-cc] run: sessionKey=${sessionKey} (${sessionKeySource}), sessionKeyName=${sessionKeyName ?? "null"}, messageCount=${context.messages.length}, sessionId=${sessionId ?? "none"}`);

        // Step 2: Extract new user message(s) from context
        const userText = extractNewUserMessages(context.messages);
        if (!userText) {
          console.error(`[tmux-cc] no new user message found`);
          emitError(stream, "No new user message found in context");
          return;
        }
        console.log(`[tmux-cc] userText length=${userText.length}`);

        // Step 3: Handle image attachments
        const processedText = processMediaContent(context.messages, config.workingDirectory);
        const rawText = processedText || userText;

        // Step 3.5: Strip OpenClaw bootstrap warnings REDACTED Claude Code manages
        // its own context files (CLAUDE.md, MEMORY.md) directly.
        const finalText = stripBootstrapWarnings(rawText);

        // Step 4.2: Let the adapter reject or redirect sessions it shouldn't handle.
        // E.g., tmux-copilot redirects cron/subagent sessions to the Claude Code
        // adapter, or rate-limited models to the fallback provider.
        if (adapter?.validateSession) {
          const validation = adapter.validateSession(sessionKeyName ?? sessionId, config.defaultModel);
          if (validation?.fallback && fallbackAdapter) {
            console.log(`[tmux-cc] session "${sessionKeyName}" redirected to ${fallbackAdapter.id} model=${validation.fallback}`);
            adapter = fallbackAdapter;
            runConfig = { ...config, defaultModel: validation.fallback };
          }
        }

        // Step 4.5: Get or create the agent session
        // `session` is mutable so the rate-limit mid-stream fallback (below)
        // can tear down the current window and swap to the fallback adapter.
        let session = await getOrCreateSession(sessionKey, runConfig.defaultModel, runConfig, adapter, agentAccountId ?? undefined);
        cancelSession = session;
        console.log(`[tmux-cc] session: window=${session.windowName}, transcriptPath=${session.transcriptPath ?? "null"}, claudeSessionId=${session.claudeSessionId ?? "null"}, snapshotSize=${session.existingTranscriptPaths?.size ?? "none"}`);

        // Check if already cancelled before doing more work
        if (cancelled) {
          console.log(`[tmux-cc] cancelled before sending message`);
          return;
        }

        // Step 5: Ensure agent process is alive
        const aliveCheck = adapter
          ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
          : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);
        if (!aliveCheck) {
          console.error(`[tmux-cc] process not alive in window=${session.windowName}`);
          emitTextResponse(stream, "REDACTEDÔREDACTED Agent process failed to start. Please retry.");
          return;
        }

        // Step 5.5: Wait for agent to finish auto-compaction on resume.
        // When CC resumes with --resume, it may auto-compact right after
        // showing the REDACTED prompt. waitForReady detects REDACTED and returns, but
        // CC immediately starts processing /compact. Any message sent via
        // sendKeys during compaction is lost. Wait for CC to become idle.
        {
          const STABILIZE_DELAY_MS = 2000;
          const IDLE_TIMEOUT_MS = 120_000;
          await sleep(STABILIZE_DELAY_MS);
          const processing = adapter
            ? await adapter.isProcessing(config.tmuxSession, session.windowName)
            : await tmuxIsClaudeProcessing(config.tmuxSession, session.windowName);
          if (processing) {
            console.log(`[tmux-cc] agent is processing (auto-compacting?), waiting for idle...`);
            const idleDeadline = Date.now() + IDLE_TIMEOUT_MS;
            while (Date.now() < idleDeadline) {
              await sleep(1000);
              if (cancelled) {
                console.log(`[tmux-cc] cancelled while waiting for idle`);
                return;
              }
              const still = adapter
                ? await adapter.isProcessing(config.tmuxSession, session.windowName)
                : await tmuxIsClaudeProcessing(config.tmuxSession, session.windowName);
              if (!still) {
                console.log(`[tmux-cc] agent is now idle after auto-compaction`);
                break;
              }
            }
          }
        }

        // Step 6: Record current transcript offset before sending.
        // The session's transcriptPath was set during createNewSession
        // (via snapshot-based discovery). For subsequent messages in the
        // same session, we reuse the same file and just advance the offset.
        let offsetBeforeSend = 0;
        if (session.transcriptPath) {
          try {
            offsetBeforeSend = statSync(session.transcriptPath).size;
          } catch {
            // File may not exist yet (rare race); pollForResponse will discover it
            session.transcriptPath = undefined;
          }
        }
        console.log(`[tmux-cc] offsetBeforeSend=${offsetBeforeSend}`);


        // Step 7: Send message via tmux (adapter may transform and handle UI state)
        console.log(`[tmux-cc] sendKeys: length=${finalText.length}`);
        try {
          if (adapter?.sendMessage) {
            await adapter.sendMessage(config.tmuxSession, session.windowName, finalText, sessionKeyName ?? sessionId);
          } else {
            await sendKeys(config.tmuxSession, session.windowName, finalText);
          }
        } catch (e) {
          // Window may have been killed between isProcessAlive check and sendKeys
          console.error(`[tmux-cc] sendKeys failed: ${e instanceof Error ? e.message : e}`);
          emitTextResponse(stream, "REDACTEDÔREDACTED Claude Code session is unavailable. Please retry.");
          await killWindow(config.tmuxSession, session.windowName);
          return;
        }

        // Step 7.5: Emit early `start` event to prevent gateway stall timeout.
        // The gateway kills streams after ~60s of no events, but CC tool-call
        // chains can take minutes. We emit `start` now, then stream thinking
        // and tool-call progress during polling via `onNewEntries` callback.
        //
        // Build a progressive partial message that accumulates content blocks,
        // mimicking how API providers (e.g. Anthropic) build the message during
        // streaming. Each CC transcript entry becomes one or more content blocks.
        const partialContent: AssistantMessage["content"] = [];
        const makePartial = (): AssistantMessage => ({
          role: "assistant",
          content: partialContent,
          api: "anthropic-v1",
          provider: providerId,
          model: session.model ?? "claude-code",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        });

        stream.push({ type: "start", partial: makePartial() });
        streamStarted = true;

        // Streaming state REDACTED tracked across polls to emit incremental events.
        // Each transcript entry becomes its own text content block. Emitting as
        // text (not thinking) is what makes progress reach Telegram block
        // replies: OpenClaw's pi-embedded-subscribe early-returns on thinking_*
        // events unless reasoningLevel is "stream", so thinking_* never hits
        // the block-reply pipeline. text_* events do, and text_end triggers
        // flushBlockReplyBuffer REDACTED onBlockReply per entry.
        //
        // Requires blockStreamingBreak: "text_end" (default) and
        // blockStreamingCoalesce.idleMs >= 1 on the Telegram channel config;
        // idleMs: 0 disables the idle timer entirely and batches everything
        // to turn end.
        let lastProcessedEntryIdx = 0;
        let lastStreamEventMs = Date.now();
        const HEARTBEAT_INTERVAL_MS = 25_000;
        const streamedTextParts: string[] = [];

        const emitProgressText = (text: string) => {
          const block: TextContent = { type: "text", text };
          partialContent.push(block);
          streamedTextParts.push(text);
          const idx = partialContent.length - 1;
          const msg = makePartial();
          stream.push({ type: "text_start", contentIndex: idx, partial: msg });
          stream.push({ type: "text_delta", contentIndex: idx, delta: text, partial: msg });
          stream.push({ type: "text_end",   contentIndex: idx, content: text, partial: msg });
          lastStreamEventMs = Date.now();
        };

        const onNewEntries = (allEntries: TranscriptEntry[]) => {
          for (let i = lastProcessedEntryIdx; i < allEntries.length; i++) {
            const entry = allEntries[i];
            if (entry.type !== "assistant") continue;

            // Only stream natural-language reasoning: real thinking content
            // (usually empty for CC login auth) and CC's prose commentary
            // between tool calls. Skip tool_use blocks REDACTED users don't want
            // "REDACTED Bash: ..." noise in Telegram, just the thinking.
            const parts: string[] = [];
            for (const block of entry.message.content) {
              if (block.type === "thinking" && block.thinking) {
                parts.push(block.thinking);
              }
              if (block.type === "text" && block.text) {
                parts.push(block.text);
              }
            }
            const progressText = parts.join("\n").trim();
            if (progressText) emitProgressText(progressText);
          }
          lastProcessedEntryIdx = allEntries.length;

          // Heartbeat: emit an empty thinking event every 25s of silence to
          // keep the gateway stream alive during long CC thinking phases with
          // no transcript writes. Empty thinking_delta is dropped by OpenClaw
          // (emitReasoningStream early-returns on empty text), so this is
          // invisible to Telegram.
          const now = Date.now();
          if (now - lastStreamEventMs >= HEARTBEAT_INTERVAL_MS) {
            const beat: ThinkingContent = { type: "thinking", thinking: "" };
            partialContent.push(beat);
            const idx = partialContent.length - 1;
            const msg = makePartial();
            stream.push({ type: "thinking_start", contentIndex: idx, partial: msg });
            stream.push({ type: "thinking_delta", contentIndex: idx, delta: "", partial: msg });
            stream.push({ type: "thinking_end",   contentIndex: idx, content: "", partial: msg });
            lastStreamEventMs = now;
            console.log(`[tmux-cc] heartbeat: emitted empty keepalive`);
          }
        };

        // Helper to close the stream with an error message using progressive content
        const closeStreamWithError = (message: string) => {
          const textBlock: TextContent = { type: "text", text: message };
          partialContent.push(textBlock);
          const idx = partialContent.length - 1;
          const msg = makePartial();
          stream.push({ type: "text_start", contentIndex: idx, partial: msg });
          stream.push({ type: "text_delta", contentIndex: idx, delta: message, partial: msg });
          stream.push({ type: "text_end", contentIndex: idx, content: message, partial: msg });
          stream.push({ type: "done", reason: "stop", message: msg });
        };

        // Build a steering callback that drains the steering queue and
        // types any new messages into the agent's tmux pane.
        const checkSteering = getSteeringMessages
          ? async (): Promise<number> => {
              const msgs = (await getSteeringMessages()) || [];
              if (msgs.length === 0) return 0;
              let injected = 0;
              for (const msg of msgs) {
                const text = extractSteeringText(msg);
                if (text) {
                  console.log(`[tmux-cc] steering: injecting message (${text.length} chars) into ${session.windowName}`);
                  try {
                    if (adapter?.sendMessage) {
                      await adapter.sendMessage(config.tmuxSession, session.windowName, text, sessionKeyName ?? sessionId);
                    } else {
                      await sendKeys(config.tmuxSession, session.windowName, text);
                    }
                    injected++;
                  } catch (e) {
                    console.error(`[tmux-cc] steering: sendKeys failed: ${e instanceof Error ? e.message : e}`);
                  }
                }
              }
              return injected;
            }
          : undefined;

        // Step 8: Poll transcript for response
        let response = await pollForResponse(session, offsetBeforeSend, config, adapter, onNewEntries, () => cancelled, checkSteering);

        // Step 8.5: If agent died (no response), restart and retry once.
        const aliveAfterPoll = adapter
          ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
          : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);
        if (!response && !aliveAfterPoll) {
          console.log(`[tmux-cc] agent died, restarting with --resume`);
          await restartSession(session, config, adapter);

          const aliveAfterRestart = adapter
            ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
            : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);
          if (!aliveAfterRestart) {
            console.error(`[tmux-cc] restart failed, agent still not alive`);
            closeStreamWithError("REDACTEDÔREDACTED Agent process crashed and could not be restarted. Please retry.");
            return;
          }

          // After restart, transcriptPath is reset REDACTED re-record offset
          offsetBeforeSend = 0;

          console.log(`[tmux-cc] re-sending message after restart, length=${finalText.length}`);
          if (adapter?.sendMessage) {
            await adapter.sendMessage(config.tmuxSession, session.windowName, finalText, sessionKeyName ?? sessionId);
          } else {
            await sendKeys(config.tmuxSession, session.windowName, finalText);
          }
          response = await pollForResponse(session, offsetBeforeSend, config, adapter, onNewEntries, () => cancelled, checkSteering);
        }

        if (!response) {
          // If cancelled (e.g. /stop), end stream silently REDACTED the gateway
          // already knows the run was aborted, so emitting an error response
          // would result in a stale/duplicate message to the user.
          if (cancelled) {
            console.log(`[tmux-cc] run aborted (/stop), ending stream with stop confirmation`);
            // Emit explicit "REDACTED Stopped." text so the gateway has visible
            // content to render.  A thinking-only (no-text) response may
            // trigger fallback error messages in some gateway versions.
            const stopText = "REDACTED Stopped.";
            const textBlock: TextContent = { type: "text", text: stopText };
            partialContent.push(textBlock);
            const textIdx = partialContent.length - 1;
            stream.push({ type: "text_start", contentIndex: textIdx, partial: makePartial() });
            stream.push({ type: "text_delta", content: stopText, partial: makePartial() });
            stream.push({ type: "done", reason: "stop", message: makePartial() });
            streamDone = true;
            return;
          }

          const ccAlive = adapter
            ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
            : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);
          if (!ccAlive) {
            console.error(`[tmux-cc] agent crashed, transcriptPath=${session.transcriptPath ?? "null"}, offset=${session.transcriptOffset}`);
            closeStreamWithError("REDACTEDÔREDACTED Agent process crashed. Please retry.");
            await killWindow(config.tmuxSession, session.windowName);
          } else {
            console.error(`[tmux-cc] TIMEOUT after ${config.responseTimeoutMs}ms, transcriptPath=${session.transcriptPath ?? "null"}, offset=${session.transcriptOffset}`);
            closeStreamWithError("REDACTEDÔREDACTED Agent response timed out. Please retry.");
          }
          return;
        }
        console.log(`[tmux-cc] response: textLen=${response.text.length}, complete=${response.isComplete}, sessionId=${response.sessionId ?? "null"}`);

        // Detect rate limit errors in the response text (agent didn't crash
        // but returned an error message from the model provider).
        if (response.text && containsRateLimitError(response.text)) {
          console.log(`[tmux-cc] rate limit detected in response text for model=${session.model}`);
          primaryAdapter?.recordRateLimit?.(session.model);

          // Mid-stream fallback: if we have a fallback adapter and we're
          // currently on the primary, tear down the rate-limited window
          // and retry this same user message via the fallback adapter so
          // the user doesn't have to re-send. Subsequent messages route
          // through the fallback automatically (recordRateLimit sets a
          // cooldown that validateSession observes on the next turn).
          if (fallbackAdapter && adapter === primaryAdapter) {
            const validation = primaryAdapter?.validateSession?.(sessionKeyName ?? sessionId, session.model);
            if (validation && validation.fallback) {
              console.log(`[tmux-cc] mid-stream swap to ${fallbackAdapter.id} model=${validation.fallback}`);
              await deleteSession(sessionKey, config);
              adapter = fallbackAdapter;
              runConfig = { ...config, defaultModel: validation.fallback };
              session = await getOrCreateSession(sessionKey, runConfig.defaultModel, runConfig, adapter, agentAccountId ?? undefined);
              cancelSession = session;
              console.log(`[tmux-cc] fallback session: window=${session.windowName}, model=${session.model}`);
              if (adapter.sendMessage) {
                await adapter.sendMessage(config.tmuxSession, session.windowName, finalText, sessionKeyName ?? sessionId);
              } else {
                await sendKeys(config.tmuxSession, session.windowName, finalText);
              }
              // Re-poll against the fresh session. Start from offset 0 REDACTED
              // updateTranscriptPath will re-discover via the snapshot.
              const retryResponse = await pollForResponse(session, 0, runConfig, adapter, onNewEntries, () => cancelled, checkSteering);
              if (retryResponse?.text) {
                response = retryResponse;
                console.log(`[tmux-cc] mid-stream fallback retry succeeded, textLen=${response.text.length}`);
              } else {
                console.error(`[tmux-cc] mid-stream fallback retry produced no response; emitting original rate-limit error`);
              }
            }
          }
        }

        // Step 9: Emit the response as structured stream close events.
        // `start` was emitted in Step 7.5. Progress text events have been
        // emitted during polling via `onNewEntries` (one text block per CC
        // transcript entry). Only text not already streamed is appended here.

        const finalResponseText = extractUnstreamedFinalText(response.text, streamedTextParts);
        const assistantMessage = makePartial();
        console.log(`[tmux-cc] emitting stream events: stopReason=${assistantMessage.stopReason}, contentBlocks=${assistantMessage.content.length}, thinkingBlocks=${partialContent.filter(b => b.type === "thinking").length}, model=${session.model}`);

        if (finalResponseText) {
          const textBlock: TextContent = { type: "text", text: finalResponseText };
          partialContent.push(textBlock);
          const textContentIndex = partialContent.length - 1;
          const finalMessage = makePartial();

          stream.push({
            type: "text_start",
            contentIndex: textContentIndex,
            partial: finalMessage,
          });
          stream.push({
            type: "text_delta",
            contentIndex: textContentIndex,
            delta: finalResponseText,
            partial: finalMessage,
          });
          stream.push({
            type: "text_end",
            contentIndex: textContentIndex,
            content: finalResponseText,
            partial: finalMessage,
          });
          console.log(`[tmux-cc] pushed: final text events, len=${finalResponseText.length}`);
        } else if (response.text) {
          console.log(`[tmux-cc] skipped duplicate final text already emitted via progressive stream, len=${response.text.length}`);
        }
        stream.push({
          type: "done",
          reason: "stop",
          message: makePartial(),
        });
        console.log(`[tmux-cc] pushed: done REDACTED all stream events emitted`);
        streamDone = true;

        // Track turns and schedule eager cleanup for one-shot sessions
        if (session) {
          session.turnCount++;
          // Only eager-clean sessions with few turns (likely cron one-shots).
          // Multi-turn conversations are kept alive for the full idle timeout.
          if (session.turnCount <= 1) {
            scheduleEagerCleanup(session.sessionKey, config);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error in tmux-cc";
        console.error(`[tmux-cc] run() error:`, err);
        if (streamStarted) {
          closeStreamWithError(`REDACTEDÔREDACTED ${message}`);
        } else {
          emitError(stream, message);
        }
        streamDone = true;
      }
    };

    // Run async without blocking
    run().catch((err) => {
      console.error(`[tmux-cc] UNHANDLED run() rejection:`, err);
    });

    // Diagnostic: wrap [Symbol.asyncIterator] to log event consumption
    const origIter = stream[Symbol.asyncIterator].bind(stream);
    (stream as any)[Symbol.asyncIterator] = function () {
      console.log(`[tmux-cc] DIAG: [Symbol.asyncIterator]() called REDACTED iterator created`);
      const it = origIter();
      let callCount = 0;
      return {
        async next() {
          callCount++;
          console.log(`[tmux-cc] DIAG: next() called #${callCount}`);
          try {
            const result = await it.next();
            const eventType = result.done ? "DONE" : (result.value as any)?.type ?? "unknown";
            console.log(`[tmux-cc] DIAG: next() resolved #${callCount}: done=${result.done}, type=${eventType}`);
            return result;
          } catch (err) {
            console.error(`[tmux-cc] DIAG: next() threw #${callCount}:`, err);
            throw err;
          }
        },
        async return(v?: unknown) {
          console.log(`[tmux-cc] DIAG: return() called REDACTED streamDone=${streamDone}`);
          if (streamDone) {
            // Normal iterator cleanup after stream completed REDACTED don't interrupt CC
            return it.return?.(v) ?? { done: true as const, value: undefined };
          }
          cancelled = true;
          await interruptCC("return()");
          return it.return?.(v) ?? { done: true as const, value: undefined };
        },
        async throw(e?: unknown) {
          console.error(`[tmux-cc] DIAG: throw() called:`, e);
          return it.throw?.(e) ?? { done: true as const, value: undefined };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    };

    return stream;
  };
}

/**
 * Extract new user message text from the context's message array.
 *
 * Finds all UserMessage entries after the last AssistantMessage.
 * Concatenates their text content with double newlines.
 */
export function extractNewUserMessages(messages: Message[]): string | null {
  if (!messages || messages.length === 0) return null;

  // Find the index of the last AssistantMessage
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  // Collect all UserMessages after the last AssistantMessage
  const newUserTexts: string[] = [];
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = extractTextFromUserMessage(msg as UserMessage);
      if (text) {
        newUserTexts.push(text);
      }
    }
  }

  if (newUserTexts.length === 0) return null;
  return newUserTexts.join("\n\n");
}

/**
 * Extract text content from a UserMessage.
 * Handles both string content and structured content arrays.
 */
function extractTextFromUserMessage(msg: UserMessage): string | null {
  if (typeof msg.content === "string") {
    return msg.content || null;
  }

  // Content is an array of TextContent | ImageContent
  const textParts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push((block as TextContent).text);
    }
    // ImageContent blocks are handled separately in processMediaContent
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

/**
 * Process media content (images) in user messages.
 *
 * Saves image data to temp files and returns the combined text
 * with image file path references appended.
 */
function processMediaContent(messages: Message[], workingDirectory: string): string | null {
  const textParts: string[] = [];
  const imagePaths: string[] = [];

  // Find all UserMessages after the last AssistantMessage
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  let hasImages = false;

  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;

    const userMsg = msg as UserMessage;
    if (typeof userMsg.content === "string") {
      textParts.push(userMsg.content);
      continue;
    }

    for (const block of userMsg.content) {
      if (block.type === "text") {
        textParts.push((block as TextContent).text);
      } else if (block.type === "image") {
        hasImages = true;
        const imageBlock = block as ImageContent;
        const imagePath = saveImage(imageBlock, workingDirectory);
        imagePaths.push(imagePath);
      }
    }
  }

  if (!hasImages) return null;

  // Combine text with image references
  const result = [...textParts];
  for (const path of imagePaths) {
    result.push(`[Image attached: ${path}]`);
  }

  return result.join("\n\n");
}

/**
 * Save an image to a temp file in the working directory.
 * Returns a relative path to the saved file.
 */
function saveImage(image: ImageContent, workingDirectory: string): string {
  const imageDir = join(workingDirectory, ".openclaw-images");
  mkdirSync(imageDir, { recursive: true });

  const ext = mimeToExt(image.mimeType);
  const filename = `${randomUUID()}.${ext}`;
  const fullPath = join(imageDir, filename);

  const buffer = Buffer.from(image.data, "base64");
  writeFileSync(fullPath, buffer);

  return `./.openclaw-images/${filename}`;
}

/**
 * Map MIME type to file extension.
 */
function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  return map[mimeType] ?? "bin";
}

/**
 * Extract text content from a steering message (AgentMessage from pi-agent-core).
 *
 * Steering messages may have string content or an array of content blocks.
 */
export function extractSteeringText(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter((b: Record<string, unknown>) => b.type === "text")
      .map((b: Record<string, unknown>) => b.text)
      .join("");
    return text || null;
  }
  return null;
}

/**
 * Return the suffix of the final response that was not already emitted as
 * progressive text blocks. This keeps the final done message complete without
 * duplicating text blocks that downstream session storage concatenates.
 */
export function extractUnstreamedFinalText(finalText: string, streamedTextParts: string[]): string {
  if (!finalText) return "";
  if (streamedTextParts.length === 0) return finalText;

  const streamedText = streamedTextParts.join("\n");
  if (!streamedText) return finalText;
  if (finalText === streamedText) return "";
  if (streamedTextParts.includes(finalText)) return "";
  if (finalText.startsWith(`${streamedText}\n`)) {
    return finalText.slice(streamedText.length + 1);
  }
  if (finalText.startsWith(streamedText)) {
    return finalText.slice(streamedText.length);
  }
  return finalText;
}

/**
 * Regex patterns that indicate a rate limit error in agent pane output.
 * Used to detect when a model provider has throttled requests so we can
 * activate the cooldown fallback.
 */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /overloaded/i,
  /quota exceeded/i,
  /request limit/i,
];

/**
 * Check if a pane content string contains rate limit error indicators.
 */
function containsRateLimitError(content: string): boolean {
  return RATE_LIMIT_PATTERNS.some(re => re.test(content));
}

/**
 * Poll the JSONL transcript for a complete assistant response.
 *
 * Polls at the configured interval until either:
 * - A complete response is found (stop_reason is set)
 * - The timeout is reached
 *
 * The deadline extends whenever new transcript entries appear, so
 * tool-call-heavy responses that produce ongoing activity won't
 * time out prematurely.
 *
 * When {@link checkSteering} is provided (queue mode = "steer"),
 * each poll iteration drains the steering queue and types any new
 * messages directly into the agent's tmux pane so the agent can
 * handle them mid-task without waiting for the stream to end.
 */
async function pollForResponse(
  session: SessionState,
  offsetBeforeSend: number,
  config: Required<TmuxClaudeConfig>,
  adapter?: AgentAdapter,
  onNewEntries?: (allEntries: TranscriptEntry[]) => void,
  isCancelled?: () => boolean,
  checkSteering?: () => Promise<number>,
): Promise<AssistantResponse | null> {
  const startTime = Date.now();
  // Absolute hard cap: never wait longer than this, even if agent is actively processing.
  const ABSOLUTE_HARD_CAP_MS = 45 * 60 * 1000;
  // Idle hard cap: if no transcript activity AND no active processing for this long, give up.
  const IDLE_HARD_CAP_MS = 10 * 60 * 1000;
  // Shorter extension when agent is alive but not actively processing
  // (e.g., waiting for API response, thinking). This prevents premature
  // timeouts while still allowing eventual timeout if truly stuck.
  const ALIVE_IDLE_EXTENSION_MS = 120_000;

  let deadline = Date.now() + config.responseTimeoutMs;
  let currentOffset = offsetBeforeSend;
  let effectiveOffsetBeforeSend = offsetBeforeSend;
  let pollCount = 0;
  let lastLogTime = 0;
  const allEntries: TranscriptEntry[] = [];
  // Track last time we saw real activity (transcript entries, active processing,
  // or pane content changes REDACTED the latter covers long Claude thinking turns
  // where the CLI's status-line timer ticks but no transcript entry is written
  // and isClaudeProcessing occasionally misses the "esc to int" marker).
  let lastActiveTime = Date.now();
  // Hash of the last captured pane content REDACTED used to detect visual activity
  // (spinner/timer ticks, streaming output) when isProcessing is flaky.
  let lastPaneHash: string | null = null;

  // Small initial delay to let Claude Code start processing
  await sleep(500);

  while (Date.now() < deadline && (Date.now() - startTime) < ABSOLUTE_HARD_CAP_MS && (Date.now() - lastActiveTime) < IDLE_HARD_CAP_MS) {
    pollCount++;

    // Check cancellation (e.g. /stop command)
    if (isCancelled?.()) {
      console.log(`[tmux-cc] poll #${pollCount}: cancelled by consumer`);
      // Don't send Escape here REDACTED interruptCC() handles it exactly once
      return null;
    }

    onNewEntries?.(allEntries);

    // Check for steering messages and inject them into the agent's tmux pane.
    // This allows mid-task message handling when queue mode is "steer".
    if (checkSteering) {
      const steered = await checkSteering();
      if (steered > 0) {
        deadline = Date.now() + config.responseTimeoutMs;
      }
    }

    if (!session.transcriptPath) {
      // Try to discover the transcript file
      updateTranscriptPath(session, config.workingDirectory, adapter);
      if (!session.transcriptPath) {
        // Log discovery failures periodically (every 5s)
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log(`[tmux-cc] poll #${pollCount}: transcript not discovered yet, snapshotSize=${session.existingTranscriptPaths?.size ?? "none"}`);
          lastLogTime = now;

          // Check if agent process died before writing any transcript
          const processAlive = adapter
            ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
            : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);
          if (!processAlive) {
            const exitCode = await tmuxReadExitCode(config.tmuxSession, session.windowName);
            const paneContent = await capturePane(config.tmuxSession, session.windowName, 30);
            const crashLog = await readCrashLog(session.windowName, 50);
            console.error(`[tmux-cc] poll #${pollCount}: agent died before transcript. exitCode=${exitCode ?? "unknown"}`);
            if (paneContent) {
              console.error(`[tmux-cc] agent pane content (last 30 lines):\n${paneContent}`);
            }
            if (crashLog && !paneContent) {
              console.error(`[tmux-cc] agent crash log (last 50 lines):\n${crashLog}`);
            }
            // Detect rate limit errors and record cooldown on the adapter
            const diagContent = paneContent || crashLog || '';
            if (diagContent && containsRateLimitError(diagContent)) {
              console.log(`[tmux-cc] poll #${pollCount}: rate limit detected in agent output for model=${session.model}`);
              adapter?.recordRateLimit?.(session.model);
            }
            return null;
          }

          // Handle agent-specific blocking prompts via adapter
          if (adapter) {
            await adapter.handleBlockingPrompts(config.tmuxSession, session.windowName);
          } else {
            // Legacy fallback: check for CC-specific prompts inline
            try {
              const content = await capturePane(config.tmuxSession, session.windowName, 20);
              if (content?.includes("Yes, I accept") && content?.includes("Bypass Permissions")) {
                console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing bypass permissions prompt`);
                await sendTmuxKey(config.tmuxSession, session.windowName, "Down");
                await sleep(300);
                await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
              } else if (content?.includes("Do you want to make this edit")) {
                console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing edit permission prompt`);
                await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
              } else if (content?.includes("I trust this folder")) {
                console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing trust prompt`);
                await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
              } else if (content?.includes("How is Claude doing this session")) {
                console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing feedback survey`);
                await sendTmuxKey(config.tmuxSession, session.windowName, "0");
              } else if (content?.includes("[Pasted text #")) {
                console.log(`[tmux-cc] poll #${pollCount}: pasted text not submitted, sending Enter`);
                await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
              }
            } catch {
              // Ignore errors from prompt check
            }
          }
        }
        await sleep(config.pollingIntervalMs);
        continue;
      }
      console.log(`[tmux-cc] poll #${pollCount}: transcript discovered: ${session.transcriptPath}, offset=${session.transcriptOffset}`);
      // Sync local offset with the offset set by updateTranscriptPath
      // (e.g., snapshot size when reconnecting to a growing file)
      currentOffset = session.transcriptOffset;
      // Also update the effective offset so CC-death re-reads start here
      if (effectiveOffsetBeforeSend === 0 && currentOffset > 0) {
        effectiveOffsetBeforeSend = currentOffset;
      }
    }

    const result = adapter
      ? adapter.readNewEntries(session.transcriptPath, currentOffset)
      : trReadNewEntries(session.transcriptPath, currentOffset);
    currentOffset = result.newOffset;
    session.transcriptOffset = currentOffset;

    if (result.entries.length > 0) {
      // Activity detected REDACTED extend the deadline and reset idle timer
      deadline = Date.now() + config.responseTimeoutMs;
      lastActiveTime = Date.now();
      session.lastActivityMs = Date.now();
      allEntries.push(...result.entries);
      onNewEntries?.(allEntries);

      const entryTypes = result.entries.map(e => e.type).join(",");
      console.log(`[tmux-cc] poll #${pollCount}: ${result.entries.length} new entries [${entryTypes}], offset now=${currentOffset}`);

      const response = adapter
        ? adapter.extractAssistantResponse(result.entries)
        : trExtractResponse(result.entries);

      // Update session ID if discovered
      if (response.sessionId && !session.claudeSessionId) {
        session.claudeSessionId = response.sessionId;
        persistSession(session.sessionKey, response.sessionId, session.model, session.adapter?.id ?? "claude-code");
      }

      if (response.isComplete && response.text) {
        // Before returning, check for last-moment steering messages.
        // If the user sent a message just as the agent finished, inject
        // it so the agent handles it in the same session instead of
        // requiring a separate turn via the agent loop.
        if (checkSteering) {
          const steered = await checkSteering();
          if (steered > 0) {
            console.log(`[tmux-cc] poll #${pollCount}: response was complete but ${steered} steering message(s) injected, continuing poll`);
            deadline = Date.now() + config.responseTimeoutMs;
            continue;
          }
        }
        console.log(`[tmux-cc] poll #${pollCount}: response complete, textLen=${response.text.length}`);
        return response;
      }

      // Fallback: agent wrote stop_reason: null REDACTED check if idle
      if (!response.isComplete && response.text) {
        const stillProcessing = adapter
          ? await adapter.isProcessing(config.tmuxSession, session.windowName)
          : await tmuxIsClaudeProcessing(config.tmuxSession, session.windowName);
        if (!stillProcessing) {
          console.log(`[tmux-cc] poll #${pollCount}: agent not processing, treating as complete. textLen=${response.text.length}`);
          response.isComplete = true;
          return response;
        }
      }
    } else {
      // No new entries REDACTED check if agent finished with stop_reason: null
      if (allEntries.length > 0) {
        const pendingResponse = adapter
          ? adapter.extractAssistantResponse(allEntries)
          : trExtractResponse(allEntries);
        if (pendingResponse.text && !pendingResponse.isComplete) {
          const stillProcessing = adapter
            ? await adapter.isProcessing(config.tmuxSession, session.windowName)
            : await tmuxIsClaudeProcessing(config.tmuxSession, session.windowName);
          if (!stillProcessing) {
            console.log(`[tmux-cc] poll #${pollCount}: no new entries, agent idle with pending text. textLen=${pendingResponse.text.length}`);
            pendingResponse.isComplete = true;
            return pendingResponse;
          }
        }
      }

      // Agent may be stuck at a blocking prompt REDACTED can happen either at the
      // start of a turn (no entries yet) or mid-turn (e.g., an Edit tool call
      // that triggers a permission dialog because the target path is outside
      // the bypass scope). Run the handler unconditionally so mid-turn
      // prompts are dismissed too.
      if (adapter) {
        await adapter.handleBlockingPrompts(config.tmuxSession, session.windowName);
      } else {
        try {
          const content = await capturePane(config.tmuxSession, session.windowName, 20);
          if (content?.includes("[Pasted text #")) {
            console.log(`[tmux-cc] poll #${pollCount}: pasted text not submitted, sending Enter`);
            await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
          } else if (content?.includes("Yes, I accept") && content?.includes("Bypass Permissions")) {
            console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing bypass permissions prompt`);
            await sendTmuxKey(config.tmuxSession, session.windowName, "Down");
            await sleep(300);
            await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
          } else if (content?.includes("Do you want to make this edit")) {
            console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing edit permission prompt`);
            await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
          } else if (content?.includes("I trust this folder")) {
            console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing trust prompt`);
            await sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
          } else if (content?.includes("How is Claude doing this session")) {
            console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing feedback survey`);
            await sendTmuxKey(config.tmuxSession, session.windowName, "0");
          }
        } catch {
          // Ignore errors from prompt check
        }
      }

      // Check if agent exited (window gone or process dead)
      const processAlive = adapter
        ? await adapter.isProcessAlive(config.tmuxSession, session.windowName)
        : await tmuxIsProcessAlive(config.tmuxSession, session.windowName);

      // Agent is alive but producing no new transcript entries REDACTED it may be
      // running a long tool (e.g., a 10-minute build) or waiting for an API
      // response with no child process visible.
      if (processAlive) {
        const stillProcessing = adapter
          ? await adapter.isProcessing(config.tmuxSession, session.windowName)
          : await tmuxIsClaudeProcessing(config.tmuxSession, session.windowName);
        if (stillProcessing) {
          // Extend deadline and reset idle timer REDACTED the agent is actively running a tool
          deadline = Date.now() + config.responseTimeoutMs;
          lastActiveTime = Date.now();
        } else {
          // Agent is alive but isProcessing didn't see the "esc to interrupt"
          // marker this tick. That check is a single-frame grep and is known
          // to miss during long thinking / API waits, so fall back to a
          // pane-content hash: any visual change (spinner tick, thinking
          // timer, streaming output) counts as activity and keeps idleCap
          // from firing on a session that's genuinely still working.
          let paneChanged = false;
          try {
            const pane = await capturePane(config.tmuxSession, session.windowName, 30);
            if (pane) {
              const hash = createHash("sha1").update(pane).digest("hex").slice(0, 16);
              if (lastPaneHash !== null && hash !== lastPaneHash) {
                paneChanged = true;
              }
              lastPaneHash = hash;
            }
          } catch {
            // Ignore capture-pane errors REDACTED we'll fall through to the
            // existing alive-but-idle handling.
          }

          if (paneChanged) {
            deadline = Date.now() + config.responseTimeoutMs;
            lastActiveTime = Date.now();
          } else {
            // Truly idle (pane frozen). Keep the existing short extension
            // so we eventually time out, but don't cut off a slow API call.
            // Only extend when close to expiring (< 30s left) to avoid
            // extending every poll cycle and generating excessive log spam.
            const remainingMs = deadline - Date.now();
            if (remainingMs < 30_000) {
              deadline = Date.now() + ALIVE_IDLE_EXTENSION_MS;
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              console.log(`[tmux-cc] poll #${pollCount}: agent alive but idle, extending deadline by ${ALIVE_IDLE_EXTENSION_MS / 1000}s (elapsed=${elapsed}s)`);
            }
          }
        }
      }

      if (!processAlive) {
        const exitCode = await tmuxReadExitCode(config.tmuxSession, session.windowName);
        const paneContent = await capturePane(config.tmuxSession, session.windowName, 30);
        const crashLog = await readCrashLog(session.windowName, 50);
        console.error(`[tmux-cc] poll #${pollCount}: agent process died. exitCode=${exitCode ?? "unknown"}`);
        if (paneContent) {
          console.error(`[tmux-cc] agent pane content (last 30 lines):\n${paneContent}`);
        }
        if (crashLog && !paneContent) {
          console.error(`[tmux-cc] agent crash log (last 50 lines):\n${crashLog}`);
        }

        // Detect rate limit errors and record cooldown on the adapter
        const diagContent = paneContent || crashLog || '';
        if (diagContent && containsRateLimitError(diagContent)) {
          console.log(`[tmux-cc] poll #${pollCount}: rate limit detected in agent output for model=${session.model}`);
          adapter?.recordRateLimit?.(session.model);
        }

        console.log(`[tmux-cc] re-reading full response from offset ${effectiveOffsetBeforeSend}`);
        const fullResult = adapter
          ? adapter.readNewEntries(session.transcriptPath, effectiveOffsetBeforeSend)
          : trReadNewEntries(session.transcriptPath, effectiveOffsetBeforeSend);
        const response = adapter
          ? adapter.extractAssistantResponse(fullResult.entries, { collectAllText: true })
          : trExtractResponse(fullResult.entries, { collectAllText: true });
        if (response.text && response.isComplete) {
          console.log(`[tmux-cc] poll #${pollCount}: agent died after completing response. textLen=${response.text.length}`);
          return response;
        }
        if (response.text) {
          console.log(`[tmux-cc] poll #${pollCount}: agent died mid-response (incomplete). textLen=${response.text.length}, discarding`);
        } else {
          console.error(`[tmux-cc] poll #${pollCount}: agent died with no response text`);
        }
        return null;
      }
    }

    await sleep(config.pollingIntervalMs);
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const idleMs = Math.round((Date.now() - lastActiveTime) / 1000);
  const hitAbsoluteCap = (Date.now() - startTime) >= ABSOLUTE_HARD_CAP_MS;
  const hitIdleCap = (Date.now() - lastActiveTime) >= IDLE_HARD_CAP_MS;
  const capReason = hitAbsoluteCap ? "absoluteCap" : hitIdleCap ? "idleCap" : "deadline";
  console.error(`[tmux-cc] pollForResponse: TIMEOUT after ${pollCount} polls, elapsed=${totalElapsed}s, idle=${idleMs}s, reason=${capReason}, transcriptPath=${session.transcriptPath ?? "null"}`);
  // Dump pane content on timeout so we can diagnose why the agent went silent
  // (crash path already does this; mirror it here for idleCap/deadline cases).
  try {
    const pane = await capturePane(config.tmuxSession, session.windowName, 30);
    if (pane) {
      console.error(`[tmux-cc] agent pane content at timeout (last 30 lines):\n${pane}`);
    }
  } catch {
    // capturePane may fail if the window is gone; ignore.
  }
  return null;
}

/**
 * Update the transcript path for a session if not already set.
 *
 * When the session has a snapshot of existing files (from createNewSession
 * or reconnect), uses two strategies:
 * 1. Look for a NEW file not in the snapshot (Claude Code created a new session)
 * 2. Look for an EXISTING file whose size grew (Claude Code appended to it)
 *
 * Strategy 2 uses the snapshot's file size as the starting offset so we
 * skip old entries and only read new content.
 */
function updateTranscriptPath(session: SessionState, workingDirectory: string, adapter?: AgentAdapter): void {
  // Strategy 0: when we know the claudeSessionId (resuming a persisted
  // session), look directly for <sessionId>.jsonl.
  // up a transcript created by a *different* CC session that happens to
  // share the same project directory.
  if (session.claudeSessionId) {
    const knownPath = adapter
      ? adapter.findTranscriptBySessionId(workingDirectory, session.claudeSessionId)
      : trFindBySessionId(workingDirectory, session.claudeSessionId);
    if (knownPath) {
      const snapshotSize = session.existingTranscriptPaths?.get(knownPath);
      if (snapshotSize != null) {
        // Known file that existed before REDACTED use snapshot offset to skip old entries
        console.log(`[tmux-cc] updateTranscriptPath: strategy 0 (known sessionId, growing) found: ${knownPath}, snapshotSize=${snapshotSize}`);
        session.transcriptPath = knownPath;
        session.transcriptOffset = snapshotSize;
      } else {
        // File is brand new (not in snapshot) REDACTED read from start
        console.log(`[tmux-cc] updateTranscriptPath: strategy 0 (known sessionId, new) found: ${knownPath}`);
        session.transcriptPath = knownPath;
        session.transcriptOffset = 0;
      }
      session.existingTranscriptPaths = undefined;
      return;
    }
    // Session file doesn't exist yet REDACTED fall through to generic strategies
  }

  if (session.existingTranscriptPaths) {
    // Strategy 1: new file not in snapshot
    const newPath = adapter
      ? adapter.findNewTranscript(workingDirectory, session.existingTranscriptPaths)
      : trFindNew(workingDirectory, session.existingTranscriptPaths);
    if (newPath) {
      console.log(`[tmux-cc] updateTranscriptPath: strategy 1 (new file) found: ${newPath}`);
      session.transcriptPath = newPath;
      session.transcriptOffset = 0;
      if (!session.claudeSessionId) {
        session.claudeSessionId = adapter
          ? adapter.extractSessionId(newPath)
          : trExtractSessionId(newPath);
        if (session.claudeSessionId) {
          persistSession(session.sessionKey, session.claudeSessionId, session.model, session.adapter?.id ?? "claude-code");
        }
      }
      session.existingTranscriptPaths = undefined;
      return;
    }

    // Strategy 2: existing file whose size grew since snapshot
    const growing = adapter
      ? adapter.findGrowingTranscript(workingDirectory, session.existingTranscriptPaths)
      : trFindGrowing(workingDirectory, session.existingTranscriptPaths);
    if (growing) {
      console.log(`[tmux-cc] updateTranscriptPath: strategy 2 (growing file) found: ${growing.path}, snapshotSize=${growing.snapshotSize}`);
      session.transcriptPath = growing.path;
      session.transcriptOffset = growing.snapshotSize;
      if (!session.claudeSessionId) {
        session.claudeSessionId = adapter
          ? adapter.extractSessionId(growing.path)
          : trExtractSessionId(growing.path);
        if (session.claudeSessionId) {
          persistSession(session.sessionKey, session.claudeSessionId, session.model, session.adapter?.id ?? "claude-code");
        }
      }
      session.existingTranscriptPaths = undefined;
      return;
    }

    // Neither found yet REDACTED keep waiting for agent to start writing
    return;
  }

  // Normal case (no snapshot): use latest file
  const path = adapter
    ? adapter.findLatestTranscript(workingDirectory)
    : trFindLatest(workingDirectory);
  if (path) {
    console.log(`[tmux-cc] updateTranscriptPath: no snapshot, using latest: ${path}`);
    session.transcriptPath = path;
    if (!session.claudeSessionId) {
      session.claudeSessionId = adapter
        ? adapter.extractSessionId(path)
        : trExtractSessionId(path);
      if (session.claudeSessionId) {
        persistSession(session.sessionKey, session.claudeSessionId, session.model, session.adapter?.id ?? "claude-code");
      }
    }
  }
}

/**
 * Build an AssistantMessage from response.
 * Includes thinking content when present.
 */
function buildAssistantMessage(response: AssistantResponse, model?: string, provider?: string): AssistantMessage {
  const content: AssistantMessage["content"] = [];

  if (response.thinking) {
    content.push({ type: "thinking", thinking: response.thinking });
  }
  content.push({ type: "text", text: response.text });

  return {
    role: "assistant",
    content,
    api: "anthropic-v1",
    provider: provider ?? "tmux-cc",
    model: model ?? "claude-code",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Emit a normal text response with an error message.
 * Unlike emitError(), this emits a regular assistant response so the gateway
 * treats it as a successful run and releases the CommandLane slot.
 * Use for errors that would otherwise permanently block the session lane.
 */
function emitTextResponse(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: string,
): void {
  const response: AssistantResponse = {
    text: `REDACTEDÔREDACTED ${message}`,
    isComplete: true,
  };
  const assistantMessage = buildAssistantMessage(response);
  stream.push({ type: "start", partial: assistantMessage });
  stream.push({ type: "text_start", contentIndex: 0, partial: assistantMessage });
  stream.push({ type: "text_delta", content: response.text, partial: assistantMessage });
  stream.push({ type: "done", reason: "stop", message: assistantMessage });
}

/**
 * Emit an error event on the stream.
 */
function emitError(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: string,
): void {
  const errorMessage = buildAssistantMessage(message);
  errorMessage.stopReason = "error";
  errorMessage.errorMessage = message;

  stream.push({
    type: "error",
    reason: "error",
    error: errorMessage,
  });
}

/** Async sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Strip OpenClaw bootstrap truncation warnings from user message text.
 *
 * Claude Code manages its own context files (CLAUDE.md, MEMORY.md, etc.)
 * directly, so these warnings are misleading and waste context tokens.
 */
const BOOTSTRAP_WARNING_RE =
  /\[Bootstrap truncation warning\][\s\S]*?(?:agents\.defaults\.bootstrapTotalMaxChars\.\s*)/g;

export function stripBootstrapWarnings(text: string): string {
  return text.replace(BOOTSTRAP_WARNING_RE, "").trim();
}

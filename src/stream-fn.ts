import { createHash, randomUUID } from "node:crypto";
/**
 * Custom StreamFn implementation for the tmux-cc provider.
 *
 * This StreamFn extracts new user messages from OpenClaw's context,
 * sends them to Claude Code via tmux send-keys, polls the JSONL
 * transcript for the response, and emits AssistantMessageEventStream events.
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
  UserMessage,
} from "@mariozechner/pi-ai";
import { getOrCreateSession, restartSession } from "./session-map.js";
import { persistSession } from "./session-persistence.js";
import { sendKeys, sendTmuxKey, isProcessAlive, isWindowReady, isClaudeProcessing, capturePane, readExitCode, killWindow, readCrashLog, cleanupCrashLog } from "./tmux-manager.js";
import {
  readNewEntries,
  extractAssistantResponse,
  findLatestTranscript,
  findNewTranscript,
  findGrowingTranscript,
  extractSessionId,
} from "./transcript-reader.js";
import type { TmuxClaudeConfig, SessionState, AssistantResponse } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface StreamFnOptions {
  /** Plugin configuration. */
  config: TmuxClaudeConfig;
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

  return (_model: unknown, context: Context, options?: { sessionId?: string }) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        // Step 1: Derive a stable session key from the conversation
        const sessionKey = deriveSessionKey(context.messages, options?.sessionId);
        console.log(`[tmux-cc] run: sessionKey=${sessionKey}, messageCount=${context.messages.length}, sessionId=${options?.sessionId ?? "none"}`);

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

        // Step 4: Get or create the Claude Code session
        const session = getOrCreateSession(sessionKey, config.defaultModel, config);
        console.log(`[tmux-cc] session: window=${session.windowName}, transcriptPath=${session.transcriptPath ?? "null"}, claudeSessionId=${session.claudeSessionId ?? "null"}, snapshotSize=${session.existingTranscriptPaths?.size ?? "none"}`);


        // Step 5: Ensure Claude Code process is alive
        if (!isProcessAlive(config.tmuxSession, session.windowName)) {
          console.error(`[tmux-cc] process not alive in window=${session.windowName}`);
          // Session will be restarted by getOrCreateSession on next call
          emitTextResponse(stream, "REDACTEDÔREDACTED Claude Code process failed to start. Please retry.");
          return;
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


        // Step 7: Send message via tmux
        console.log(`[tmux-cc] sendKeys: length=${finalText.length}`);
        try {
          sendKeys(config.tmuxSession, session.windowName, finalText);
        } catch (e) {
          // Window may have been killed between isProcessAlive check and sendKeys
          console.error(`[tmux-cc] sendKeys failed: ${e instanceof Error ? e.message : e}`);
          emitTextResponse(stream, "REDACTEDÔREDACTED Claude Code session is unavailable. Please retry.");
          killWindow(config.tmuxSession, session.windowName);
          return;
        }

        // Step 8: Poll JSONL transcript for response
        let response = await pollForResponse(session, offsetBeforeSend, config);

        // Step 8.5: If CC died (no response or incomplete response), restart and retry once.
        // This prevents the gateway's CommandLane from getting permanently
        // stuck (gateway bug: lane slot not released on embedded run error).
        if (!response && !isProcessAlive(config.tmuxSession, session.windowName)) {
          console.log(`[tmux-cc] CC died, restarting with --resume`);
          restartSession(session, config);

          if (!isProcessAlive(config.tmuxSession, session.windowName)) {
            console.error(`[tmux-cc] restart failed, CC still not alive`);
            emitTextResponse(stream, "Claude Code process crashed and could not be restarted. Please retry.");
            return;
          }

          // After restart, transcriptPath is reset REDACTED re-record offset
          offsetBeforeSend = 0;

          console.log(`[tmux-cc] re-sending message after restart, length=${finalText.length}`);
          sendKeys(config.tmuxSession, session.windowName, finalText);

          response = await pollForResponse(session, offsetBeforeSend, config);
        }

        if (!response) {
          const ccAlive = isProcessAlive(config.tmuxSession, session.windowName);
          if (!ccAlive) {
            console.error(`[tmux-cc] CC crashed, transcriptPath=${session.transcriptPath ?? "null"}, offset=${session.transcriptOffset}`);
            emitTextResponse(stream, "Claude Code process crashed. Please retry.");
            killWindow(config.tmuxSession, session.windowName);
          } else {
            console.error(`[tmux-cc] TIMEOUT after ${config.responseTimeoutMs}ms, transcriptPath=${session.transcriptPath ?? "null"}, offset=${session.transcriptOffset}`);
            emitTextResponse(stream, "Claude Code response timed out. Please retry.");
          }
          return;
        }
        console.log(`[tmux-cc] response: textLen=${response.text.length}, complete=${response.isComplete}, sessionId=${response.sessionId ?? "null"}`);



        // Step 9: Emit the response as events
        const assistantMessage = buildAssistantMessage(response);
        console.log(`[tmux-cc] emitting stream events: stopReason=${assistantMessage.stopReason}, contentBlocks=${assistantMessage.content.length}`);

        stream.push({ type: "start", partial: assistantMessage });
        console.log(`[tmux-cc] pushed: start`);

        // Emit thinking events first (if present)
        let contentIndex = 0;
        if (response.thinking) {
          stream.push({
            type: "thinking_start",
            contentIndex,
            partial: assistantMessage,
          });
          stream.push({
            type: "thinking_delta",
            contentIndex,
            delta: response.thinking,
            partial: assistantMessage,
          });
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: response.thinking,
            partial: assistantMessage,
          });
          contentIndex++;
          console.log(`[tmux-cc] pushed: thinking events`);
        }

        // Emit text events
        stream.push({
          type: "text_start",
          contentIndex,
          partial: assistantMessage,
        });
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: response.text,
          partial: assistantMessage,
        });
        stream.push({
          type: "text_end",
          contentIndex,
          content: response.text,
          partial: assistantMessage,
        });
        console.log(`[tmux-cc] pushed: text events`);
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
        console.log(`[tmux-cc] pushed: done REDACTED all stream events emitted`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error in tmux-cc";
        console.error(`[tmux-cc] run() error:`, err);
        emitError(stream, message);
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
          console.log(`[tmux-cc] DIAG: return() called`);
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
 * Poll the JSONL transcript for a complete assistant response.
 *
 * Polls at the configured interval until either:
 * - A complete response is found (stop_reason is set)
 * - The timeout is reached
 *
 * The deadline extends whenever new transcript entries appear, so
 * tool-call-heavy responses that produce ongoing activity won't
 * time out prematurely.
 */
async function pollForResponse(
  session: SessionState,
  offsetBeforeSend: number,
  config: Required<TmuxClaudeConfig>,
): Promise<AssistantResponse | null> {
  let deadline = Date.now() + config.responseTimeoutMs;
  let currentOffset = offsetBeforeSend;
  // Track the actual offset at which we first saw entries after the send.
  // When transcriptPath is undefined at send time, offsetBeforeSend is 0
  // but discovery may set a higher initial offset (e.g., snapshot size for
  // --resume files). We capture that so CC-death re-reads only cover the
  // current turn, not the entire file.
  let effectiveOffsetBeforeSend = offsetBeforeSend;
  let pollCount = 0;
  let lastLogTime = 0;

  // Small initial delay to let Claude Code start processing
  await sleep(500);

  while (Date.now() < deadline) {
    pollCount++;

    if (!session.transcriptPath) {
      // Try to discover the transcript file
      updateTranscriptPath(session, config.workingDirectory);
      if (!session.transcriptPath) {
        // Log discovery failures periodically (every 5s)
        const now = Date.now();
        if (now - lastLogTime > 5000) {
          console.log(`[tmux-cc] poll #${pollCount}: transcript not discovered yet, snapshotSize=${session.existingTranscriptPaths?.size ?? "none"}`);
          lastLogTime = now;

          // Check if CC process died before writing any transcript
          if (!isProcessAlive(config.tmuxSession, session.windowName)) {
            const exitCode = readExitCode(config.tmuxSession, session.windowName);
            const paneContent = capturePane(config.tmuxSession, session.windowName, 30);
            const crashLog = readCrashLog(session.windowName, 50);
            console.error(`[tmux-cc] poll #${pollCount}: CC died before transcript. exitCode=${exitCode ?? "unknown"}`);
            if (paneContent) {
              console.error(`[tmux-cc] CC pane content (last 30 lines):\n${paneContent}`);
            }
            if (crashLog && !paneContent) {
              console.error(`[tmux-cc] CC crash log (last 50 lines):\n${crashLog}`);
            }
            return null;
          }

          // CC may be stuck on bypass permissions or trust prompt after waitForReady timeout
          try {
            const content = capturePane(config.tmuxSession, session.windowName, 20);
            if (content?.includes("Yes, I accept") && content?.includes("Bypass Permissions")) {
              console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing bypass permissions prompt`);
              sendTmuxKey(config.tmuxSession, session.windowName, "Down");
              await sleep(300);
              sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
            } else if (content?.includes("I trust this folder")) {
              console.log(`[tmux-cc] poll #${pollCount}: auto-dismissing trust prompt`);
              sendTmuxKey(config.tmuxSession, session.windowName, "Enter");
            }
          } catch {
            // Ignore errors from prompt check
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

    const result = readNewEntries(session.transcriptPath, currentOffset);
    currentOffset = result.newOffset;
    session.transcriptOffset = currentOffset;

    if (result.entries.length > 0) {
      // Activity detected REDACTED extend the deadline so long-running tool-call
      // chains don't time out while Claude Code is still making progress.
      deadline = Date.now() + config.responseTimeoutMs;
      // Also update lastActivityMs so idle cleanup won't kill this session
      session.lastActivityMs = Date.now();

      const entryTypes = result.entries.map(e => e.type).join(",");
      console.log(`[tmux-cc] poll #${pollCount}: ${result.entries.length} new entries [${entryTypes}], offset now=${currentOffset}`);

      const response = extractAssistantResponse(result.entries);

      // Update session ID if discovered
      if (response.sessionId && !session.claudeSessionId) {
        session.claudeSessionId = response.sessionId;
        // Persist to disk so we can resume after gateway + window restart
        persistSession(session.sessionKey, response.sessionId, session.model);
      }

      if (response.isComplete && response.text) {
        console.log(`[tmux-cc] poll #${pollCount}: response complete, textLen=${response.text.length}`);
        return response;
      }

      // Fallback: Claude Code sometimes writes stop_reason: null even
      // for final responses. Check the tmux pane status line REDACTED if Claude
      // Code is NOT actively processing (no "esc to interrupt" visible),
      // treat the current text as the final response.
      // Note: REDACTED is always visible in Claude Code's TUI, so we cannot
      // use isWindowReady() for idle detection.
      if (!response.isComplete && response.text) {
        if (!isClaudeProcessing(config.tmuxSession, session.windowName)) {
          console.log(`[tmux-cc] poll #${pollCount}: CC not processing, treating as complete. textLen=${response.text.length}`);
          response.isComplete = true;
          return response;
        }
      }
    } else {
      // No new entries REDACTED check if Claude Code exited (window gone or
      // process dead).  When it exits mid-turn the transcript stops
      // growing, so we'd otherwise spin here until the timeout.
      if (!isProcessAlive(config.tmuxSession, session.windowName)) {
        // Capture crash diagnostics before anything else
        const exitCode = readExitCode(config.tmuxSession, session.windowName);
        const paneContent = capturePane(config.tmuxSession, session.windowName, 30);
        const crashLog = readCrashLog(session.windowName, 50);
        console.error(`[tmux-cc] poll #${pollCount}: CC process died. exitCode=${exitCode ?? "unknown"}`);
        if (paneContent) {
          console.error(`[tmux-cc] CC pane content (last 30 lines):\n${paneContent}`);
        }
        if (crashLog && !paneContent) {
          console.error(`[tmux-cc] CC crash log (last 50 lines):\n${crashLog}`);
        }

        console.log(`[tmux-cc] re-reading full response from offset ${effectiveOffsetBeforeSend}`);
        // Re-read ALL entries since the message was sent to capture
        // any partial assistant text written before the exit.
        // Use collectAllText to gather text from ALL assistant entries,
        // not just the last one (which might be a tool_use with no text).
        const fullResult = readNewEntries(session.transcriptPath, effectiveOffsetBeforeSend);
        const response = extractAssistantResponse(fullResult.entries, { collectAllText: true });
        if (response.text && response.isComplete) {
          // CC completed its response (has stop_reason) then exited REDACTED valid response
          console.log(`[tmux-cc] poll #${pollCount}: CC died after completing response. textLen=${response.text.length}`);
          return response;
        }
        if (response.text) {
          // CC died mid-response (no stop_reason) REDACTED treat as crash, return null to trigger retry
          console.log(`[tmux-cc] poll #${pollCount}: CC died mid-response (incomplete). textLen=${response.text.length}, discarding`);
        } else {
          console.error(`[tmux-cc] poll #${pollCount}: CC died with no response text`);
        }
        return null;
      }
    }

    await sleep(config.pollingIntervalMs);
  }

  console.error(`[tmux-cc] pollForResponse: TIMEOUT after ${pollCount} polls, transcriptPath=${session.transcriptPath ?? "null"}`);
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
function updateTranscriptPath(session: SessionState, workingDirectory: string): void {
  if (session.existingTranscriptPaths) {
    // Strategy 1: new file not in snapshot
    const newPath = findNewTranscript(workingDirectory, session.existingTranscriptPaths);
    if (newPath) {
      console.log(`[tmux-cc] updateTranscriptPath: strategy 1 (new file) found: ${newPath}`);
      session.transcriptPath = newPath;
      session.transcriptOffset = 0;
      if (!session.claudeSessionId) {
        session.claudeSessionId = extractSessionId(newPath);
        if (session.claudeSessionId) {
          persistSession(session.sessionKey, session.claudeSessionId, session.model);
        }
      }
      session.existingTranscriptPaths = undefined;
      return;
    }

    // Strategy 2: existing file whose size grew since snapshot
    const growing = findGrowingTranscript(workingDirectory, session.existingTranscriptPaths);
    if (growing) {
      console.log(`[tmux-cc] updateTranscriptPath: strategy 2 (growing file) found: ${growing.path}, snapshotSize=${growing.snapshotSize}`);
      session.transcriptPath = growing.path;
      session.transcriptOffset = growing.snapshotSize;
      if (!session.claudeSessionId) {
        session.claudeSessionId = extractSessionId(growing.path);
        if (session.claudeSessionId) {
          persistSession(session.sessionKey, session.claudeSessionId, session.model);
        }
      }
      session.existingTranscriptPaths = undefined;
      return;
    }

    // Neither found yet REDACTED keep waiting for Claude Code to start writing
    return;
  }

  // Normal case (no snapshot): use latest file
  const path = findLatestTranscript(workingDirectory);
  if (path) {
    console.log(`[tmux-cc] updateTranscriptPath: no snapshot, using latest: ${path}`);
    session.transcriptPath = path;
    if (!session.claudeSessionId) {
      session.claudeSessionId = extractSessionId(path);
      if (session.claudeSessionId) {
        persistSession(session.sessionKey, session.claudeSessionId, session.model);
      }
    }
  }
}

/**
 * Build an AssistantMessage from response.
 * Includes thinking content when present.
 */
function buildAssistantMessage(response: AssistantResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];

  if (response.thinking) {
    content.push({ type: "thinking", thinking: response.thinking });
  }
  content.push({ type: "text", text: response.text });

  return {
    role: "assistant",
    content,
    api: "anthropic-v1",
    provider: "tmux-cc",
    model: "claude-code",
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

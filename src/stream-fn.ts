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
import { getOrCreateSession } from "./session-map.js";
import { persistSession } from "./session-persistence.js";
import { sendKeys, isProcessAlive, isWindowReady, isClaudeProcessing } from "./tmux-manager.js";
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

        // Step 2: Extract new user message(s) from context
        const userText = extractNewUserMessages(context.messages);
        if (!userText) {
          emitError(stream, "No new user message found in context");
          return;
        }

        // Step 3: Handle image attachments
        const processedText = processMediaContent(context.messages, config.workingDirectory);
        const rawText = processedText || userText;

        // Step 3.5: Strip OpenClaw bootstrap warnings REDACTED Claude Code manages
        // its own context files (CLAUDE.md, MEMORY.md) directly.
        const finalText = stripBootstrapWarnings(rawText);

        // Step 4: Get or create the Claude Code session
        const session = getOrCreateSession(sessionKey, config.defaultModel, config);


        // Step 5: Ensure Claude Code process is alive
        if (!isProcessAlive(config.tmuxSession, session.windowName)) {
          // Session will be restarted by getOrCreateSession on next call
          emitError(stream, "Claude Code process is not running");
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


        // Step 7: Send message via tmux
        sendKeys(config.tmuxSession, session.windowName, finalText);

        // Step 8: Poll JSONL transcript for response
        const response = await pollForResponse(session, offsetBeforeSend, config);

        if (!response) {
          emitError(stream, "Timeout waiting for Claude Code response");
          return;
        }


        // Step 9: Emit the response as events
        const assistantMessage = buildAssistantMessage(response);

        stream.push({ type: "start", partial: assistantMessage });

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
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error in tmux-cc";
        emitError(stream, message);
      }
    };

    // Run async without blocking
    void run();
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

  // Small initial delay to let Claude Code start processing
  await sleep(500);

  while (Date.now() < deadline) {
    if (!session.transcriptPath) {
      // Try to discover the transcript file
      updateTranscriptPath(session, config.workingDirectory);
      if (!session.transcriptPath) {
        await sleep(config.pollingIntervalMs);
        continue;
      }
      // Sync local offset with the offset set by updateTranscriptPath
      // (e.g., snapshot size when reconnecting to a growing file)
      currentOffset = session.transcriptOffset;
    }

    const result = readNewEntries(session.transcriptPath, currentOffset);
    currentOffset = result.newOffset;
    session.transcriptOffset = currentOffset;

    if (result.entries.length > 0) {
      // Activity detected REDACTED extend the deadline so long-running tool-call
      // chains don't time out while Claude Code is still making progress.
      deadline = Date.now() + config.responseTimeoutMs;

      const response = extractAssistantResponse(result.entries);


      // Update session ID if discovered
      if (response.sessionId && !session.claudeSessionId) {
        session.claudeSessionId = response.sessionId;
        // Persist to disk so we can resume after gateway + window restart
        persistSession(session.sessionKey, response.sessionId, session.model);
      }

      if (response.isComplete && response.text) {
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
          response.isComplete = true;
          return response;
        }
      }
    }

    await sleep(config.pollingIntervalMs);
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
function updateTranscriptPath(session: SessionState, workingDirectory: string): void {
  if (session.existingTranscriptPaths) {
    // Strategy 1: new file not in snapshot
    const newPath = findNewTranscript(workingDirectory, session.existingTranscriptPaths);
    if (newPath) {
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

#!/usr/bin/env node
/**
 * MCP Tools Server for the tmux-cc provider plugin.
 *
 * Exposes OpenClaw's agent tools (sessions_send, message, cron, etc.)
 * to Claude Code via the Model Context Protocol (stdio transport).
 *
 * IMPORTANT: All tool names, descriptions, and output text must NOT
 * contain "openclaw" or any OpenClaw branding (anti-fingerprinting).
 *
 * This script is started by Claude Code as an MCP server subprocess.
 * It shells out to the `openclaw` CLI to implement tool operations.
 */
import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLI_COMMAND = process.env.GATEWAY_CLI_COMMAND ?? "openclaw";
const CLI_TIMEOUT_MS = 30_000;

/**
 * Execute an openclaw CLI command and return the output.
 */
function runCli(args: string[]): string {
  const cmd = [CLI_COMMAND, ...args].join(" ");
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: CLI_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`CLI command failed: ${message}`);
  }
}

/**
 * Create and configure the MCP server with all tools.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "gateway-tools",
    version: "1.0.0",
  });

  // --- send_session_message ---
  server.tool(
    "send_session_message",
    "Send a message into another conversation session. Use sessionKey or label to target the session.",
    {
      sessionKey: z.string().optional().describe("Target session key (exact match)"),
      label: z.string().optional().describe("Target session label (fuzzy match)"),
      message: z.string().describe("The message text to send"),
    },
    async ({ sessionKey, label, message }) => {
      const args = ["sessions", "send"];
      if (sessionKey) args.push("--session-key", sessionKey);
      if (label) args.push("--label", label);
      args.push("--message", message);

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output || "Message sent." }] };
    },
  );

  // --- list_sessions ---
  server.tool(
    "list_sessions",
    "List active conversation sessions with optional filters.",
    {
      limit: z.number().optional().describe("Maximum number of sessions to return"),
      label: z.string().optional().describe("Filter by session label"),
    },
    async ({ limit, label }) => {
      const args = ["sessions", "list", "--output", "json"];
      if (limit) args.push("--limit", String(limit));
      if (label) args.push("--label", label);

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // --- session_history ---
  server.tool(
    "session_history",
    "Fetch message history for a conversation session.",
    {
      sessionKey: z.string().optional().describe("Target session key"),
      label: z.string().optional().describe("Target session label"),
      limit: z.number().optional().describe("Maximum number of messages to return"),
    },
    async ({ sessionKey, label, limit }) => {
      const args = ["sessions", "history"];
      if (sessionKey) args.push("--session-key", sessionKey);
      if (label) args.push("--label", label);
      if (limit) args.push("--limit", String(limit));
      args.push("--output", "json");

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // --- send_channel_message ---
  server.tool(
    "send_channel_message",
    "Send a message to a channel (Telegram, Discord, Slack, etc.).",
    {
      channel: z.string().describe("Channel name (e.g., telegram, discord, slack)"),
      chatId: z.string().describe("Chat/group/channel ID to send to"),
      message: z.string().describe("The message text to send"),
      replyTo: z.string().optional().describe("Message ID to reply to (for threaded replies)"),
    },
    async ({ channel, chatId, message, replyTo }) => {
      const args = ["message", "send"];
      args.push("--channel", channel);
      args.push("--chat-id", chatId);
      args.push("--message", message);
      if (replyTo) args.push("--reply-to", replyTo);

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output || "Message sent." }] };
    },
  );

  // --- manage_cron ---
  server.tool(
    "manage_cron",
    "Manage scheduled tasks (cron jobs). Supports list, add, remove, run, and status actions.",
    {
      action: z
        .enum(["list", "add", "remove", "run", "status"])
        .describe("The cron action to perform"),
      name: z.string().optional().describe("Cron job name (for add/remove/run)"),
      schedule: z.string().optional().describe("Cron schedule expression (for add)"),
      command: z.string().optional().describe("Command or message to execute (for add)"),
    },
    async ({ action, name, schedule, command }) => {
      const args = ["cron", action];
      if (name) args.push("--name", name);
      if (schedule) args.push("--schedule", schedule);
      if (command) args.push("--command", command);
      args.push("--output", "json");

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // --- generate_image ---
  server.tool(
    "generate_image",
    "Generate images using the configured image generation model.",
    {
      prompt: z.string().describe("Image generation prompt"),
      model: z.string().optional().describe("Image model to use"),
      size: z.string().optional().describe("Image size (e.g., 1024x1024)"),
    },
    async ({ prompt, model, size }) => {
      const args = ["image", "generate"];
      args.push("--prompt", prompt);
      if (model) args.push("--model", model);
      if (size) args.push("--size", size);

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // --- text_to_speech ---
  server.tool(
    "text_to_speech",
    "Convert text to speech audio. The audio is delivered through the messaging channel.",
    {
      text: z.string().describe("Text to convert to speech"),
      voice: z.string().optional().describe("Voice to use for synthesis"),
    },
    async ({ text, voice }) => {
      const args = ["tts"];
      args.push("--text", text);
      if (voice) args.push("--voice", voice);

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output || "Speech generated." }] };
    },
  );

  return server;
}

/**
 * Start the MCP server with stdio transport.
 * Called when this script is executed directly by Claude Code.
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

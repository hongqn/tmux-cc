#!/usr/bin/env node
/**
 * MCP Tools Server for the tmux-cc provider plugin.
 *
 * Exposes gateway agent tools to Claude Code via the Model Context Protocol
 * (stdio transport). Tool names and schemas match the native agent tool
 * surface so that bundled skills work without adaptation.
 *
 * IMPORTANT: All tool names, descriptions, and output text must NOT
 * contain "openclaw" or any OpenClaw branding (anti-fingerprinting).
 *
 * This script is started by Claude Code as an MCP server subprocess.
 * It shells out to the gateway CLI to implement tool operations.
 */
import { execSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLI_COMMAND = process.env.GATEWAY_CLI_COMMAND ?? "openclaw";
const CLI_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 120_000;

/**
 * Execute a gateway CLI command and return the output.
 */
function runCli(args: string[], timeoutMs = CLI_TIMEOUT_MS): string {
  const cmd = [CLI_COMMAND, ...args].join(" ");
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`CLI command failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// message REDACTED multi-action channel messaging tool
// ---------------------------------------------------------------------------

function registerMessageTool(server: McpServer) {
  server.tool(
    "message",
    "Send and manage messages across configured channels (Telegram, Discord, Slack, WhatsApp, Signal, etc.). Use 'action' to choose the operation.",
    {
      action: z
        .enum([
          "send",
          "broadcast",
          "react",
          "edit",
          "delete",
          "read",
          "pin",
          "unpin",
          "pins",
          "poll",
        ])
        .describe("Message action to perform"),
      channel: z.string().optional().describe("Channel provider (telegram, discord, slack, etc.)"),
      target: z
        .string()
        .optional()
        .describe(
          "Channel destination REDACTED E.164 phone, Telegram chatId, Discord channel:<id> or user:<id>, etc.",
        ),
      accountId: z.string().optional().describe("Channel account id (for multi-account setups)"),
      message: z.string().optional().describe("Message body text"),
      messageId: z
        .string()
        .optional()
        .describe("Message id (required for react/edit/delete/pin/unpin)"),
      media: z
        .string()
        .optional()
        .describe("Attach media (image/audio/video/document) REDACTED local path or URL"),
      replyTo: z.string().optional().describe("Reply-to message id"),
      threadId: z.string().optional().describe("Thread id (Telegram forum thread)"),
      emoji: z
        .string()
        .optional()
        .describe("Emoji for reactions (action=react). Omit to remove reaction."),
      removeReaction: z.boolean().optional().describe("Remove reaction instead of adding"),
      silent: z
        .boolean()
        .optional()
        .describe("Send silently without notification (Telegram + Discord)"),
      buttons: z
        .string()
        .optional()
        .describe("Telegram inline keyboard buttons as JSON string"),
      components: z.string().optional().describe("Discord components payload as JSON string"),
      card: z.string().optional().describe("Adaptive Card JSON string"),
      interactive: z
        .string()
        .optional()
        .describe("Shared interactive payload as JSON (buttons/selects)"),
      forceDocument: z
        .boolean()
        .optional()
        .describe("Send as document to avoid Telegram compression"),
      gifPlayback: z
        .boolean()
        .optional()
        .describe("Treat video as GIF playback (WhatsApp only)"),
      pollQuestion: z.string().optional().describe("Poll question (action=poll)"),
      pollOptions: z
        .array(z.string())
        .optional()
        .describe("Poll options, 2-12 choices (action=poll)"),
      pollMulti: z.boolean().optional().describe("Allow multiple poll selections"),
      pollAnonymous: z.boolean().optional().describe("Anonymous poll (Telegram)"),
      limit: z.number().optional().describe("Result limit (action=read/pins/reactions)"),
      dryRun: z.boolean().optional().describe("Preview action without executing"),
    },
    async (params) => {
      const { action } = params;
      const args = ["message", action];

      if (params.channel) args.push("--channel", params.channel);
      if (params.target) args.push("--target", params.target);
      if (params.accountId) args.push("--account", params.accountId);
      if (params.dryRun) args.push("--dry-run");
      args.push("--json");

      switch (action) {
        case "send":
          if (params.message) args.push("--message", params.message);
          if (params.media) args.push("--media", params.media);
          if (params.replyTo) args.push("--reply-to", params.replyTo);
          if (params.threadId) args.push("--thread-id", params.threadId);
          if (params.silent) args.push("--silent");
          if (params.buttons) args.push("--buttons", params.buttons);
          if (params.components) args.push("--components", params.components);
          if (params.card) args.push("--card", params.card);
          if (params.interactive) args.push("--interactive", params.interactive);
          if (params.forceDocument) args.push("--force-document");
          if (params.gifPlayback) args.push("--gif-playback");
          break;

        case "broadcast":
          if (params.message) args.push("--message", params.message);
          if (params.media) args.push("--media", params.media);
          if (params.silent) args.push("--silent");
          if (params.buttons) args.push("--buttons", params.buttons);
          if (params.components) args.push("--components", params.components);
          if (params.card) args.push("--card", params.card);
          if (params.interactive) args.push("--interactive", params.interactive);
          break;

        case "react":
          if (params.messageId) args.push("--message-id", params.messageId);
          if (params.emoji) args.push("--emoji", params.emoji);
          if (params.removeReaction) args.push("--remove");
          break;

        case "edit":
          if (params.messageId) args.push("--message-id", params.messageId);
          if (params.message) args.push("--message", params.message);
          if (params.threadId) args.push("--thread-id", params.threadId);
          break;

        case "delete":
          if (params.messageId) args.push("--message-id", params.messageId);
          break;

        case "read":
          if (params.limit) args.push("--limit", String(params.limit));
          break;

        case "pin":
        case "unpin":
          if (params.messageId) args.push("--message-id", params.messageId);
          break;

        case "pins":
          if (params.limit) args.push("--limit", String(params.limit));
          break;

        case "poll":
          if (params.pollQuestion) args.push("--poll-question", params.pollQuestion);
          if (params.pollOptions) {
            for (const opt of params.pollOptions) args.push("--poll-option", opt);
          }
          if (params.pollMulti) args.push("--poll-multi");
          if (params.pollAnonymous) args.push("--poll-anonymous");
          if (params.message) args.push("--message", params.message);
          if (params.silent) args.push("--silent");
          break;
      }

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output || "Done." }] };
    },
  );
}

// ---------------------------------------------------------------------------
// sessions_send REDACTED send a message into another session
// ---------------------------------------------------------------------------

function registerSessionsSendTool(server: McpServer) {
  server.tool(
    "sessions_send",
    "Send a message into another conversation session. Use sessionKey or label to identify the target. The message is injected into the session and the agent processes it.",
    {
      sessionKey: z
        .string()
        .optional()
        .describe("Target session key (exact match, e.g. agent:ops:main)"),
      label: z.string().optional().describe("Target session label (fuzzy match)"),
      agentId: z.string().optional().describe("Agent id filter"),
      message: z.string().describe("The message text to send"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("Timeout in seconds for the operation (default: 120)"),
    },
    async ({ sessionKey, label, agentId, message, timeoutSeconds }) => {
      const args = ["agent", "--message", message, "--json"];
      if (sessionKey) args.push("--session-id", sessionKey);
      if (agentId) args.push("--agent", agentId);
      // label is not directly supported by `agent` CLI REDACTED approximate with session-id
      if (label && !sessionKey) {
        args.push("--session-id", label);
      }

      const timeout = (timeoutSeconds ?? 120) * 1000;
      const output = runCli(args, timeout);
      return { content: [{ type: "text" as const, text: output || "Message sent." }] };
    },
  );
}

// ---------------------------------------------------------------------------
// sessions_list REDACTED list conversation sessions
// ---------------------------------------------------------------------------

function registerSessionsListTool(server: McpServer) {
  server.tool(
    "sessions_list",
    "List conversation sessions with optional filters and last messages.",
    {
      active: z
        .number()
        .optional()
        .describe("Only show sessions updated within the past N minutes"),
      agentId: z.string().optional().describe("Agent id to inspect"),
      allAgents: z
        .boolean()
        .optional()
        .describe("Aggregate sessions across all configured agents"),
    },
    async ({ active, agentId, allAgents }) => {
      const args = ["sessions", "--json"];
      if (active) args.push("--active", String(active));
      if (agentId) args.push("--agent", agentId);
      if (allAgents) args.push("--all-agents");

      const output = runCli(args);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );
}

// ---------------------------------------------------------------------------
// cron REDACTED manage gateway cron jobs
// ---------------------------------------------------------------------------

function registerCronTool(server: McpServer) {
  server.tool(
    "cron",
    "Manage gateway cron jobs (status/list/add/edit/remove/run/runs/enable/disable). Main-session cron jobs enqueue system events for heartbeat handling. Isolated cron jobs create background task runs.",
    {
      action: z
        .enum(["status", "list", "add", "edit", "remove", "run", "runs", "enable", "disable"])
        .describe("Cron action to perform"),
      // Identifying a job
      jobId: z.string().optional().describe("Job id (for edit/remove/run/runs/enable/disable)"),
      // add/edit fields
      name: z.string().optional().describe("Job name (required for add)"),
      description: z.string().optional().describe("Job description"),
      // Schedule (choose one for add)
      cron: z.string().optional().describe("Cron expression (5 or 6 field)"),
      every: z.string().optional().describe("Run every duration (e.g. 10m, 1h)"),
      at: z.string().optional().describe("Run once at time (ISO with offset, or +duration)"),
      tz: z.string().optional().describe("Timezone for cron expressions (IANA)"),
      // Payload (choose one for add)
      systemEvent: z.string().optional().describe("System event payload (main session)"),
      messagePayload: z.string().optional().describe("Agent message payload"),
      // Session targeting
      session: z
        .string()
        .optional()
        .describe("Session target (main|isolated|current|session:<id>)"),
      sessionKey: z.string().optional().describe("Session key for job routing"),
      agentId: z.string().optional().describe("Agent id for this job"),
      // Agent job options
      thinking: z
        .string()
        .optional()
        .describe("Thinking level (off|minimal|low|medium|high|xhigh)"),
      model: z.string().optional().describe("Model override (provider/model or alias)"),
      timeoutSeconds: z.number().optional().describe("Timeout seconds"),
      // Delivery options
      announce: z.boolean().optional().describe("Announce summary to a chat"),
      deliverChannel: z
        .string()
        .optional()
        .describe("Delivery channel (last|telegram|discord|slack|etc.)"),
      deliverTo: z.string().optional().describe("Delivery destination"),
      // Flags
      deleteAfterRun: z
        .boolean()
        .optional()
        .describe("Delete one-shot job after success"),
      disabled: z.boolean().optional().describe("Create job disabled (add) or disable (edit)"),
      includeDisabled: z.boolean().optional().describe("Include disabled jobs (action=list)"),
      // run options
      due: z.boolean().optional().describe("Run only when due (action=run)"),
      limit: z.number().optional().describe("Max entries (action=runs)"),
    },
    async (params) => {
      const { action } = params;
      const args: string[] = ["cron"];

      switch (action) {
        case "status":
        case "list":
          args.push(action, "--json");
          if (action === "list" && params.includeDisabled) args.push("--all");
          break;

        case "add": {
          args.push("add", "--json");
          if (params.name) args.push("--name", params.name);
          if (params.description) args.push("--description", params.description);
          // Schedule
          if (params.cron) args.push("--cron", params.cron);
          if (params.every) args.push("--every", params.every);
          if (params.at) args.push("--at", params.at);
          if (params.tz) args.push("--tz", params.tz);
          // Payload
          if (params.systemEvent) args.push("--system-event", params.systemEvent);
          if (params.messagePayload) args.push("--message", params.messagePayload);
          // Session
          if (params.session) args.push("--session", params.session);
          if (params.sessionKey) args.push("--session-key", params.sessionKey);
          if (params.agentId) args.push("--agent", params.agentId);
          // Agent opts
          if (params.thinking) args.push("--thinking", params.thinking);
          if (params.model) args.push("--model", params.model);
          if (params.timeoutSeconds) args.push("--timeout-seconds", String(params.timeoutSeconds));
          // Delivery
          if (params.announce) args.push("--announce");
          if (params.deliverChannel) args.push("--channel", params.deliverChannel);
          if (params.deliverTo) args.push("--to", params.deliverTo);
          // Flags
          if (params.deleteAfterRun) args.push("--delete-after-run");
          if (params.disabled) args.push("--disabled");
          break;
        }

        case "edit": {
          if (!params.jobId) throw new Error("jobId is required for edit action");
          args.push("edit", params.jobId, "--json");
          if (params.name) args.push("--name", params.name);
          if (params.description) args.push("--description", params.description);
          if (params.cron) args.push("--cron", params.cron);
          if (params.every) args.push("--every", params.every);
          if (params.at) args.push("--at", params.at);
          if (params.tz) args.push("--tz", params.tz);
          if (params.systemEvent) args.push("--system-event", params.systemEvent);
          if (params.messagePayload) args.push("--message", params.messagePayload);
          if (params.session) args.push("--session", params.session);
          if (params.sessionKey) args.push("--session-key", params.sessionKey);
          if (params.agentId) args.push("--agent", params.agentId);
          if (params.thinking) args.push("--thinking", params.thinking);
          if (params.model) args.push("--model", params.model);
          if (params.timeoutSeconds) args.push("--timeout-seconds", String(params.timeoutSeconds));
          if (params.announce) args.push("--announce");
          if (params.deliverChannel) args.push("--channel", params.deliverChannel);
          if (params.deliverTo) args.push("--to", params.deliverTo);
          if (params.deleteAfterRun) args.push("--delete-after-run");
          if (params.disabled === true) args.push("--disable");
          if (params.disabled === false) args.push("--enable");
          break;
        }

        case "enable":
        case "disable": {
          if (!params.jobId) throw new Error(`jobId is required for ${action} action`);
          args.push(action, params.jobId, "--json");
          break;
        }

        case "remove": {
          if (!params.jobId) throw new Error("jobId is required for remove action");
          args.push("rm", params.jobId, "--json");
          break;
        }

        case "run": {
          if (!params.jobId) throw new Error("jobId is required for run action");
          args.push("run", params.jobId);
          if (params.due) args.push("--due");
          break;
        }

        case "runs": {
          if (!params.jobId) throw new Error("jobId is required for runs action");
          args.push("runs", "--id", params.jobId);
          if (params.limit) args.push("--limit", String(params.limit));
          break;
        }
      }

      const timeout = action === "run" ? AGENT_TIMEOUT_MS : CLI_TIMEOUT_MS;
      const output = runCli(args, timeout);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );
}

// ---------------------------------------------------------------------------
// session_status REDACTED show status info
// ---------------------------------------------------------------------------

function registerSessionStatusTool(server: McpServer) {
  server.tool(
    "session_status",
    "Show channel health, recent session recipients, and model usage. Use for checking system status and active sessions.",
    {
      deep: z
        .boolean()
        .optional()
        .describe("Probe channels (WhatsApp, Telegram, Discord, Slack, Signal)"),
      usage: z.boolean().optional().describe("Show model provider usage/quota snapshots"),
    },
    async ({ deep, usage }) => {
      const args = ["status", "--json"];
      if (deep) args.push("--deep");
      if (usage) args.push("--usage");

      const output = runCli(args, deep ? 60_000 : CLI_TIMEOUT_MS);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );
}

// ---------------------------------------------------------------------------
// sessions_spawn REDACTED spawn an isolated session / background task
// ---------------------------------------------------------------------------

function registerSessionsSpawnTool(server: McpServer) {
  server.tool(
    "sessions_spawn",
    "Spawn an isolated background agent session for a task. The task runs independently and results can be checked via session_status or sessions_list.",
    {
      task: z.string().describe("Task description or prompt for the spawned session"),
      agentId: z.string().optional().describe("Agent id override"),
      model: z.string().optional().describe("Model override (provider/model or alias)"),
      thinking: z
        .string()
        .optional()
        .describe("Thinking level (off|minimal|low|medium|high|xhigh)"),
      deliver: z.boolean().optional().describe("Deliver results back to the current chat"),
      deliverChannel: z.string().optional().describe("Delivery channel override"),
      deliverTo: z.string().optional().describe("Delivery destination override"),
    },
    async ({ task, agentId, model, thinking, deliver, deliverChannel, deliverTo }) => {
      const args = ["agent", "--message", task, "--json"];
      if (agentId) args.push("--agent", agentId);
      if (model) args.push("--model", model);
      if (thinking) args.push("--thinking", thinking);
      if (deliver) args.push("--deliver");
      if (deliverChannel) args.push("--reply-channel", deliverChannel);
      if (deliverTo) args.push("--reply-to", deliverTo);

      const output = runCli(args, AGENT_TIMEOUT_MS);
      return { content: [{ type: "text" as const, text: output || "Session spawned." }] };
    },
  );
}

// ---------------------------------------------------------------------------
// tts REDACTED text to speech
// ---------------------------------------------------------------------------

function registerTtsTool(server: McpServer) {
  server.tool(
    "tts",
    "Convert text to speech. Audio is delivered automatically through the messaging channel. Reply with NO_REPLY after a successful call to avoid duplicate messages.",
    {
      text: z.string().describe("Text to convert to speech"),
      channel: z
        .string()
        .optional()
        .describe("Optional channel id to pick output format (e.g. telegram)"),
    },
    async ({ text, channel }) => {
      // tts is not a top-level CLI command; route through agent
      const prompt = channel
        ? `Use text-to-speech to say: "${text}" (target channel: ${channel})`
        : `Use text-to-speech to say: "${text}"`;
      const args = ["agent", "--message", prompt, "--json"];

      const output = runCli(args, AGENT_TIMEOUT_MS);
      return { content: [{ type: "text" as const, text: output || "Speech generated." }] };
    },
  );
}

// ---------------------------------------------------------------------------
// image REDACTED image analysis with a vision model
// ---------------------------------------------------------------------------

function registerImageTool(server: McpServer) {
  server.tool(
    "image",
    "Analyze one or more images with a vision model. Only use when images were NOT already provided in the user's message.",
    {
      prompt: z.string().optional().describe("Description of what to analyze in the image(s)"),
      image: z.string().optional().describe("Single image path or URL"),
      images: z
        .array(z.string())
        .optional()
        .describe("Multiple image paths or URLs (up to 20)"),
      model: z.string().optional().describe("Model override for analysis"),
    },
    async ({ prompt, image, images, model }) => {
      // Image analysis is not a top-level CLI command; route through agent
      const parts = ["Analyze the following image(s)"];
      if (prompt) parts.push(`with focus on: ${prompt}`);
      const allImages = [...(image ? [image] : []), ...(images ?? [])];
      if (allImages.length) parts.push(`\nImages: ${allImages.join(", ")}`);
      if (model) parts.push(`\nUse model: ${model}`);

      const args = ["agent", "--message", parts.join(" "), "--json"];
      const output = runCli(args, AGENT_TIMEOUT_MS);
      return { content: [{ type: "text" as const, text: output }] };
    },
  );
}

// ---------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "gateway-tools",
    version: "2.0.0",
  });

  registerMessageTool(server);
  registerSessionsSendTool(server);
  registerSessionsListTool(server);
  registerCronTool(server);
  registerSessionStatusTool(server);
  registerSessionsSpawnTool(server);
  registerTtsTool(server);
  registerImageTool(server);

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

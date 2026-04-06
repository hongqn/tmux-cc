/**
 * tmux-cc provider plugin entry point.
 *
 * Registers a provider that delegates all inference to Claude Code CLI
 * running in persistent tmux sessions. OpenClaw handles channel routing;
 * Claude Code handles context, reasoning, and tool use.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { startCleanupTimer, stopCleanupTimer } from "./src/session-map.js";
import { createTmuxClaudeStreamFn } from "./src/stream-fn.js";
import type { TmuxClaudeConfig } from "./src/types.js";
import { DEFAULT_CONFIG } from "./src/types.js";

const PROVIDER_ID = "tmux-cc";

/** Claude models available through Claude Code CLI. */
const CLAUDE_MODELS = [
  {
    id: "opus-4.6",
    name: "Claude Opus 4.6 (tmux)",
    claudeModelId: "claude-opus-4-6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "sonnet-4.6",
    name: "Claude Sonnet 4.6 (tmux)",
    claudeModelId: "claude-sonnet-4-6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "sonnet-4.5",
    name: "Claude Sonnet 4.5 (tmux)",
    claudeModelId: "claude-sonnet-4-5-20250514",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "haiku-4.5",
    name: "Claude Haiku 4.5 (tmux)",
    claudeModelId: "claude-haiku-4-5-20250514",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

/**
 * Get plugin config from the OpenClaw config object.
 */
function getPluginConfig(config: Record<string, unknown> | undefined): TmuxClaudeConfig {
  const pluginConfig = (config as Record<string, unknown>)?.plugins as
    | Record<string, unknown>
    | undefined;
  const tmuxClaudeConfig = pluginConfig?.["tmux-cc"] as TmuxClaudeConfig | undefined;
  return tmuxClaudeConfig ?? {};
}

/**
 * Map an OpenClaw model ID to the Claude Code CLI model name.
 * Looks up the claudeModelId from the CLAUDE_MODELS table.
 */
function extractClaudeModelId(modelId: string): string {
  // Strip provider prefix if present (legacy "tmux-cc/sonnet-4.6" format)
  const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const match = CLAUDE_MODELS.find((m) => m.id === bare);
  return match?.claudeModelId ?? bare;
}

/**
 * Write the Claude Code MCP settings file for a working directory.
 * This configures Claude Code to connect to our MCP tools server.
 */
function writeMcpSettings(workingDirectory: string): void {
  const claudeDir = join(workingDirectory, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  const mcpServerScript = resolve(import.meta.dirname ?? __dirname, "src", "mcp-server.ts");

  const settings = {
    mcpServers: {
      "gateway-tools": {
        command: "npx",
        args: ["tsx", mcpServerScript],
        env: {
          GATEWAY_CLI_COMMAND: process.env.GATEWAY_CLI_COMMAND ?? "openclaw",
        },
      },
    },
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Claude Code (tmux) Provider",
  description: "Provider that delegates inference to Claude Code CLI in tmux sessions",

  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude Code (tmux)",
      docsPath: "/providers/tmux-cc",

      auth: [
        {
          id: "local",
          label: "Claude Code (local)",
          kind: "custom",
          run: async () => {
            // No API key needed REDACTED Claude Code uses its own authentication
            return {
              profiles: [
                {
                  id: "default",
                  label: "Claude Code (tmux)",
                  isDefault: true,
                },
              ],
              configPatch: {},
            };
          },
          runNonInteractive: async () => {
            return {
              profiles: [
                {
                  id: "default",
                  label: "Claude Code (tmux)",
                  isDefault: true,
                },
              ],
              configPatch: {},
            };
          },
        },
      ],

      discovery: {
        order: "late",
        run: async (ctx) => {
          const pluginConfig = getPluginConfig(ctx.config as unknown as Record<string, unknown>);
          const mergedConfig = { ...DEFAULT_CONFIG, ...pluginConfig };

          // Write MCP settings for Claude Code
          writeMcpSettings(mergedConfig.workingDirectory);

          return {
            provider: {
              baseUrl: "local://tmux-cc",
              api: "anthropic-v1",
              models: CLAUDE_MODELS.map((m) => ({
                id: m.id,
                name: m.name,
                api: "anthropic-v1" as const,
                reasoning: m.reasoning,
                input: ["text", "image"] as Array<"text" | "image">,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: m.contextWindow,
                maxTokens: m.maxTokens,
              })),
            },
          };
        },
      },

      resolveDynamicModel: (ctx) => {
        const match = CLAUDE_MODELS.find((m) => m.id === ctx.modelId);
        if (!match) {
          return undefined;
        }
        return {
          id: match.id,
          name: match.name,
          provider: PROVIDER_ID,
          api: "anthropic-v1" as const,
          reasoning: match.reasoning,
          contextWindow: match.contextWindow,
          maxTokens: match.maxTokens,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },

      augmentModelCatalog: () =>
        CLAUDE_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          provider: PROVIDER_ID,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          input: ["text", "image"] as Array<"text" | "image">,
        })),

      resolveSyntheticAuth: () => ({
        apiKey: "tmux-cc-local",
        source: "tmux-cc synthetic local auth (no real key needed)",
        mode: "api-key" as const,
      }),

      createStreamFn: (ctx) => {
        const pluginConfig = getPluginConfig(ctx.config as unknown as Record<string, unknown>);
        // Use agent workspace as default working directory instead of process.cwd()
        const workDir = pluginConfig.workingDirectory ?? ctx.workspaceDir ?? process.cwd();
        const mergedConfig = { ...DEFAULT_CONFIG, ...pluginConfig, workingDirectory: workDir };

        // Extract the Claude model from the full model ID
        const claudeModelId = extractClaudeModelId(ctx.modelId);

        // Start idle cleanup timer on first use
        startCleanupTimer(mergedConfig);

        return createTmuxClaudeStreamFn({
          config: {
            ...mergedConfig,
            defaultModel: claudeModelId,
          },
        });
      },
    });
  },
});

// Cleanup on process exit
process.on("exit", () => {
  stopCleanupTimer();
});

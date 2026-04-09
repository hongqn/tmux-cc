/**
 * tmux-cc provider plugin entry point.
 *
 * Registers a provider that delegates all inference to a CLI agent
 * (currently Claude Code) running in persistent tmux sessions. OpenClaw
 * handles channel routing; the agent handles context, reasoning, and tool use.
 *
 * Agent-specific logic is encapsulated in an {@link AgentAdapter}.
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ClaudeCodeAdapter } from "./src/adapters/claude-code.js";
import { startCleanupTimer, stopCleanupTimer } from "./src/session-map.js";
import { createTmuxClaudeStreamFn } from "./src/stream-fn.js";
import type { TmuxClaudeConfig } from "./src/types.js";
import { DEFAULT_CONFIG } from "./src/types.js";

const PROVIDER_ID = "tmux-cc";

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

function createAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    pluginDir: import.meta.dirname ?? __dirname,
  });
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Claude Code (tmux) Provider",
  description: "Provider that delegates inference to Claude Code CLI in tmux sessions",

  register(api: OpenClawPluginApi) {
    const adapter = createAdapter();

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

          adapter.setupWorkspace(mergedConfig.workingDirectory);

          return {
            provider: {
              baseUrl: "local://tmux-cc",
              api: "anthropic-v1",
              models: adapter.models.map((m) => ({
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
        const match = adapter.models.find((m) => m.id === ctx.modelId);
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
        adapter.models.map((m) => ({
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
        const workDir = pluginConfig.workingDirectory ?? ctx.workspaceDir ?? process.cwd();
        const mergedConfig = { ...DEFAULT_CONFIG, ...pluginConfig, workingDirectory: workDir };

        adapter.setupWorkspace(workDir);

        const claudeModelId = adapter.resolveModelId(ctx.modelId);

        startCleanupTimer(mergedConfig);

        return createTmuxClaudeStreamFn({
          config: {
            ...mergedConfig,
            defaultModel: claudeModelId,
          },
          adapter,
        });
      },
    });
  },
});

// Cleanup on process exit
process.on("exit", () => {
  stopCleanupTimer();
});

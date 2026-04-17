/**
 * tmux-cc provider plugin entry point.
 *
 * Registers providers that delegate all inference to CLI agents
 * (Claude Code and/or Copilot CLI) running in persistent tmux sessions.
 * OpenClaw handles channel routing; the agent handles context, reasoning,
 * and tool use.
 *
 * Agent-specific logic is encapsulated in {@link AgentAdapter} implementations.
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { ClaudeCodeAdapter } from "./src/adapters/claude-code.js";
import { CopilotCliAdapter } from "./src/adapters/copilot-cli.js";
import type { AgentAdapter } from "./src/adapters/types.js";
import { deleteSession, startCleanupTimer, stopCleanupTimer } from "./src/session-map.js";
import { removePersistedSession } from "./src/session-persistence.js";
import { createTmuxClaudeStreamFn, deriveSessionKey } from "./src/stream-fn.js";
import type { TmuxClaudeConfig } from "./src/types.js";
import { DEFAULT_CONFIG } from "./src/types.js";

const TMUX_CC_PROVIDER_ID = "tmux-cc";
const COPILOT_PROVIDER_ID = "tmux-copilot";

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
 * Register a provider backed by an AgentAdapter.
 */
/** Unique custom transport API key per provider, so each gets its own streamFn registration. */
function providerApiKey(providerId: string): string {
  return `${providerId}-stream`;
}

function registerAdapterProvider(
  api: OpenClawPluginApi,
  providerId: string,
  label: string,
  adapter: AgentAdapter,
  fallbackAdapter?: AgentAdapter,
) {
  api.registerProvider({
    id: providerId,
    label,
    docsPath: `/providers/${providerId}`,

    auth: [
      {
        id: "local",
        label: `${label} (local)`,
        kind: "custom",
        run: async () => ({
          profiles: [{ id: "default", label, isDefault: true }],
          configPatch: {},
        }),
        runNonInteractive: async () => ({
          profiles: [{ id: "default", label, isDefault: true }],
          configPatch: {},
        }),
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
            baseUrl: `local://${providerId}`,
            api: providerApiKey(providerId),
            models: adapter.models.map((m) => ({
              id: m.id,
              name: m.name,
              api: providerApiKey(providerId) as string,
              reasoning: m.reasoning,
              input: ["text", "image"] as Array<"text" | "image">,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
            })),
          },
        };
      },
    },

    resolveDynamicModel: (ctx) => {
      const match = adapter.models.find((m) => m.id === ctx.modelId);
      if (!match) return undefined;
      return {
        id: match.id,
        name: match.name,
        provider: providerId,
        api: providerApiKey(providerId) as string,
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
        provider: providerId,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        input: ["text", "image"] as Array<"text" | "image">,
      })),

    resolveSyntheticAuth: () => ({
      apiKey: `${providerId}-local`,
      source: `${providerId} synthetic local auth (no real key needed)`,
      mode: "api-key" as const,
    }),

    createStreamFn: (ctx) => {
      const pluginConfig = getPluginConfig(ctx.config as unknown as Record<string, unknown>);
      const workDir = pluginConfig.workingDirectory ?? ctx.workspaceDir ?? process.cwd();
      const mergedConfig = { ...DEFAULT_CONFIG, ...pluginConfig, workingDirectory: workDir };

      adapter.setupWorkspace(workDir);

      startCleanupTimer(mergedConfig);

      return createTmuxClaudeStreamFn({
        config: {
          ...mergedConfig,
          defaultModel: ctx.modelId,
        },
        adapter,
        fallbackAdapter,
        providerId,
      });
    },
  });
}

export default definePluginEntry({
  id: TMUX_CC_PROVIDER_ID,
  name: "tmux Agent Provider",
  description: "Provider that delegates inference to CLI agents (Claude Code, Copilot) in tmux sessions",

  register(api: OpenClawPluginApi) {
    const pluginDir = import.meta.dirname ?? __dirname;

    // Tear down the tmux window and persisted CC/Copilot session ID when
    // the user issues /new or /reset. Without this hook, the next message
    // would reuse the existing window because we key by session name (so
    // gateway-side eviction with new UUIDs preserves context). The hook
    // lets intentional resets actually create a fresh agent process.
    api.on("before_reset", async (event, ctx) => {
      if (!ctx.sessionKey) return;
      const pluginConfig = getPluginConfig(api.config as unknown as Record<string, unknown>);
      const mergedConfig = { ...DEFAULT_CONFIG, ...pluginConfig };
      const tmuxKey = deriveSessionKey([], ctx.sessionKey);
      console.log(`[tmux-cc] before_reset: clearing window for sessionKeyName=${ctx.sessionKey}, tmuxKey=${tmuxKey}, reason=${event.reason ?? "unknown"}`);
      removePersistedSession(tmuxKey);
      try {
        await deleteSession(tmuxKey, mergedConfig);
      } catch (err) {
        console.error(`[tmux-cc] before_reset: deleteSession failed:`, err);
      }
    });

    // Register Claude Code adapter (tmux-cc provider)
    const claudeAdapter = new ClaudeCodeAdapter({ pluginDir });
    registerAdapterProvider(api, TMUX_CC_PROVIDER_ID, "Claude Code (tmux)", claudeAdapter);

    // Register Copilot CLI adapter (tmux-copilot provider)
    try {
      const copilotAdapter = new CopilotCliAdapter({
        pluginDir,
        // Only enable KPSS (keep-persistent-session) for interactive chat sessions.
        // Cron, subagent, and other one-shot sessions should not be kept alive.
        kpssSessionWhitelist: ["*telegram*", "*main"],
        // Non-whitelisted sessions (cron, subagent) fall back to Claude Code.
        kpssNonWhitelistBehavior: { fallback: "sonnet-4.6" },
        // When Copilot hits Anthropic rate limits, fall back to Claude Code
        // with the equivalent model for 1 hour before retrying.
        rateLimitFallbackModels: {
          "claude-opus-4.6": "opus-4.6",
        },
      });
      registerAdapterProvider(api, COPILOT_PROVIDER_ID, "Copilot CLI (tmux)", copilotAdapter, claudeAdapter);
    } catch (err) {
      console.error(`[tmux-cc] failed to register ${COPILOT_PROVIDER_ID}:`, err);
    }
  },
});

// Cleanup on process exit
process.on("exit", () => {
  stopCleanupTimer();
});

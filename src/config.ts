/**
 * Configuration for pi-memory plugin.
 * Can be set in settings.json under "piMemory" key.
 *
 * Supports two formats:
 * 1. Direct config: specify baseUrl, apiType, modelId, apiKey directly
 * 2. Reference models.json: specify provider and modelId to use from ~/.pi/agent/models.json
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PiMemoryConfig {
  /** Custom base URL for the cheap LLM API (e.g., "https://api.openai.com/v1") */
  baseUrl?: string;
  /** API type: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generativelanguage" */
  apiType?: string;
  /** Model ID to use for memory extraction (e.g., "gpt-4o-mini", "claude-3-haiku-20240307") */
  modelId?: string;
  /** API key - can be a literal key or environment variable name (e.g., "$OPENAI_API_KEY") */
  apiKey?: string;
  /** Timeout for extraction API calls in ms (default: 10000) */
  timeout?: number;

  /**
   * Provider name from models.json (e.g., "nahcrof", "anyrouter").
   * When specified, will load baseUrl, api, apiKey from models.json.
   */
  provider?: string;
}

export const DEFAULT_CONFIG: PiMemoryConfig = {
  timeout: 10_000,
};

interface ModelsJsonProvider {
  baseUrl: string;
  api: string;
  apiKey: string;
  models: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  }>;
}

interface ModelsJson {
  providers: Record<string, ModelsJsonProvider>;
}

/**
 * Load models.json from ~/.pi/agent/models.json
 */
async function loadModelsJson(): Promise<ModelsJson | null> {
  try {
    const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
    const content = await fs.readFile(modelsPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Load config from settings.
 * Looks for "piMemory" key in settings.json (project first, then global).
 * Supports referencing models.json providers.
 */
export async function loadConfig(cwd: string): Promise<PiMemoryConfig> {
  try {
    // Try project settings first
    const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
    let settings: Record<string, unknown> = {};

    try {
      const content = await fs.readFile(projectSettingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch {
      // Project settings not found, try global
      const globalSettingsPath = path.join(
        os.homedir(),
        ".pi",
        "agent",
        "settings.json",
      );
      try {
        const content = await fs.readFile(globalSettingsPath, "utf-8");
        settings = JSON.parse(content);
      } catch {
        // No settings found, use defaults
        return DEFAULT_CONFIG;
      }
    }

    const piMemory = settings?.piMemory as PiMemoryConfig | undefined;
    if (!piMemory) {
      return DEFAULT_CONFIG;
    }

    // If provider is specified, load from models.json
    if (piMemory.provider) {
      const modelsJson = await loadModelsJson();
      if (modelsJson?.providers?.[piMemory.provider]) {
        const providerConfig = modelsJson.providers[piMemory.provider];
        const modelId = piMemory.modelId || providerConfig.models[0]?.id;

        return {
          ...DEFAULT_CONFIG,
          baseUrl: providerConfig.baseUrl,
          apiType: providerConfig.api,
          apiKey: providerConfig.apiKey,
          modelId: modelId,
          timeout: piMemory.timeout,
        };
      }
    }

    // Direct config
    return { ...DEFAULT_CONFIG, ...piMemory };
  } catch {
    // Ignore errors, use defaults
  }
  return DEFAULT_CONFIG;
}

/**
 * Resolve API key - support env var prefix ($VAR or ${VAR})
 */
export function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  // Support $VAR or ${VAR} syntax for env vars
  const match = apiKey.match(/^\$\{?(\w+)\}?$/);
  if (match) {
    return process.env[match[1]];
  }
  return apiKey;
}

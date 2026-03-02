import type {
  ExtensionUIContext,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { callCheapModel } from "./cheap-model";
import { loadConfig } from "./config";
import { error } from "./logger";
import type { MemoryManager } from "./memory-manager";

export interface MemoryExtractionContext {
  projectPath: string;
  userMessage: string;
  agentResponseText: string;
  memoryManager: MemoryManager;
  modelRegistry: ModelRegistry;
  cwd: string;
  ui?: ExtensionUIContext;
}

/**
 * Run memory extraction in background after an agent response.
 * Must never throw — all errors are caught and logged.
 */
export async function extractMemoriesInBackground(
  ctx: MemoryExtractionContext,
): Promise<void> {
  const { ui } = ctx;

  if (ui?.setStatus) {
    const theme = ui.theme;
    const spinner = theme.fg("accent", "●");
    const label = theme.fg("dim", " memory extracting…");
    ui.setStatus("memory-extract", spinner + label);
  }

  try {
    const {
      projectPath,
      userMessage,
      agentResponseText,
      memoryManager,
      modelRegistry,
      cwd,
    } = ctx;

    if (!memoryManager.enabled) return;
    if (memoryManager.shouldSkipExtraction()) return;
    memoryManager.markExtractionRun();

    const existingMemories = await memoryManager.getMemoryContext(projectPath);

    const extractionPrompt = memoryManager.buildExtractionPrompt(
      userMessage,
      agentResponseText,
      existingMemories,
    );

    let extractionResult: string | null = null;
    let apiContext: Record<string, unknown> = {};

    try {
      // Load config from settings
      const config = await loadConfig(cwd);
      apiContext = {
        configApiType: config.apiType,
        configModelId: config.modelId,
        configTimeout: config.timeout,
      };

      // If custom config is provided, use it
      if (config.apiType && config.modelId && config.apiKey) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          config.timeout || 10_000,
        );

        try {
          extractionResult = await callCheapModel(
            config,
            extractionPrompt,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
      } else {
        // Fallback: use model registry's available models
        const availableModels = modelRegistry.getAvailable();
        const cheapModel =
          availableModels.find(
            (m) =>
              m.id.includes("haiku") ||
              m.id.includes("gpt-4o-mini") ||
              m.id.includes("flash"),
          ) || availableModels[0];

        if (!cheapModel) return;
        apiContext.fallbackModel = {
          provider: cheapModel.provider,
          id: cheapModel.id,
        };

        const apiKey = await modelRegistry.getApiKey(cheapModel);
        if (!apiKey) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);

        try {
          extractionResult = await callCheapModel(
            {
              apiType: cheapModel.provider,
              modelId: cheapModel.id,
              apiKey: apiKey,
              timeout: 10_000,
            },
            extractionPrompt,
            controller.signal,
          );
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      error(
        "Extraction API call failed:",
        err,
        "\nAPI context:",
        JSON.stringify(apiContext, null, 2),
      );
      return;
    }

    if (!extractionResult) return;

    await memoryManager.processExtractionResult(extractionResult, projectPath);
  } catch (err) {
    error("Memory extraction failed:", err);
  } finally {
    if (ui?.setStatus) {
      ui.setStatus("memory-extract", undefined);
    }
  }
}

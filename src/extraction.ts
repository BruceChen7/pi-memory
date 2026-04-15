import type {
  ExtensionUIContext,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { CheapModelResult } from "./cheap-model";
import { loadConfig } from "./config";
import { runExtractionPrompt } from "./extraction-runner";
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

    const existingMemories =
      await memoryManager.getMemoryIndexSummary(projectPath);

    const conversationText = `User: ${userMessage}\n\nAgent: ${agentResponseText}`;
    const extractionPrompt = memoryManager.buildExtractionPrompt({
      conversationText,
      existingMemories,
      mode: "standard",
    });

    let extractionResult: CheapModelResult | null = null;
    let apiContext: Record<string, unknown> = {};

    try {
      const config = await loadConfig(cwd);
      apiContext = {
        configApiType: config.apiType,
        configModelId: config.modelId,
        configTimeout: config.timeout,
        usingConfiguredModel: Boolean(
          config.apiType && config.modelId && config.apiKey,
        ),
      };

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        config.timeout || 10_000,
      );

      try {
        extractionResult = await runExtractionPrompt({
          config,
          prompt: extractionPrompt,
          signal: controller.signal,
          modelRegistry,
        });
      } finally {
        clearTimeout(timeout);
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

    if (!extractionResult || !extractionResult.success) {
      if (extractionResult?.error) {
        error(`Memory extraction failed: ${extractionResult.error}`);
      }
      return;
    }

    const resultContent = extractionResult.content;

    if (resultContent) {
      await memoryManager.processExtractionResult(resultContent, projectPath);
    }
  } catch (err) {
    error("Memory extraction failed:", err);
  } finally {
    if (ui?.setStatus) {
      ui.setStatus("memory-extract", undefined);
    }
  }
}

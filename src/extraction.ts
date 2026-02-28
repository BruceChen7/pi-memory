import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import type { MemoryManager } from './memory-manager';
import { callCheapModel } from './cheap-model';
import { loadConfig } from './config';

export interface MemoryExtractionContext {
  projectPath: string;
  userMessage: string;
  agentResponseText: string;
  memoryManager: MemoryManager;
  modelRegistry: ModelRegistry;
  cwd: string;
}

/**
 * Run memory extraction in background after an agent response.
 * Must never throw — all errors are caught and logged.
 */
export async function extractMemoriesInBackground(
  ctx: MemoryExtractionContext
): Promise<void> {
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
      existingMemories
    );

    let extractionResult: string | null = null;

    try {
      // Load config from settings
      const config = await loadConfig(cwd);

      // If custom config is provided, use it
      if (config.apiType && config.modelId && config.apiKey) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeout || 10_000);

        try {
          extractionResult = await callCheapModel(config, extractionPrompt, controller.signal);
        } finally {
          clearTimeout(timeout);
        }
      } else {
        // Fallback: use model registry's available models
        const availableModels = modelRegistry.getAvailable();
        const cheapModel = availableModels.find(m =>
          m.id.includes('haiku') || m.id.includes('gpt-4o-mini') || m.id.includes('flash')
        ) || availableModels[0];

        if (!cheapModel) return;

        const apiKey = await modelRegistry.getApiKey(cheapModel);
        if (!apiKey) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);

        try {
          extractionResult = await callCheapModel(
            {
              apiType: cheapModel.provider,
              modelId: cheapModel.id,
              apiKey: apiKey,
              timeout: 10_000,
            },
            extractionPrompt,
            controller.signal
          );
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      console.debug('[pi-memory] Extraction API call failed:', err);
      return;
    }

    if (!extractionResult) return;

    await memoryManager.processExtractionResult(extractionResult, projectPath);
  } catch (err) {
    console.debug('[pi-memory] Memory extraction failed:', err);
  }
}
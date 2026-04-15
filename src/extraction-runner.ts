import {
  type Api,
  complete,
  type Model,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { type CheapModelResult, callCheapModel } from "./cheap-model";
import type { PiMemoryConfig } from "./config";

interface AuthHeadersResult {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
}

interface AuthErrorResult {
  ok: false;
  error: string;
}

export interface ExtractionModelRegistry {
  getAvailable(): Model<Api>[];
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<AuthHeadersResult | AuthErrorResult>;
}

export interface RunExtractionPromptOptions {
  config: PiMemoryConfig;
  prompt: string;
  signal: AbortSignal;
  modelRegistry: ExtractionModelRegistry;
  currentModel?: Model<Api>;
}

const preferredModelPatterns = [/haiku/i, /gpt-4o-mini/i, /flash/i];

function hasExplicitConfig(config: PiMemoryConfig): boolean {
  return Boolean(config.apiType && config.modelId && config.apiKey);
}

function isPreferredExtractionModel(model: Model<Api>): boolean {
  return preferredModelPatterns.some(
    (pattern) => pattern.test(model.id) || pattern.test(model.name),
  );
}

function dedupeModels(models: Array<Model<Api> | undefined>): Model<Api>[] {
  const seen = new Set<string>();
  const deduped: Model<Api>[] = [];

  for (const model of models) {
    if (!model) continue;
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(model);
  }

  return deduped;
}

function buildCandidateModels(
  currentModel: Model<Api> | undefined,
  availableModels: Model<Api>[],
): Model<Api>[] {
  const preferredModels = availableModels.filter(isPreferredExtractionModel);
  const otherModels = availableModels.filter(
    (model) => !isPreferredExtractionModel(model),
  );

  return dedupeModels([...preferredModels, currentModel, ...otherModels]);
}

function extractTextContent(
  message: Awaited<ReturnType<typeof complete>>,
): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

export async function runExtractionPrompt(
  options: RunExtractionPromptOptions,
): Promise<CheapModelResult> {
  const { config, prompt, signal, modelRegistry, currentModel } = options;

  if (hasExplicitConfig(config)) {
    return callCheapModel(config, prompt, signal);
  }

  const availableModels = modelRegistry.getAvailable();
  const candidateModels = buildCandidateModels(currentModel, availableModels);

  for (const model of candidateModels) {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      continue;
    }
    if (!auth.apiKey && !auth.headers) {
      continue;
    }

    try {
      const userMessage: UserMessage = {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      };
      const response = await complete(
        model,
        { messages: [userMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
        },
      );

      if (response.stopReason === "aborted") {
        return {
          success: false,
          content: null,
          error: response.errorMessage || "Extraction request was aborted.",
        };
      }

      if (response.stopReason === "error") {
        return {
          success: false,
          content: null,
          error: response.errorMessage || "Extraction request failed.",
        };
      }

      const content = extractTextContent(response);
      return {
        success: true,
        content: content || null,
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        content: null,
        error: `Extraction request failed: ${errorMessage}`,
      };
    }
  }

  return {
    success: false,
    content: null,
    error: "No authenticated fallback model available from Pi model registry.",
  };
}

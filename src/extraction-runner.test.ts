import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callCheapModel } from "./cheap-model";
import type { PiMemoryConfig } from "./config";
import { runExtractionPrompt } from "./extraction-runner";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("./cheap-model", () => ({
  callCheapModel: vi.fn(),
}));

type MockAuthResult =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

interface MockModelRegistry {
  getAvailable: () => Model<Api>[];
  getApiKeyAndHeaders: (model: Model<Api>) => Promise<MockAuthResult>;
}

function createModel(
  overrides: Partial<Model<Api>> & { id: string },
): Model<Api> {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    api: overrides.api ?? "anthropic-messages",
    provider: overrides.provider ?? "anthropic",
    baseUrl: overrides.baseUrl ?? "https://example.com",
    reasoning: overrides.reasoning ?? false,
    input: overrides.input ?? ["text"],
    cost: overrides.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: overrides.contextWindow ?? 200_000,
    maxTokens: overrides.maxTokens ?? 8_192,
    headers: overrides.headers,
    compat: overrides.compat,
  };
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("runExtractionPrompt", () => {
  const signal = AbortSignal.timeout(5_000);
  const prompt = "Extract memories from this conversation.";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured cheap model when piMemory config is complete", async () => {
    const config: PiMemoryConfig = {
      apiType: "openai-responses",
      modelId: "gpt-4o-mini",
      apiKey: "$OPENAI_API_KEY",
      timeout: 10_000,
    };
    const expectedResult = {
      success: true,
      content: '{"actions":[]}',
    };
    vi.mocked(callCheapModel).mockResolvedValue(expectedResult);

    const result = await runExtractionPrompt({
      config,
      prompt,
      signal,
      modelRegistry: {
        getAvailable: () => [],
        getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
      },
    });

    expect(result).toEqual(expectedResult);
    expect(callCheapModel).toHaveBeenCalledWith(config, prompt, signal);
    expect(complete).not.toHaveBeenCalled();
  });

  it("falls back to an authenticated registry model when piMemory config is incomplete", async () => {
    const preferredModel = createModel({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "anthropic",
      api: "anthropic-messages",
    });
    const otherModel = createModel({
      id: "gpt-4.1",
      name: "GPT-4.1",
      provider: "openai",
      api: "openai-responses",
    });

    const modelRegistry: MockModelRegistry = {
      getAvailable: () => [otherModel, preferredModel],
      getApiKeyAndHeaders: async (model) => {
        if (model.id === preferredModel.id) {
          return {
            ok: true,
            headers: { Authorization: "Bearer token" },
          };
        }
        return { ok: false, error: "missing auth" };
      },
    };
    vi.mocked(complete).mockResolvedValue(
      createAssistantMessage('{"actions":[{"action":"none"}]}'),
    );

    const result = await runExtractionPrompt({
      config: { timeout: 10_000 },
      prompt,
      signal,
      modelRegistry,
    });

    expect(result).toEqual({
      success: true,
      content: '{"actions":[{"action":"none"}]}',
    });
    expect(callCheapModel).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      preferredModel,
      {
        messages: [
          {
            role: "user",
            content: prompt,
            timestamp: expect.any(Number),
          },
        ],
      },
      {
        apiKey: undefined,
        headers: { Authorization: "Bearer token" },
        signal,
      },
    );
  });

  it("returns an error when no authenticated fallback model is available", async () => {
    const modelRegistry: MockModelRegistry = {
      getAvailable: () => [createModel({ id: "gpt-4.1" })],
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing auth" }),
    };

    const result = await runExtractionPrompt({
      config: { timeout: 10_000 },
      prompt,
      signal,
      modelRegistry,
    });

    expect(result).toEqual({
      success: false,
      content: null,
      error:
        "No authenticated fallback model available from Pi model registry.",
    });
    expect(callCheapModel).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

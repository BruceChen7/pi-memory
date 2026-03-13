/**
 * Lightweight API calls to the cheapest available model for memory extraction.
 * Supports custom base URL and various provider API formats.
 */
import type { PiMemoryConfig } from "./config";
import { error } from "./logger";

export interface CheapModelResult {
  success: boolean;
  content: string | null;
  error?: string;
}

export async function callCheapModel(
  config: PiMemoryConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<CheapModelResult> {
  const { baseUrl, apiType, modelId, apiKey, timeout = 10_000 } = config;

  // If no config, we can't make the call
  if (!apiType || !modelId || !apiKey) {
    return {
      success: false,
      content: null,
      error: `Config incomplete: apiType=${apiType ? "set" : "missing"}, modelId=${modelId ? "set" : "missing"}, apiKey=${apiKey ? "set" : "missing"}`,
    };
  }

  const resolvedApiKey = resolveApiKey(apiKey);
  if (!resolvedApiKey) {
    return {
      success: false,
      content: null,
      error: `API key not found. Tried to resolve "${apiKey}" from environment variables. Please set the corresponding environment variable.`,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const combinedSignal = signal
    ? mergeSignals(signal, controller.signal)
    : controller.signal;

  try {
    // Handle different API types from models.json
    if (
      apiType === "openai-completions" ||
      apiType === "openai-responses" ||
      apiType === "openai"
    ) {
      return await callOpenAICompatible(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
        timeout,
      );
    }
    if (apiType === "anthropic-messages" || apiType === "anthropic") {
      return await callAnthropic(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
        timeout,
      );
    }
    if (apiType === "google-generativelanguage" || apiType === "google") {
      return await callGoogle(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
        timeout,
      );
    }
    // Legacy support for simple types
    if (
      apiType === "deepseek" ||
      apiType === "moonshot" ||
      apiType === "qwen"
    ) {
      return await callOpenAICompatible(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
        timeout,
      );
    }

    return {
      success: false,
      content: null,
      error: `Unsupported apiType: "${apiType}". Supported types: openai-completions, openai-responses, anthropic-messages, google-generativelanguage`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveApiKey(apiKey: string): string {
  // Handle $VAR or ${VAR} format
  const match = apiKey.match(/^\$\{?(\w+)\}?$/);
  if (match) {
    return process.env[match[1]] || "";
  }
  // Handle literal env var name (e.g., "FREE_DEEPSEEK_API_KEY")
  // Check if it's a known env var and return its value
  if (process.env[apiKey]) {
    return process.env[apiKey];
  }
  return apiKey;
}

async function callOpenAICompatible(
  baseUrl: string | undefined,
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  timeout: number,
): Promise<CheapModelResult> {
  // Use /chat/completions for openai-completions, /responses for openai-responses
  const endpoint = baseUrl || "https://api.openai.com/v1";
  const url = `${endpoint}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const errorMsg = `API request failed with status ${response.status}`;
      error("OpenAI compatible API error:", response.status, errorText);
      return {
        success: false,
        content: null,
        error: `${errorMsg}. Check your API key and model ID.`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      content: data.choices?.[0]?.message?.content || null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    if (errorMessage.includes("aborted") && errorMessage.includes("timeout")) {
      return {
        success: false,
        content: null,
        error: `Request timed out after ${timeout}ms. The model may be overloaded or unresponsive.`,
      };
    }
    error("OpenAI compatible API error:", err);
    return {
      success: false,
      content: null,
      error: `Request failed: ${errorMessage}`,
    };
  }
}

async function callAnthropic(
  baseUrl: string | undefined,
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  timeout: number,
): Promise<CheapModelResult> {
  const url = baseUrl
    ? `${baseUrl}/v1/messages`
    : "https://api.anthropic.com/v1/messages";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const errorMsg = `API request failed with status ${response.status}`;
      error("Anthropic API error:", response.status, errorText);
      return {
        success: false,
        content: null,
        error: `${errorMsg}. Check your API key and model ID.`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      content: data.content?.[0]?.text || null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    if (errorMessage.includes("aborted") && errorMessage.includes("timeout")) {
      return {
        success: false,
        content: null,
        error: `Request timed out after ${timeout}ms. The model may be overloaded or unresponsive.`,
      };
    }
    error("Anthropic API error:", err);
    return {
      success: false,
      content: null,
      error: `Request failed: ${errorMessage}`,
    };
  }
}

async function callGoogle(
  baseUrl: string | undefined,
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
  timeout: number,
): Promise<CheapModelResult> {
  const url = baseUrl
    ? `${baseUrl}/v1beta/models/${modelId}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500 },
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const errorMsg = `API request failed with status ${response.status}`;
      error("Google API error:", response.status, errorText);
      return {
        success: false,
        content: null,
        error: `${errorMsg}. Check your API key and model ID.`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      content: data.candidates?.[0]?.content?.parts?.[0]?.text || null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    if (errorMessage.includes("aborted") && errorMessage.includes("timeout")) {
      return {
        success: false,
        content: null,
        error: `Request timed out after ${timeout}ms. The model may be overloaded or unresponsive.`,
      };
    }
    error("Google API error:", err);
    return {
      success: false,
      content: null,
      error: `Request failed: ${errorMessage}`,
    };
  }
}

function mergeSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
  if (!signal1 || signal1.aborted) return signal2;
  if (!signal2 || signal2.aborted) return signal1;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal1.addEventListener("abort", abort, { once: true });
  signal2.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

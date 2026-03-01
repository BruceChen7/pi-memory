/**
 * Lightweight API calls to the cheapest available model for memory extraction.
 * Supports custom base URL and various provider API formats.
 */
import type { PiMemoryConfig } from "./config";
import { debug, error } from "./logger";

export async function callCheapModel(
  config: PiMemoryConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const { baseUrl, apiType, modelId, apiKey, timeout = 10_000 } = config;

  // If no config, we can't make the call
  if (!apiType || !modelId || !apiKey) {
    return null;
  }

  const resolvedApiKey = resolveApiKey(apiKey);
  if (!resolvedApiKey) {
    debug("No API key configured");
    return null;
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
      );
    }
    if (apiType === "anthropic-messages" || apiType === "anthropic") {
      return await callAnthropic(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
      );
    }
    if (apiType === "google-generativelanguage" || apiType === "google") {
      return await callGoogle(
        baseUrl,
        resolvedApiKey,
        modelId,
        prompt,
        combinedSignal,
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
      );
    }
  } finally {
    clearTimeout(timeoutId);
  }

  return null;
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
): Promise<string | null> {
  // Use /chat/completions for openai-completions, /responses for openai-responses
  const endpoint = baseUrl || "https://api.openai.com/v1";
  const url = `${endpoint}/chat/completions`;

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
    error(
      "OpenAI compatible API error:",
      response.status,
      await response.text(),
    );
    return null;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

async function callAnthropic(
  baseUrl: string | undefined,
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const url = baseUrl
    ? `${baseUrl}/v1/messages`
    : "https://api.anthropic.com/v1/messages";

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
    error("Anthropic API error:", response.status, await response.text());
    return null;
  }

  const data = await response.json();
  return data.content?.[0]?.text || null;
}

async function callGoogle(
  baseUrl: string | undefined,
  apiKey: string,
  modelId: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const url = baseUrl
    ? `${baseUrl}/v1beta/models/${modelId}:generateContent`
    : `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

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
    error("Google API error:", response.status, await response.text());
    return null;
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
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

import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { callCheapModel } from "../src/cheap-model";
import { loadConfig } from "../src/config";
import { extractMemoriesInBackground } from "../src/extraction";
import { debug, error } from "../src/logger";
import { MemoryManager } from "../src/memory-manager";

const memoryManager = new MemoryManager();

let lastUserPrompt = "";

function parseMemoryExtractArgs(args: string): {
  focus: string;
  scope?: "global" | "project";
  category?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return { focus: "" };

  const tokens = trimmed.split(/\s+/);
  let scope: "global" | "project" | undefined;
  let category: string | undefined;
  let focus: string | undefined;
  const remainingTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === "global" || token === "project") {
      scope = token;
      continue;
    }

    if (token === "--scope" && i + 1 < tokens.length) {
      const value = tokens[++i];
      if (value === "global" || value === "project") scope = value;
      continue;
    }

    if (token.startsWith("scope=")) {
      const value = token.slice("scope=".length);
      if (value === "global" || value === "project") scope = value;
      continue;
    }

    if (token === "--category" && i + 1 < tokens.length) {
      category = tokens
        .slice(i + 1)
        .join(" ")
        .trim();
      break;
    }

    if (token.startsWith("category=")) {
      category = token.slice("category=".length).trim();
      continue;
    }

    if (token === "--focus" && i + 1 < tokens.length) {
      // Collect all remaining tokens until the next flag
      const focusParts: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (
          tokens[j].startsWith("--") ||
          tokens[j].startsWith("category=") ||
          tokens[j].startsWith("scope=")
        ) {
          i = j - 1;
          break;
        }
        focusParts.push(tokens[j]);
        if (j === tokens.length - 1) i = j;
      }
      focus = focusParts.join(" ").trim();
      continue;
    }

    if (token.startsWith("focus=")) {
      focus = token.slice("focus=".length).trim();
      continue;
    }

    // Unrecognized tokens are treated as focus text
    remainingTokens.push(token);
  }

  return { focus: focus ?? remainingTokens.join(" "), scope, category };
}

async function runMemoryExtract(
  params: { focus: string; scope?: "global" | "project"; category?: string },
  ctx: ExtensionContext | ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const scope = params.scope ?? "project";
  const category = params.category ?? "General";
  const focus = params.focus;

  if (ctx.ui?.setStatus) {
    const theme = ctx.ui.theme;
    const spinner = theme.fg("accent", "●");
    const label = theme.fg("dim", " memory extracting…");
    ctx.ui.setStatus("memory-extract", spinner + label);
  }

  // Get session messages from the current session
  const entries = ctx.sessionManager.getEntries();
  const messageEntries = entries.filter((e) => e.type === "message");

  if (messageEntries.length === 0) {
    return "No messages in session to extract memories from.";
  }

  // Build conversation text from session messages
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; arguments: Record<string, unknown> };
  const conversationParts: string[] = [];
  for (const entry of messageEntries) {
    if (!("message" in entry) || !entry.message) continue;
    const msg = entry.message as {
      role: string;
      content: ContentBlock[] | string;
      isError?: boolean;
      toolName?: string;
      command?: string;
      output?: string;
      exitCode?: number;
    };
    const role = msg.role;

    if (role === "user") {
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n")
        : msg.content;
      if (content) conversationParts.push(`user: ${content}`);
    } else if (role === "assistant") {
      const parts: string[] = [];
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === "text" && c.text) {
            parts.push(c.text);
          } else if (c.type === "toolCall") {
            parts.push(
              `[Tool call: ${c.name}(${JSON.stringify(c.arguments)})]`,
            );
          }
        }
      }
      if (parts.length > 0)
        conversationParts.push(`assistant: ${parts.join("\n")}`);
    } else if (role === "toolResult") {
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n")
        : "";
      if (content) {
        const label = msg.isError ? "Tool error" : "Tool result";
        conversationParts.push(`${label} (${msg.toolName}): ${content}`);
      }
    } else if (role === "bashExecution") {
      conversationParts.push(
        `bash: $ ${msg.command}\n${msg.output}${msg.exitCode ? ` (exit ${msg.exitCode})` : ""}`,
      );
    }
  }

  const conversationText = conversationParts.join("\n\n");

  // Get existing memories for context
  const existingMemories = await memoryManager.getMemoryContext(ctx.cwd);

  // Build extraction prompt
  const extractionPrompt = `You are a memory extraction system. Your job is to identify information worth remembering from a conversation.

<existing_memories>
${existingMemories || "No existing memories."}
</existing_memories>

<conversation>
${conversationText}
</conversation>

Analyze the conversation and determine if there is anything NEW worth remembering that is NOT already in existing memories.

**User-specified focus: ${focus}**
Extract memories primarily related to this focus area. If nothing matches the focus, return empty.

General categories for reference:
1. **User preferences** — coding style, tools, frameworks, communication preferences
2. **Technical decisions** — architecture choices, library selections, patterns adopted
3. **Project facts** — deployment targets, API conventions, team practices
4. **Corrections** — if the user corrected the agent, remember the right way
5. **Explicit requests** — "always do X", "never do Y", "I prefer Z"

Rules:
- Only extract genuinely useful, reusable information
- Do NOT extract one-time task details ("fix the bug on line 42")
- Do NOT extract things already in existing memories
- Do NOT extract obvious things ("user is writing code")
- Keep each memory to ONE concise line
- If nothing is worth remembering, return empty

Respond ONLY with valid JSON, no markdown fences:
{
  "memories": [
    {
      "text": "the memory text",
      "scope": "global or project",
      "category": "User Preferences or Technical Context or Decisions or Project Notes"
    }
  ]
}

If nothing worth remembering, respond: {"memories": []}`;

  try {
    // Load config and call cheap model
    const config = await loadConfig(ctx.cwd);

    if (!config.apiType || !config.modelId || !config.apiKey) {
      return "No cheap model configured. Please set piMemory config in settings.json.";
    }

    const extractionResult = await callCheapModel(
      config,
      extractionPrompt,
      signal ?? AbortSignal.timeout(config.timeout ?? 10_000),
    );

    if (!extractionResult) {
      return "Failed to extract memories from the model.";
    }

    // Process the result
    const result = await memoryManager.processExtractionResult(
      extractionResult,
      ctx.cwd,
    );

    if (result.memories.length === 0) {
      return "No new memories extracted from the session.";
    }

    // Save each extracted memory with the specified scope and category
    for (const mem of result.memories) {
      await memoryManager.appendMemory(mem.text, scope, ctx.cwd, category);
    }

    const memoriesList = result.memories.map((m) => `- ${m.text}`).join("\n");
    return `Extracted ${result.memories.length} memory(s) from session:\n${memoriesList}`;
  } catch (err) {
    error("memory_extract failed:", err);
    return `Error extracting memories: ${err instanceof Error ? err.message : "Unknown error"}`;
  } finally {
    if (ctx.ui?.setStatus) {
      ctx.ui.setStatus("memory-extract", undefined);
    }
  }
}

export default function (pi: ExtensionAPI) {
  // ─── System prompt injection ────────────────────────────────────────
  pi.on(
    "before_agent_start",
    async (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | undefined> => {
      lastUserPrompt = event.prompt;

      const memoryContext = await memoryManager.getMemoryContext(ctx.cwd);
      if (!memoryContext) {
        debug("before_agent_start systemPrompt:\n" + event.systemPrompt);
        return;
      }

      const fullSystemPrompt = `${event.systemPrompt}\n\n${memoryContext}`;
      debug("before_agent_start systemPrompt:\n" + fullSystemPrompt);
      return {
        systemPrompt: fullSystemPrompt,
      };
    },
  );

  // ─── Auto-extraction after agent response ───────────────────────────
  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const messages = event.messages;
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    let agentResponseText = "";
    if ("content" in lastMessage && Array.isArray(lastMessage.content)) {
      for (const block of lastMessage.content) {
        if (typeof block === "string") {
          agentResponseText += block;
        } else if (block && typeof block === "object" && "text" in block) {
          agentResponseText += (block as { text: string }).text;
        }
      }
    }

    if (!agentResponseText || !lastUserPrompt) return;

    extractMemoriesInBackground({
      projectPath: ctx.cwd,
      userMessage: lastUserPrompt,
      agentResponseText,
      memoryManager,
      modelRegistry: ctx.modelRegistry,
      cwd: ctx.cwd,
      ui: ctx.ui,
    }).catch(() => {});
  });

  // ─── memory_read ────────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_read",
    label: "Memory",
    description:
      "Read stored memories. Returns global and project memory contents. Use to check what has already been remembered before adding new entries.",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("global"),
            Type.Literal("project"),
          ],
          { description: "Which memories to read. Default: all" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "all";
      const files = await memoryManager.getMemoryFiles(ctx.cwd);
      const sections: string[] = [];

      if ((scope === "all" || scope === "global") && files.global) {
        sections.push(`## Global Memory\n${files.global}`);
      }
      if ((scope === "all" || scope === "project") && files.projectShared) {
        sections.push(`## Project Memory\n${files.projectShared}`);
      }

      const text =
        sections.length > 0 ? sections.join("\n\n") : "No memories stored.";
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // ─── memory_add ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_add",
    label: "Memory",
    description:
      "Save a memory entry. Use for user preferences, project decisions, conventions, and facts worth remembering across sessions. Avoid one-time task details.",
    parameters: Type.Object({
      text: Type.String({
        description: "The memory to save — one concise line",
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description:
            "global = all projects, project = this project only. Default: project",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description:
            'Category heading, e.g. "User Preferences", "Technical Context", "Decisions". Default: General',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "project";
      const category = params.category ?? "General";
      await memoryManager.appendMemory(params.text, scope, ctx.cwd, category);
      const text = `Saved to ${scope} memory under "${category}": ${params.text}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // ─── memory_remove ──────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_remove",
    label: "Memory",
    description:
      "Remove a memory entry by matching its text. Use when a memory is outdated, wrong, or the user asks to forget something.",
    parameters: Type.Object({
      text: Type.String({
        description:
          "Text to match against existing memories (case-insensitive partial match)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const removed = await memoryManager.removeMemory(params.text, ctx.cwd);
      const text = removed
        ? `Removed memory matching: ${params.text}`
        : `No memory found matching: ${params.text}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // ─── memory_extract ─────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_extract",
    label: "Memory",
    description:
      "Extract memories from the current session conversation using AI. Analyzes the session so far and saves useful information worth remembering.",
    parameters: Type.Object({
      focus: Type.String({
        description:
          "What aspects of the conversation to extract memories from, e.g. 'user coding preferences', 'architecture decisions', 'debugging lessons learned'",
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description:
            "global = all projects, project = this project only. Default: project",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description:
            "Category heading for extracted memories. Default: General",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await runMemoryExtract(params, ctx, _signal);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // Register slash command so /memory_extract appears in autocomplete
  pi.registerCommand("memory_extract", {
    description: "Extract and save reusable memories from the current session",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const trimmed = prefix.trim();

      // If user typed --category, return null for free text input
      if (trimmed.startsWith("--category")) {
        return null;
      }

      // If prefix is empty or starts with something that could be a scope value
      const scopeOptions: AutocompleteItem[] = [
        { value: "global", label: "global (all projects)" },
        { value: "project", label: "project (this project only)" },
      ];

      // If prefix contains --category with a value, still offer --category option
      if (trimmed.includes("--category ")) {
        return null; // User is typing the category value, no completion needed
      }

      // Show scope options if prefix is empty or matches one of them
      if (!trimmed || trimmed.startsWith("g") || trimmed.startsWith("p")) {
        const filtered = scopeOptions.filter((item) =>
          item.value.startsWith(trimmed),
        );
        if (filtered.length > 0) {
          return [
            ...filtered,
            { value: "--category", label: "--category <text>" },
          ];
        }
      }

      // Show --category option if prefix starts with -
      if (trimmed.startsWith("-")) {
        return [{ value: "--category", label: "--category <text>" }];
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parsedArgs = parseMemoryExtractArgs(args);
      if (!parsedArgs.focus) {
        ctx.ui.notify(
          "Usage: /memory_extract <focus> [--scope global|project] [--category <text>]\nExample: /memory_extract user coding preferences",
          "error",
        );
        return;
      }
      const text = await runMemoryExtract(parsedArgs, ctx);
      ctx.ui.notify(text, text.startsWith("Error") ? "error" : "info");
    },
  });
}

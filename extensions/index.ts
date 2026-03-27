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
import { type CheapModelResult, callCheapModel } from "../src/cheap-model";
import { loadConfig } from "../src/config";
import { extractMemoriesInBackground } from "../src/extraction";
import { debug, error } from "../src/logger";
import { MemoryManager } from "../src/memory-manager";
import type {
  MemoryAction,
  MemoryEntry,
  MemoryEntryInput,
} from "../src/memory-types";

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

function formatAction(action: MemoryAction): string {
  switch (action.action) {
    case "create":
      return `create ${action.entry.name} (${action.scope})`;
    case "update":
      return `update ${action.entry.name} (${action.id ?? action.name ?? "unknown"})`;
    case "remove":
      return `remove ${action.id ?? action.name ?? "unknown"}`;
    default:
      return "memory action";
  }
}

function formatEntry(entry: MemoryEntry): string {
  return [
    `Name: ${entry.name}`,
    `Description: ${entry.description}`,
    `Type: ${entry.type}`,
    `Scope: ${entry.scope}`,
    "",
    entry.content,
  ]
    .join("\n")
    .trimEnd();
}

async function runMemoryExtract(
  params: { focus: string; scope?: "global" | "project"; category?: string },
  ctx: ExtensionContext | ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const scope = params.scope ?? "project";
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

  // Get existing memory index for context
  const existingMemories = await memoryManager.getMemoryIndexSummary(ctx.cwd);

  const extractionPrompt = memoryManager.buildExtractionPrompt({
    conversationText,
    existingMemories,
    focus,
  });

  try {
    // Load config and call cheap model
    const config = await loadConfig(ctx.cwd);

    if (!config.apiType || !config.modelId || !config.apiKey) {
      return "No cheap model configured. Please set piMemory config in settings.json.";
    }

    const extractionResult: CheapModelResult = await callCheapModel(
      config,
      extractionPrompt,
      signal ?? AbortSignal.timeout(config.timeout ?? 10_000),
    );

    if (!extractionResult.success) {
      const errorDetail = extractionResult.error
        ? `\n\nDetails: ${extractionResult.error}`
        : "";
      return `Failed to extract memories from the model.${errorDetail}`;
    }

    const resultContent = extractionResult.content;

    if (resultContent) {
      const report = await memoryManager.processExtractionResult(
        resultContent,
        ctx.cwd,
        { defaultScope: scope },
      );

      const applied = report.outcomes.filter(
        (outcome) => outcome.status === "applied",
      );
      const skipped = report.outcomes.filter(
        (outcome) => outcome.status === "skipped",
      );

      if (applied.length === 0) {
        return "No new memories extracted from the session.";
      }

      const appliedLines = applied
        .map((outcome) => `- ${formatAction(outcome.action)}`)
        .join("\n");
      const skippedLines = skipped
        .map(
          (outcome) =>
            `- ${formatAction(outcome.action)}${outcome.message ? ` (${outcome.message})` : ""}`,
        )
        .join("\n");

      let message = `Applied ${applied.length} action(s):\n${appliedLines}`;
      if (skippedLines) {
        message += `\n\nSkipped ${skipped.length} action(s):\n${skippedLines}`;
      }
      return message;
    }
  } catch (err) {
    error("memory_extract failed:", err);
    return `Error extracting memories: ${err instanceof Error ? err.message : "Unknown error"}`;
  } finally {
    if (ctx.ui?.setStatus) {
      ctx.ui.setStatus("memory-extract", undefined);
    }
  }

  return "No new memories extracted from the session.";
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

      const memoryContext = await memoryManager.getMemoryContext(
        ctx.cwd,
        event.prompt,
      );
      if (!memoryContext) {
        debug(`before_agent_start systemPrompt:\n${event.systemPrompt}`);
        return;
      }

      const fullSystemPrompt = `${event.systemPrompt}\n\n${memoryContext}`;
      debug(`before_agent_start systemPrompt:\n${fullSystemPrompt}`);
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
      "Read stored memories. Returns memory index by default or a specific entry when requested.",
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
      mode: Type.Optional(
        Type.Union([Type.Literal("index"), Type.Literal("entry")], {
          description: "Read memory index or a specific entry. Default: index",
        }),
      ),
      id: Type.Optional(
        Type.String({ description: "Entry id (slug) to read" }),
      ),
      name: Type.Optional(Type.String({ description: "Entry name to read" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "all";
      const mode = params.mode ?? "index";

      if (mode === "entry") {
        const id = params.id;
        const name = params.name;
        if (!id && !name) {
          return {
            content: [
              {
                type: "text",
                text: "Specify id or name when mode=entry.",
              },
            ],
            details: undefined,
          };
        }

        const scopes = scope === "all" ? ["project", "global"] : [scope];
        const matches: MemoryEntry[] = [];

        for (const targetScope of scopes) {
          if (id) {
            const entry = await memoryManager.getEntryById(
              targetScope,
              ctx.cwd,
              id,
            );
            if (entry) matches.push(entry);
          } else if (name) {
            const entries = await memoryManager.findEntriesByName(
              targetScope,
              ctx.cwd,
              name,
            );
            matches.push(...entries);
          }
        }

        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: "No memory entry found." }],
            details: undefined,
          };
        }
        if (matches.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: "Multiple matching entries found. Please specify scope or id.",
              },
            ],
            details: undefined,
          };
        }

        return {
          content: [{ type: "text", text: formatEntry(matches[0]) }],
          details: undefined,
        };
      }

      const files = await memoryManager.getMemoryIndexFiles(ctx.cwd);
      const sections: string[] = [];

      if ((scope === "all" || scope === "global") && files.global) {
        sections.push(`## Global Memory Index\n${files.global}`);
      }
      if ((scope === "all" || scope === "project") && files.projectShared) {
        sections.push(`## Project Memory Index\n${files.projectShared}`);
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
      "Save a structured memory entry (name/description/type/content).",
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({
          description: "Legacy input: a one-line memory to save",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Entry name" })),
      description: Type.Optional(
        Type.String({ description: "One-line description" }),
      ),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("user"),
            Type.Literal("feedback"),
            Type.Literal("project"),
            Type.Literal("reference"),
          ],
          { description: "Entry type" },
        ),
      ),
      content: Type.Optional(Type.String({ description: "Entry content" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description:
            "global = all projects, project = this project only. Default: project",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description:
            'Legacy category mapping, e.g. "User Preferences", "Technical Context"',
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? "project";
      const type =
        params.type ?? memoryManager.mapCategoryToType(params.category);

      let entry: MemoryEntryInput | null = null;

      if (params.text) {
        entry = memoryManager.deriveEntryFromText(params.text, type);
      } else if (params.name && params.description && params.content) {
        entry = {
          name: params.name,
          description: params.description,
          type,
          content: params.content,
        };
      }

      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: "Provide either text or name/description/content.",
            },
          ],
          details: undefined,
        };
      }

      const created = await memoryManager.createEntry(scope, ctx.cwd, entry);
      const text = `Saved ${created.name} (${created.id}) to ${scope} memory.`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  // ─── memory_remove ──────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_remove",
    label: "Memory",
    description:
      "Remove a memory entry by id or name. Use when a memory is outdated, wrong, or the user asks to forget something.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Entry id (slug)" })),
      name: Type.Optional(Type.String({ description: "Entry name" })),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description: "Scope to remove from. Default: project",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope;
      const id = params.id;
      const name = params.name;

      if (!id && !name) {
        return {
          content: [
            {
              type: "text",
              text: "Specify id or name to remove.",
            },
          ],
          details: undefined,
        };
      }

      const scopes = scope ? [scope] : ["project", "global"];
      let target: MemoryEntry | null = null;

      if (id) {
        const matches: MemoryEntry[] = [];
        for (const targetScope of scopes) {
          const entry = await memoryManager.getEntryById(
            targetScope,
            ctx.cwd,
            id,
          );
          if (entry) matches.push(entry);
        }
        if (matches.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: "Entry id exists in multiple scopes. Specify scope to remove.",
              },
            ],
            details: undefined,
          };
        }
        target = matches[0] ?? null;
      } else if (name) {
        const matches: MemoryEntry[] = [];
        for (const targetScope of scopes) {
          const entries = await memoryManager.findEntriesByName(
            targetScope,
            ctx.cwd,
            name,
          );
          matches.push(...entries);
        }
        if (matches.length > 1) {
          return {
            content: [
              {
                type: "text",
                text: "Multiple matching entries found. Specify scope or id.",
              },
            ],
            details: undefined,
          };
        }
        target = matches[0] ?? null;
      }

      if (!target) {
        return {
          content: [{ type: "text", text: "No memory entry found." }],
          details: undefined,
        };
      }

      const removed = await memoryManager.removeEntry(
        target.scope,
        ctx.cwd,
        target.id,
      );
      const text = removed
        ? `Removed memory entry: ${target.name}`
        : "Failed to remove memory entry.";
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

  // ─── memory_view command ─────────────────────────────────────────────
  pi.registerCommand("memory_view", {
    description: "View stored memories (default: project level)",
    getArgumentCompletions: (): AutocompleteItem[] | null => {
      return [
        { value: "all", label: "all (show both global and project memories)" },
        { value: "global", label: "global (global level memories only)" },
        { value: "project", label: "project (project level memories only)" },
        { value: "help", label: "help (show usage)" },
      ];
    },
    handler: async (args, ctx) => {
      const usage =
        "Usage: /memory_view [all|global|project|help]\n" +
        "Examples:\n" +
        "  /memory_view\n" +
        "  /memory_view project\n" +
        "  /memory_view global\n" +
        "  /memory_view all";
      const rawArg = args.trim();

      if (rawArg === "help") {
        ctx.ui.notify(usage, "info");
        return;
      }

      const scope = rawArg || "project";
      if (scope !== "all" && scope !== "global" && scope !== "project") {
        ctx.ui.notify(`Invalid argument: "${scope}".\n${usage}`, "error");
        return;
      }

      const files = await memoryManager.getMemoryIndexFiles(ctx.cwd);
      const sections: string[] = [];

      if ((scope === "all" || scope === "global") && files.global) {
        sections.push(`## Global Memory Index\n${files.global}`);
      }
      if ((scope === "all" || scope === "project") && files.projectShared) {
        sections.push(`## Project Memory Index\n${files.projectShared}`);
      }

      const text =
        sections.length > 0 ? sections.join("\n\n") : "No memories stored.";

      // Display using notify with info type
      ctx.ui.notify(text, "info");
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

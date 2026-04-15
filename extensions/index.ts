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
import { loadConfig } from "../src/config";
import { extractMemoriesInBackground } from "../src/extraction";
import { runExtractionPrompt } from "../src/extraction-runner";
import { debug, error } from "../src/logger";
import { MemoryManager } from "../src/memory-manager";
import type {
  MemoryAction,
  MemoryEntry,
  MemoryEntryInput,
} from "../src/memory-types";

const memoryManager = new MemoryManager();

let lastUserPrompt = "";

function syncMemoryManagerRuntimeContext(
  ctx: ExtensionContext | ExtensionCommandContext,
): void {
  memoryManager.setRuntimeModelContext({
    modelRegistry: ctx.modelRegistry,
    currentModel: ctx.model,
  });
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

type SessionMessage = {
  role: string;
  content: ContentBlock[] | string;
  isError?: boolean;
  toolName?: string;
  command?: string;
  output?: string;
  exitCode?: number;
};

type SessionMessageEntry = {
  type: "message";
  message?: SessionMessage;
};

function buildConversationText(messageEntries: SessionMessageEntry[]): string {
  const conversationParts: string[] = [];

  for (const entry of messageEntries) {
    if (!entry.message) continue;
    const msg = entry.message;
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
      continue;
    }

    if (role === "assistant") {
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
      continue;
    }

    if (role === "toolResult") {
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
      continue;
    }

    if (role === "bashExecution") {
      conversationParts.push(
        `bash: $ ${msg.command}\n${msg.output}${msg.exitCode ? ` (exit ${msg.exitCode})` : ""}`,
      );
    }
  }

  return conversationParts.join("\n\n");
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
  ctx: ExtensionContext | ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  syncMemoryManagerRuntimeContext(ctx);
  if (ctx.ui?.setStatus) {
    const theme = ctx.ui.theme;
    const spinner = theme.fg("accent", "●");
    const label = theme.fg("dim", " memory extracting…");
    ctx.ui.setStatus("memory-extract", spinner + label);
  }

  const entries = ctx.sessionManager.getEntries();
  const messageEntries = entries.filter(
    (entry): entry is SessionMessageEntry => entry.type === "message",
  );

  if (messageEntries.length === 0) {
    return "No messages in session to extract memories from.";
  }

  const conversationText = buildConversationText(messageEntries);
  const existingMemories = await memoryManager.getMemoryIndexSummary(ctx.cwd);

  const extractionPrompt = memoryManager.buildExtractionPrompt({
    conversationText,
    existingMemories,
    mode: "exact",
  });

  try {
    const config = await loadConfig(ctx.cwd);

    const extractionResult = await runExtractionPrompt({
      config,
      prompt: extractionPrompt,
      signal: signal ?? AbortSignal.timeout(config.timeout ?? 10_000),
      modelRegistry: ctx.modelRegistry,
      currentModel: ctx.model,
    });

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
      syncMemoryManagerRuntimeContext(ctx);

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
    syncMemoryManagerRuntimeContext(ctx);
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
      syncMemoryManagerRuntimeContext(ctx);
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
            Type.Literal("preference"),
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
      syncMemoryManagerRuntimeContext(ctx);
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
      syncMemoryManagerRuntimeContext(ctx);
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

  // ─── memory_extract ────────────────────────────────────────────────
  pi.registerTool({
    name: "memory_extract",
    label: "Memory",
    description:
      "Extract memories with exact rules from the current session conversation using AI.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const text = await runMemoryExtract(ctx, _signal);
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
      syncMemoryManagerRuntimeContext(ctx);
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
    description: "Extract memories with exact rules from the current session",
    handler: async (args, ctx) => {
      syncMemoryManagerRuntimeContext(ctx);
      if (args.trim()) {
        ctx.ui.notify("Usage: /memory_extract", "error");
        return;
      }
      const text = await runMemoryExtract(ctx);
      ctx.ui.notify(text, text.startsWith("Error") ? "error" : "info");
    },
  });
}

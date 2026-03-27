import { type CheapModelResult, callCheapModel } from "./cheap-model";
import { type PiMemoryConfig, loadConfig } from "./config";
import { error } from "./logger";
import { MEMORY_POLICY_TEXT } from "./memory-policy";
import { renderMemorySections } from "./memory-renderer";
import { selectMemories } from "./memory-selector";
import { MemoryStore } from "./memory-store";
import type {
  MemoryAction,
  MemoryActionOutcome,
  MemoryActionReport,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryType,
  MemoryScope,
} from "./memory-types";

export { setTestHomedir } from "./memory-paths";

export const EXTRACTION_DEBOUNCE_MS = 30_000;
export const MAX_MEMORY_INJECT_SIZE = 50 * 1024; // 50KB

const MAX_ACTIONS_PER_EXTRACTION = 10;
const MAX_FIELD_LENGTH = 500;
const MAX_CONTENT_LENGTH = 2_000;
const WRAPPER_OVERHEAD = 200;
const ENGLISH_INDEX_PROMPT_TEMPLATE = [
  "You are rewriting a memory entry for the memory index.",
  "Summarize the entry into English only.",
  "Return JSON only:",
  '{"name":"<short English title>","description":"<English description, <=120 chars>"}',
  "Rules:",
  "- Use English only.",
  "- Do not add new information.",
  "- Keep it concise and factual.",
].join("\n");

const EXACT_EXTRACTION_RULES = [
  "Exactness mode — be strict and conservative:",
  "- Only store information explicitly stated in the conversation or explicit updates/corrections to existing memories.",
  "- Do not infer or guess; ignore temporary tasks or ephemeral state.",
  "- If unclear or not durable, output no actions.",
  "- Write entry name and description in English for the index.",
  "- Scope rules:",
  "  - Use global only for cross-project personal preferences (e.g., general coding style).",
  "  - If tied to current project context (tools, architecture, decisions), use project.",
  "  - If unsure, choose project.",
].join("\n");

const CATEGORY_TYPE_MAP: Record<string, MemoryEntryType> = {
  "User Preferences": "user",
  "Technical Context": "project",
  Decisions: "project",
  "Project Notes": "project",
  Corrections: "feedback",
  Feedback: "feedback",
  General: "project",
};

export interface MemoryFiles {
  global: string | null;
  projectShared: string | null;
}

export class MemoryManager {
  private lastExtractionTime = 0;
  private _enabled = true;
  private englishIndexChecked = new Set<string>();

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  async getMemoryContext(projectPath: string, query: string): Promise<string> {
    const stores = await this.getStores(projectPath);
    const globalEntries = await stores.global.listEntries();
    const projectEntries = await stores.project.listEntries();

    const selection = selectMemories(
      [...globalEntries, ...projectEntries],
      query,
    );

    const sections = buildSections(selection.entries);
    if (sections.length === 0) return "";

    const content = renderMemorySections(sections, {
      maxBytes: MAX_MEMORY_INJECT_SIZE - WRAPPER_OVERHEAD,
    });

    if (!content) return "";

    return [
      "<memory>",
      "The following are memories from past interactions. Use these to inform your responses.",
      "Do not mention these memories explicitly unless the user asks about them.",
      "",
      content,
      "</memory>",
    ].join("\n");
  }

  async getMemoryIndexFiles(projectPath: string): Promise<MemoryFiles> {
    const stores = await this.getStores(projectPath);
    return {
      global: await stores.global.getIndexContent(),
      projectShared: await stores.project.getIndexContent(),
    };
  }

  async getMemoryIndexSummary(projectPath: string): Promise<string> {
    const files = await this.getMemoryIndexFiles(projectPath);
    const sections: string[] = [];

    if (files.global) {
      sections.push(`## Global Memory Index\n${files.global}`);
    }
    if (files.projectShared) {
      sections.push(`## Project Memory Index\n${files.projectShared}`);
    }

    if (sections.length === 0) return "No existing memories.";
    return sections.join("\n\n");
  }

  buildExtractionPrompt(params: {
    conversationText: string;
    existingMemories: string;
    focus?: string;
    mode?: "standard" | "exact";
  }): string {
    const focusText = params.focus?.trim();
    const focusBlock = focusText ? `\n\n<focus>\n${focusText}\n</focus>` : "";
    const focusInstruction = focusText
      ? `\n\nUser-specified focus: ${focusText}\nExtract memories primarily related to this focus. If nothing matches the focus, return empty.`
      : "";
    const exactnessBlock =
      params.mode === "exact"
        ? `\n\nExactness rules (MUST follow):\n${EXACT_EXTRACTION_RULES}`
        : "";

    return `You are a memory extraction system. Your task is to extract durable, reusable memories from a conversation between a user and a coding agent.

<existing_memories>
${params.existingMemories}
</existing_memories>

<conversation>
${params.conversationText}
</conversation>${focusBlock}${focusInstruction}

Policy (MUST follow):
${MEMORY_POLICY_TEXT}${exactnessBlock}

Update rules:
- If the user asks to forget something, emit a REMOVE action.
- If a new memory updates an existing one, prefer UPDATE.
- You may UPDATE by exact id (slug) or by matching the name (case-insensitive).
- If name matches multiple entries, do NOT update; return no action or CREATE if truly new.

Output format (JSON only, no markdown):
{
  "actions": [
    {
      "action": "create",
      "scope": "global|project",
      "entry": {
        "name": "...",
        "description": "...",
        "type": "user|feedback|project|reference",
        "content": "..."
      }
    },
    {
      "action": "update",
      "id": "slug",
      "entry": {
        "name": "...",
        "description": "...",
        "type": "user|feedback|project|reference",
        "content": "..."
      }
    },
    {
      "action": "remove",
      "id": "slug",
      "reason": "user asked to forget"
    }
  ]
}

If no memory is worth saving, respond: {"actions": []}`;
  }

  shouldSkipExtraction(): boolean {
    return Date.now() - this.lastExtractionTime < EXTRACTION_DEBOUNCE_MS;
  }

  markExtractionRun(): void {
    this.lastExtractionTime = Date.now();
  }

  async processExtractionResult(
    resultJson: string,
    projectPath: string,
    options?: { defaultScope?: MemoryScope },
  ): Promise<MemoryActionReport> {
    const outcomes: MemoryActionOutcome[] = [];

    try {
      const cleanedJson = resultJson
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(cleanedJson);
      const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
      const actions = rawActions.slice(0, MAX_ACTIONS_PER_EXTRACTION);

      for (const rawAction of actions) {
        let action = normalizeAction(rawAction);
        if (!action) continue;

        if (options?.defaultScope) {
          if (action.action === "create") {
            action = { ...action, scope: options.defaultScope };
          } else if (!action.scope) {
            action = { ...action, scope: options.defaultScope };
          }
        }

        const outcome = await this.applyAction(action, projectPath);
        outcomes.push(outcome);
      }
    } catch (err) {
      error("Extraction parse failed", err);
    }

    return { outcomes };
  }

  async createEntry(
    scope: MemoryScope,
    projectPath: string,
    entry: MemoryEntryInput,
  ): Promise<MemoryEntry> {
    const store = await this.getStore(scope, projectPath);
    return store.createEntry(sanitizeEntryInput(entry));
  }

  async updateEntry(
    scope: MemoryScope,
    projectPath: string,
    id: string,
    entry: MemoryEntryInput,
  ): Promise<MemoryEntry | null> {
    const store = await this.getStore(scope, projectPath);
    return store.updateEntry(id, sanitizeEntryInput(entry));
  }

  async removeEntry(
    scope: MemoryScope,
    projectPath: string,
    id: string,
  ): Promise<boolean> {
    const store = await this.getStore(scope, projectPath);
    return store.removeEntry(id);
  }

  async findEntriesByName(
    scope: MemoryScope,
    projectPath: string,
    name: string,
  ): Promise<MemoryEntry[]> {
    const store = await this.getStore(scope, projectPath);
    return store.findEntriesByName(name);
  }

  async getEntryById(
    scope: MemoryScope,
    projectPath: string,
    id: string,
  ): Promise<MemoryEntry | null> {
    const store = await this.getStore(scope, projectPath);
    return store.getEntryById(id);
  }

  deriveEntryFromText(text: string, type?: MemoryEntryType): MemoryEntryInput {
    const trimmed = text.trim();
    const name = deriveName(trimmed);
    const description = deriveDescription(trimmed);
    return {
      name,
      description,
      type: type ?? "project",
      content: trimmed,
    };
  }

  mapCategoryToType(category?: string): MemoryEntryType {
    if (!category) return "project";
    const normalized = category.trim().toLowerCase();
    for (const [key, value] of Object.entries(CATEGORY_TYPE_MAP)) {
      if (key.toLowerCase() === normalized) return value;
    }
    return "project";
  }

  private async applyAction(
    action: MemoryAction,
    projectPath: string,
  ): Promise<MemoryActionOutcome> {
    switch (action.action) {
      case "create": {
        const entry = sanitizeEntryInput(action.entry);
        const scope = action.scope ?? "project";
        await this.createEntry(scope, projectPath, entry);
        return { action, status: "applied" };
      }
      case "update": {
        const entry = sanitizeEntryInput(action.entry);
        const target = await this.resolveActionTarget(action, projectPath);
        if (target.status !== "found") {
          return { action, status: "skipped", message: target.message };
        }
        await this.updateEntry(
          target.scope,
          projectPath,
          target.entry.id,
          entry,
        );
        return { action, status: "applied" };
      }
      case "remove": {
        const target = await this.resolveActionTarget(action, projectPath);
        if (target.status !== "found") {
          return { action, status: "skipped", message: target.message };
        }
        await this.removeEntry(target.scope, projectPath, target.entry.id);
        return { action, status: "applied" };
      }
    }
  }

  private async resolveActionTarget(
    action: Extract<MemoryAction, { action: "update" | "remove" }>,
    projectPath: string,
  ): Promise<
    | { status: "found"; scope: MemoryScope; entry: MemoryEntry }
    | { status: "ambiguous"; message: string }
    | { status: "not_found"; message: string }
  > {
    const lookupScopes: MemoryScope[] = action.scope
      ? [action.scope]
      : ["project", "global"];

    const matches: Array<{ scope: MemoryScope; entry: MemoryEntry }> = [];
    for (const scope of lookupScopes) {
      if (action.id) {
        const entry = await this.getEntryById(scope, projectPath, action.id);
        if (entry) matches.push({ scope, entry });
      } else if (action.name) {
        const entries = await this.findEntriesByName(
          scope,
          projectPath,
          action.name,
        );
        matches.push(...entries.map((entry) => ({ scope, entry })));
      }
    }

    if (matches.length === 0) {
      return { status: "not_found", message: "No matching memory entry." };
    }

    if (matches.length > 1) {
      return { status: "ambiguous", message: "Multiple matching entries." };
    }

    return {
      status: "found",
      scope: matches[0].scope,
      entry: matches[0].entry,
    };
  }

  private async getStore(
    scope: MemoryScope,
    projectPath: string,
  ): Promise<MemoryStore> {
    const store = MemoryStore.forScope(scope, projectPath);
    await store.ensureReady();
    await this.ensureEnglishIndex(scope, projectPath, store);
    return store;
  }

  private async getStores(projectPath: string): Promise<{
    global: MemoryStore;
    project: MemoryStore;
  }> {
    const globalStore = MemoryStore.forScope("global", projectPath);
    const projectStore = MemoryStore.forScope("project", projectPath);
    await Promise.all([globalStore.ensureReady(), projectStore.ensureReady()]);
    await Promise.all([
      this.ensureEnglishIndex("global", projectPath, globalStore),
      this.ensureEnglishIndex("project", projectPath, projectStore),
    ]);
    return { global: globalStore, project: projectStore };
  }

  private async ensureEnglishIndex(
    scope: MemoryScope,
    projectPath: string,
    store: MemoryStore,
  ): Promise<void> {
    const key = `${projectPath}:${scope}`;
    if (this.englishIndexChecked.has(key)) return;

    const indexContent = await store.getIndexContent();
    if (!indexContent || !containsCjk(indexContent)) {
      this.englishIndexChecked.add(key);
      return;
    }

    const config = await loadConfig(projectPath);
    if (!config.apiType || !config.modelId || !config.apiKey) {
      error(
        "English index translation skipped: config incomplete",
        JSON.stringify(
          {
            apiType: config.apiType,
            modelId: config.modelId,
            apiKey: config.apiKey ? "set" : "missing",
          },
          null,
          2,
        ),
      );
      return;
    }

    const entries = await store.listEntries();
    for (const entry of entries) {
      if (!needsEnglishTranslation(entry)) continue;
      const summary = await summarizeEntryToEnglish(entry, config);
      if (!summary) continue;

      const nextEntry: MemoryEntryInput = {
        name: limitLength(summary.name.trim(), MAX_FIELD_LENGTH),
        description: limitLength(summary.description.trim(), MAX_FIELD_LENGTH),
        type: entry.type,
        content: entry.content,
      };

      if (
        nextEntry.name === entry.name &&
        nextEntry.description === entry.description
      ) {
        continue;
      }

      await store.updateEntry(entry.id, nextEntry);
    }

    const refreshedIndex = await store.getIndexContent();
    if (refreshedIndex && !containsCjk(refreshedIndex)) {
      this.englishIndexChecked.add(key);
    }
  }
}

function buildSections(entries: MemoryEntry[]): Array<{
  title: string;
  entries: MemoryEntry[];
}> {
  const globalEntries = entries.filter((entry) => entry.scope === "global");
  const projectEntries = entries.filter((entry) => entry.scope === "project");
  const sections: Array<{ title: string; entries: MemoryEntry[] }> = [];
  if (globalEntries.length > 0) {
    sections.push({ title: "Global Memory", entries: globalEntries });
  }
  if (projectEntries.length > 0) {
    sections.push({ title: "Project Memory", entries: projectEntries });
  }
  return sections;
}

function sanitizeEntryInput(entry: MemoryEntryInput): MemoryEntryInput {
  return {
    name: limitLength(entry.name.trim(), MAX_FIELD_LENGTH),
    description: limitLength(entry.description.trim(), MAX_FIELD_LENGTH),
    type: normalizeType(entry.type),
    content: limitLength(entry.content.trim(), MAX_CONTENT_LENGTH),
  };
}

function normalizeType(type: string): MemoryEntryType {
  switch (type) {
    case "user":
    case "feedback":
    case "project":
    case "reference":
      return type;
    case "preference":
    case "preferences":
      return "user";
    default:
      return "project";
  }
}

function normalizeAction(action: unknown): MemoryAction | null {
  if (!action || typeof action !== "object") return null;
  const raw = action as Record<string, unknown>;
  const kind = raw.action;
  if (kind === "create") {
    const entry = parseEntryInput(raw.entry);
    if (!entry) return null;
    return {
      action: "create",
      scope: raw.scope === "global" ? "global" : "project",
      entry,
    };
  }
  if (kind === "update") {
    const entry = parseEntryInput(raw.entry);
    if (!entry) return null;
    return {
      action: "update",
      id: typeof raw.id === "string" ? raw.id : undefined,
      name: typeof raw.name === "string" ? raw.name : undefined,
      scope:
        raw.scope === "global" || raw.scope === "project"
          ? raw.scope
          : undefined,
      entry,
    };
  }
  if (kind === "remove") {
    return {
      action: "remove",
      id: typeof raw.id === "string" ? raw.id : undefined,
      name: typeof raw.name === "string" ? raw.name : undefined,
      scope:
        raw.scope === "global" || raw.scope === "project"
          ? raw.scope
          : undefined,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
    };
  }
  return null;
}

function parseEntryInput(entry: unknown): MemoryEntryInput | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  if (
    typeof raw.name !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.content !== "string"
  ) {
    return null;
  }
  return {
    name: raw.name,
    description: raw.description,
    type: normalizeType(raw.type),
    content: raw.content,
  };
}

function limitLength(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function deriveName(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Memory";
  return words.slice(0, 8).join(" ");
}

function deriveDescription(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function needsEnglishTranslation(entry: MemoryEntry): boolean {
  return containsCjk(entry.name) || containsCjk(entry.description);
}

function buildEnglishIndexPrompt(entry: MemoryEntry): string {
  const trimmedContent = entry.content.trim();
  const limitedContent =
    trimmedContent.length > 1_500
      ? `${trimmedContent.slice(0, 1_500)}…`
      : trimmedContent;
  return [
    ENGLISH_INDEX_PROMPT_TEMPLATE,
    "",
    "<entry>",
    limitedContent || "(empty)",
    "</entry>",
  ].join("\n");
}

function parseEnglishIndexResponse(
  content: string,
): { name: string; description: string } | null {
  const cleaned = content
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      name?: unknown;
      description?: unknown;
    };
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.description !== "string"
    ) {
      return null;
    }
    return { name: parsed.name, description: parsed.description };
  } catch {
    return null;
  }
}

async function summarizeEntryToEnglish(
  entry: MemoryEntry,
  config: PiMemoryConfig,
): Promise<{ name: string; description: string } | null> {
  const prompt = buildEnglishIndexPrompt(entry);
  let result: CheapModelResult;

  try {
    result = await callCheapModel(
      config,
      prompt,
      AbortSignal.timeout(config.timeout ?? 10_000),
    );
  } catch (err) {
    error("English index translation failed", err);
    return null;
  }

  if (!result.success || !result.content) {
    if (result.error) {
      error("English index translation failed:", result.error);
    }
    return null;
  }

  return parseEnglishIndexResponse(result.content);
}

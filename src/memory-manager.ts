import fs from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import path from "node:path";

import { error } from "./logger";

// Test-only: allow overriding homedir for testing
let _customHomedir: (() => string) | null = null;

function homedir(): string {
  if (_customHomedir) {
    return _customHomedir();
  }
  return osHomedir();
}

// Export test helper
export function setTestHomedir(fn: (() => string) | null): void {
  _customHomedir = fn;
}

// New global memory path (unified with project memory structure) - resolved lazily
function resolveGlobalMemoryPath(): string {
  return path.join(homedir(), ".pi", "pi-memory", "MEMORY.md");
}

// Legacy global memory paths for migration
function resolveLegacyGlobalMemoryPaths(): string[] {
  const legacyPaths: string[] = [];
  switch (process.platform) {
    case "win32":
      legacyPaths.push(
        path.join(
          process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
          ".pi-memory",
          "MEMORY.md",
        ),
      );
      break;
    case "linux":
      legacyPaths.push(
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
          ".pi-memory",
          "MEMORY.md",
        ),
      );
      break;
    default:
      legacyPaths.push(
        path.join(homedir(), ".config", ".pi-memory", "MEMORY.md"),
      );
      break;
  }
  return legacyPaths;
}

function resolveProjectMemoryPath(projectPath: string): string {
  return path.join(projectPath, ".pi", "pi-memory", "MEMORY.md");
}

function resolveLegacyProjectMemoryPaths(projectPath: string): string[] {
  return [path.join(projectPath, ".pi-memory", "MEMORY.md")];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function migrateMemoryFile(
  legacyPath: string,
  newPath: string,
): Promise<void> {
  try {
    const legacyExists = await fileExists(legacyPath);
    if (!legacyExists) return;

    const newExists = await fileExists(newPath);
    if (newExists) return;

    const legacyContent = await fs.readFile(legacyPath, "utf-8");
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(newPath, legacyContent, "utf-8");
    await fs.unlink(legacyPath);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      error("Memory migration failed", err);
    }
  }
}

async function migrateProjectMemoryFile(projectPath: string): Promise<void> {
  const projectMemoryPath = resolveProjectMemoryPath(projectPath);

  if (await fileExists(projectMemoryPath)) {
    return;
  }

  const legacyPaths = resolveLegacyProjectMemoryPaths(projectPath);
  for (const legacyPath of legacyPaths) {
    if (await fileExists(legacyPath)) {
      await migrateMemoryFile(legacyPath, projectMemoryPath);
      return;
    }
  }
}

async function migrateGlobalMemoryFile(): Promise<void> {
  const legacyPaths = resolveLegacyGlobalMemoryPaths();

  for (const legacyPath of legacyPaths) {
    const legacyExists = await fileExists(legacyPath);
    if (!legacyExists) continue;

    const globalPath = resolveGlobalMemoryPath();
    await fs.mkdir(path.dirname(globalPath), { recursive: true });

    const legacyContent = await fs.readFile(legacyPath, "utf-8");
    const newExists = await fileExists(globalPath);

    if (newExists) {
      // Merge legacy content into new file, avoiding duplicates
      const newContent = await fs.readFile(globalPath, "utf-8");
      const legacyLines = legacyContent.split("\n");
      const newLines = newContent.split("\n");
      const newSet = new Set(
        newLines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2)),
      );

      const mergedLines = [...newLines];
      for (const line of legacyLines) {
        if (line.startsWith("- ") && !newSet.has(line.slice(2))) {
          mergedLines.push(line);
        } else if (line.startsWith("## ")) {
          // Append category if it doesn't exist in new file
          const category = line;
          if (!newContent.includes(category)) {
            mergedLines.push("", category);
          }
        }
      }

      await fs.writeFile(globalPath, mergedLines.join("\n"), "utf-8");
    } else {
      await fs.writeFile(globalPath, legacyContent, "utf-8");
    }

    await fs.unlink(legacyPath);
    return;
  }
}

export const EXTRACTION_DEBOUNCE_MS = 30_000;
export const MAX_MEMORY_INJECT_SIZE = 50 * 1024; // 50KB

export interface MemoryExtractionResult {
  shouldSave: boolean;
  memories: Array<{
    text: string;
    scope: "global" | "project";
    category: string;
  }>;
}

export interface MemoryFiles {
  global: string | null;
  projectShared: string | null;
}

export class MemoryManager {
  private lastExtractionTime = 0;
  private _enabled = true;

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  async getMemoryContext(projectPath: string): Promise<string> {
    await migrateGlobalMemoryFile();
    await migrateProjectMemoryFile(projectPath);

    const global = await this.loadFile(resolveGlobalMemoryPath());
    const projectShared = await this.loadFile(
      resolveProjectMemoryPath(projectPath),
    );

    const sections: string[] = [];

    if (global) {
      sections.push(`## Global Memory\n${global}`);
    }
    if (projectShared) {
      sections.push(`## Project Memory\n${projectShared}`);
    }

    if (sections.length === 0) return "";

    let content = sections.join("\n\n");

    const WRAPPER_OVERHEAD = 200;
    const effectiveLimit = MAX_MEMORY_INJECT_SIZE - WRAPPER_OVERHEAD;

    if (Buffer.byteLength(content, "utf-8") > effectiveLimit) {
      const lines = content.split("\n");
      const lineSizes = lines.map((line) => Buffer.byteLength(line, "utf-8"));
      let totalSize = lineSizes.reduce((a, b) => a + b, 0) + lines.length - 1;

      const bulletIndices: number[] = [];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith("- ")) {
          bulletIndices.push(i);
        }
      }

      const toRemove = new Set<number>();
      for (const idx of bulletIndices) {
        if (lines.length - toRemove.size <= 10) break;

        totalSize -= lineSizes[idx] + 1;
        toRemove.add(idx);

        if (totalSize <= effectiveLimit) break;
      }

      content = lines.filter((_, i) => !toRemove.has(i)).join("\n");
    }

    return [
      "<memory>",
      "The following are memories from past interactions. Use these to inform your responses.",
      "Do not mention these memories explicitly unless the user asks about them.",
      "",
      content,
      "</memory>",
    ].join("\n");
  }

  async getMemoryFiles(projectPath: string): Promise<MemoryFiles> {
    await migrateGlobalMemoryFile();
    await migrateProjectMemoryFile(projectPath);

    return {
      global: await this.loadFile(resolveGlobalMemoryPath()),
      projectShared: await this.loadFile(resolveProjectMemoryPath(projectPath)),
    };
  }

  buildExtractionPrompt(
    userMessage: string,
    agentResponse: string,
    existingMemories: string,
  ): string {
    return `
## Auto Memory
You are a memory extraction system. Your job is to identify information worth remembering from a conversation between a user and a coding agent.
<existing_memories>
${existingMemories}
</existing_memories>

<latest_exchange>
User: ${userMessage}

Agent: ${agentResponse}
</latest_exchange>

* If the user explicitly asks you to remember something, save it immediately as whichever type fits best.
* If they ask you to forget something, find and remove the relevant entry.


### What Shoud you Rembered

* You should build up this memory system over time so that future conversations can have a complete picture of who the user is,
* how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.

### What NOT to save in memory

- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
- Git history, recent changes, or who-changed-what — git log / git blame are authoritative.
- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
- Anything already documented in CLAUDE.md files.
- Ephemeral task details: in-progress work, temporary state, current conversation context.

These exclusions apply even when the user explicitly asks you to save.
If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

### How to save memories

Saving a memory is a two-step process:

#### Step 1

write the memory to its own file (e.g., user_role.md, feedback_testing.md) using this frontmatter format:

---
name: {{memory name}}
description: {{one-line description — used to decide relevance in future conversations, so be specific}}
type: {{user, feedback, project, reference}}
---

{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}

#### Step 2
* add a pointer to that file in MEMORY.md. MEMORY.md is an index, not a memory — each entry should be one line, under ~150 characters: - [Title](file.md) — one-line hook
* It has no frontmatter. Never write memory content directly into "MEMORY.md".

- MEMORY.md is always loaded into your conversation context — lines after 200 will be truncated, so keep the index concise
- Keep the name, description, and type fields in memory files up-to-date with the content
- Organize memory semantically by topic, not chronologically
- Update or remove memories that turn out to be wrong or outdated
- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.


### When to access memories
- When memories seem relevant, or the user references prior-conversation work.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time.
- Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources.
- If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

If nothing worth remembering, respond: {"memories": []}`;
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
  ): Promise<MemoryExtractionResult> {
    try {
      const MAX_MEMORIES_PER_EXTRACTION = 10;
      const MAX_MEMORY_TEXT_LENGTH = 500;
      const MAX_CATEGORY_LENGTH = 50;

      // Strip markdown code fences if present (LLM sometimes wraps JSON in ```json ... ```)
      const cleanedJson = resultJson
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const parsed = JSON.parse(cleanedJson);
      const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
      const memories = rawMemories.slice(0, MAX_MEMORIES_PER_EXTRACTION);

      if (memories.length > 0) {
        for (const mem of memories) {
          if (mem.text && typeof mem.text === "string") {
            const text =
              mem.text.length > MAX_MEMORY_TEXT_LENGTH
                ? `${mem.text.slice(0, MAX_MEMORY_TEXT_LENGTH)}…`
                : mem.text;
            const category = (
              typeof mem.category === "string" ? mem.category : "General"
            ).slice(0, MAX_CATEGORY_LENGTH);
            await this.appendMemory(
              text,
              mem.scope === "global" ? "global" : "project",
              projectPath,
              category,
            );
          }
        }
      }

      return { shouldSave: memories.length > 0, memories };
    } catch (err) {
      error("Extraction parse failed", err);
      return { shouldSave: false, memories: [] };
    }
  }

  async appendMemory(
    text: string,
    scope: "global" | "project",
    projectPath: string,
    category: string = "General",
  ): Promise<void> {
    await migrateGlobalMemoryFile();
    await migrateProjectMemoryFile(projectPath);

    const filePath = this.resolveFilePath(scope, projectPath);

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      content = "# Memory\n";
    }

    if (content.includes(text)) return;

    const categoryHeading = `## ${category}`;
    if (content.includes(categoryHeading)) {
      const idx = content.indexOf(categoryHeading);
      const nextHeadingIdx = content.indexOf(
        "\n## ",
        idx + categoryHeading.length,
      );
      const insertIdx = nextHeadingIdx === -1 ? content.length : nextHeadingIdx;
      content =
        content.slice(0, insertIdx).trimEnd() +
        `\n- ${text}\n` +
        content.slice(insertIdx);
    } else {
      content = `${content.trimEnd()}\n\n${categoryHeading}\n- ${text}\n`;
    }

    await fs.writeFile(filePath, content, "utf-8");
  }

  async removeMemory(text: string, projectPath: string): Promise<boolean> {
    await migrateGlobalMemoryFile();
    await migrateProjectMemoryFile(projectPath);

    const files = [
      resolveGlobalMemoryPath(),
      resolveProjectMemoryPath(projectPath),
    ];

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");
        const matchIdx = lines.findIndex(
          (line) =>
            line.toLowerCase().includes(text.toLowerCase()) &&
            line.startsWith("- "),
        );
        if (matchIdx !== -1) {
          lines.splice(matchIdx, 1);
          await fs.writeFile(filePath, lines.join("\n"), "utf-8");
          return true;
        }
      } catch {
        // ignore and continue
      }
    }
    return false;
  }

  private resolveFilePath(
    scope: "global" | "project",
    projectPath: string,
  ): string {
    switch (scope) {
      case "global":
        return resolveGlobalMemoryPath();
      case "project":
        return resolveProjectMemoryPath(projectPath);
    }
  }

  private async loadFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }
}

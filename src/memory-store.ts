import fs from "node:fs/promises";
import path from "node:path";

import { error } from "./logger";
import { homedir } from "./memory-paths";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryType,
  MemoryScope,
} from "./memory-types";

const INDEX_FILE_NAME = "MEMORY.md";
const ENTRIES_DIR_NAME = "entries";
const LEGACY_BACKUP_BASENAME = "MEMORY.legacy";
const INDEX_HEADER = "# Memory Index";
const TYPE_ORDER: MemoryEntryType[] = [
  "user",
  "project",
  "feedback",
  "reference",
];

interface ParsedEntry {
  metadata: Partial<MemoryEntryInput>;
  content: string;
}

interface LegacyBullet {
  category: string;
  text: string;
}

interface LegacyMigrationResult {
  migratedCount: number;
  skippedCount: number;
}

const CATEGORY_TYPE_MAP: Record<string, MemoryEntryType> = {
  "User Preferences": "user",
  "Technical Context": "project",
  Decisions: "project",
  "Project Notes": "project",
  Corrections: "feedback",
  Feedback: "feedback",
  General: "project",
};

export class MemoryStore {
  private readonly rootPath: string;
  private readonly entriesPath: string;
  private readonly indexPath: string;

  constructor(
    private readonly scope: MemoryScope,
    private readonly projectPath: string,
  ) {
    this.rootPath =
      scope === "global"
        ? resolveGlobalRootPath()
        : resolveProjectRootPath(projectPath);
    this.entriesPath = path.join(this.rootPath, ENTRIES_DIR_NAME);
    this.indexPath = path.join(this.rootPath, INDEX_FILE_NAME);
  }

  static forScope(scope: MemoryScope, projectPath: string): MemoryStore {
    return new MemoryStore(scope, projectPath);
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.rootPath, { recursive: true });
    await fs.mkdir(this.entriesPath, { recursive: true });

    const legacyContents = await this.readLegacyContents();
    const existingIndexContent = await this.readIndexFile();

    const legacyIndexContent =
      existingIndexContent && !isIndexFormat(existingIndexContent)
        ? existingIndexContent
        : null;

    const migrationSources = [
      ...legacyContents,
      ...(legacyIndexContent ? [legacyIndexContent] : []),
    ];

    if (migrationSources.length > 0) {
      await this.backupLegacyContent(migrationSources);
      await this.migrateLegacyContents(migrationSources);
    }

    const entries = await this.listEntries();
    await this.writeIndex(entries);
  }

  async listEntries(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    let files: string[] = [];
    try {
      files = await fs.readdir(this.entriesPath);
    } catch {
      return entries;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(this.entriesPath, file);
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const parsed = parseEntryFile(raw);
        if (!parsed) continue;
        const id = file.replace(/\.md$/i, "");
        const entry = buildEntryFromParsed(id, this.scope, filePath, parsed);
        if (entry) entries.push(entry);
      } catch (err) {
        error("Failed to read memory entry", err);
      }
    }

    return entries;
  }

  async getIndexContent(): Promise<string | null> {
    return this.readIndexFile();
  }

  async getEntryById(id: string): Promise<MemoryEntry | null> {
    try {
      const filePath = path.join(this.entriesPath, `${id}.md`);
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = parseEntryFile(raw);
      if (!parsed) return null;
      return buildEntryFromParsed(id, this.scope, filePath, parsed);
    } catch {
      return null;
    }
  }

  async findEntriesByName(name: string): Promise<MemoryEntry[]> {
    const normalized = normalizeName(name);
    const entries = await this.listEntries();
    return entries.filter((entry) => normalizeName(entry.name) === normalized);
  }

  async createEntry(entry: MemoryEntryInput): Promise<MemoryEntry> {
    const normalizedEntry = normalizeEntryInput(entry);
    const existingEntries = await this.listEntries();
    const normalizedContent = normalizeText(normalizedEntry.content);
    const existingMatch = existingEntries.find(
      (existing) => normalizeText(existing.content) === normalizedContent,
    );
    if (existingMatch) return existingMatch;

    const existingSlugs = new Set(existingEntries.map((e) => e.id));
    const slugBase = slugify(normalizedEntry.name);
    const slug = ensureUniqueSlug(slugBase, existingSlugs);
    const filePath = path.join(this.entriesPath, `${slug}.md`);

    await fs.writeFile(filePath, serializeEntry(normalizedEntry), "utf-8");

    const newEntry: MemoryEntry = {
      ...normalizedEntry,
      id: slug,
      scope: this.scope,
      filePath,
    };

    await this.writeIndex([...existingEntries, newEntry]);
    return newEntry;
  }

  async updateEntry(
    id: string,
    entry: MemoryEntryInput,
  ): Promise<MemoryEntry | null> {
    const existing = await this.getEntryById(id);
    if (!existing) return null;

    const normalizedEntry = normalizeEntryInput(entry);
    await fs.writeFile(
      existing.filePath,
      serializeEntry(normalizedEntry),
      "utf-8",
    );

    const updatedEntry: MemoryEntry = {
      ...normalizedEntry,
      id: existing.id,
      scope: this.scope,
      filePath: existing.filePath,
    };

    const entries = await this.listEntries();
    const merged = entries.map((item) =>
      item.id === existing.id ? updatedEntry : item,
    );
    await this.writeIndex(merged);
    return updatedEntry;
  }

  async removeEntry(id: string): Promise<boolean> {
    const existing = await this.getEntryById(id);
    if (!existing) return false;

    try {
      await fs.unlink(existing.filePath);
    } catch {
      return false;
    }

    const entries = await this.listEntries();
    const remaining = entries.filter((entry) => entry.id !== id);
    await this.writeIndex(remaining);
    return true;
  }

  private async readLegacyContents(): Promise<string[]> {
    const legacyPaths =
      this.scope === "global"
        ? resolveLegacyGlobalMemoryPaths()
        : resolveLegacyProjectMemoryPaths(this.projectPath);

    const contents: string[] = [];
    for (const legacyPath of legacyPaths) {
      try {
        const legacyContent = await fs.readFile(legacyPath, "utf-8");
        contents.push(legacyContent);
        await fs.unlink(legacyPath);
      } catch {}
    }
    return contents;
  }

  private async readIndexFile(): Promise<string | null> {
    try {
      return await fs.readFile(this.indexPath, "utf-8");
    } catch {
      return null;
    }
  }

  private async backupLegacyContent(contents: string[]): Promise<void> {
    if (contents.length === 0) return;
    const legacyPath = await resolveLegacyBackupPath(this.rootPath);
    if (!legacyPath) return;
    const merged = contents.filter(Boolean).join("\n\n");
    try {
      await fs.writeFile(legacyPath, merged, "utf-8");
    } catch (err) {
      error("Failed to write legacy memory backup", err);
    }
  }

  private async migrateLegacyContents(
    contents: string[],
  ): Promise<LegacyMigrationResult> {
    const existingEntries = await this.listEntries();
    const normalizedExisting = new Set(
      existingEntries.map((entry) => normalizeText(entry.content)),
    );

    let migratedCount = 0;
    let skippedCount = 0;

    for (const content of contents) {
      const bullets = parseLegacyBullets(content);
      for (const bullet of bullets) {
        const text = bullet.text.trim();
        if (!text) continue;
        const normalizedText = normalizeText(text);
        if (normalizedExisting.has(normalizedText)) {
          skippedCount += 1;
          continue;
        }

        const entryType = mapCategoryToType(bullet.category);
        const entryInput: MemoryEntryInput = {
          name: deriveName(text),
          description: deriveDescription(text),
          type: entryType,
          content: text,
        };

        const slugBase = slugify(entryInput.name);
        const slug = ensureUniqueSlug(
          slugBase,
          new Set(existingEntries.map((entry) => entry.id)),
        );
        const filePath = path.join(this.entriesPath, `${slug}.md`);
        await fs.writeFile(filePath, serializeEntry(entryInput), "utf-8");

        const entry: MemoryEntry = {
          ...entryInput,
          id: slug,
          scope: this.scope,
          filePath,
        };
        existingEntries.push(entry);
        normalizedExisting.add(normalizedText);
        migratedCount += 1;
      }
    }

    await this.writeIndex(existingEntries);
    return { migratedCount, skippedCount };
  }

  private async writeIndex(entries: MemoryEntry[]): Promise<void> {
    const byType = new Map<MemoryEntryType, MemoryEntry[]>();
    for (const type of TYPE_ORDER) {
      byType.set(type, []);
    }
    for (const entry of entries) {
      const list = byType.get(entry.type) ?? [];
      list.push(entry);
      byType.set(entry.type, list);
    }

    const lines: string[] = [INDEX_HEADER];
    for (const type of TYPE_ORDER) {
      const list = (byType.get(type) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (list.length === 0) continue;
      lines.push("", `## ${type}`);
      for (const entry of list) {
        lines.push(
          `- [${entry.name}](entries/${entry.id}.md) — ${entry.description}`,
        );
      }
    }

    const content = `${lines.join("\n").trimEnd()}\n`;
    await fs.writeFile(this.indexPath, content, "utf-8");
  }
}

function resolveGlobalRootPath(): string {
  return path.join(homedir(), ".pi", "pi-memory");
}

function resolveProjectRootPath(projectPath: string): string {
  return path.join(projectPath, ".pi", "pi-memory");
}

function resolveLegacyGlobalMemoryPaths(): string[] {
  const legacyPaths: string[] = [];
  switch (process.platform) {
    case "win32":
      legacyPaths.push(
        path.join(
          process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
          ".pi-memory",
          INDEX_FILE_NAME,
        ),
      );
      break;
    case "linux":
      legacyPaths.push(
        path.join(
          process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
          ".pi-memory",
          INDEX_FILE_NAME,
        ),
      );
      break;
    default:
      legacyPaths.push(
        path.join(homedir(), ".config", ".pi-memory", INDEX_FILE_NAME),
      );
      break;
  }
  return legacyPaths;
}

function resolveLegacyProjectMemoryPaths(projectPath: string): string[] {
  return [path.join(projectPath, ".pi-memory", INDEX_FILE_NAME)];
}

function parseEntryFile(content: string): ParsedEntry | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex(
    (line, idx) => idx > 0 && line.trim() === "---",
  );
  if (endIndex === -1) return null;

  const metadata: Partial<MemoryEntryInput> = {};
  for (const line of lines.slice(1, endIndex)) {
    const match = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) continue;
    if (key === "name") {
      metadata.name = value;
    } else if (key === "description") {
      metadata.description = value;
    } else if (key === "type") {
      metadata.type = value as MemoryEntryType;
    }
  }

  const contentLines = lines.slice(endIndex + 1);
  return { metadata, content: contentLines.join("\n").trim() };
}

function buildEntryFromParsed(
  id: string,
  scope: MemoryScope,
  filePath: string,
  parsed: ParsedEntry,
): MemoryEntry | null {
  const name = parsed.metadata.name?.trim();
  const description = parsed.metadata.description?.trim();
  const type = parsed.metadata.type?.trim() as MemoryEntryType | undefined;
  if (!name || !description || !type) return null;

  return {
    id,
    scope,
    filePath,
    name,
    description,
    type: normalizeEntryType(type),
    content: parsed.content ?? "",
  };
}

function serializeEntry(entry: MemoryEntryInput): string {
  const lines = [
    "---",
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    "---",
    "",
    entry.content.trim(),
    "",
  ];
  return lines.join("\n");
}

function normalizeEntryInput(entry: MemoryEntryInput): MemoryEntryInput {
  return {
    name: entry.name.trim(),
    description: entry.description.trim(),
    type: normalizeEntryType(entry.type),
    content: entry.content.trim(),
  };
}

function normalizeEntryType(type: string): MemoryEntryType {
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

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, 60).replace(/-+$/g, "");
  return trimmed || "memory";
}

function ensureUniqueSlug(base: string, existing: Set<string>): string {
  let slug = base;
  let counter = 2;
  while (existing.has(slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function parseLegacyBullets(content: string): LegacyBullet[] {
  const lines = content.split(/\r?\n/);
  let currentCategory = "General";
  const bullets: LegacyBullet[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      currentCategory = trimmed.slice(3).trim() || "General";
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const text = trimmed.slice(2).trim();
      if (text) bullets.push({ category: currentCategory, text });
    }
  }

  return bullets;
}

function mapCategoryToType(category: string): MemoryEntryType {
  const normalized = category.trim().toLowerCase();
  for (const [key, value] of Object.entries(CATEGORY_TYPE_MAP)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return "project";
}

function deriveName(text: string): string {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).slice(0, 8).join(" ");
  return words.length > 0 ? words : "Memory";
}

function deriveDescription(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

function isIndexFormat(content: string): boolean {
  const hasHeader = content.includes(INDEX_HEADER);
  const hasLinks = /-\s+\[[^\]]+\]\(entries\/[^)]+\)/.test(content);
  return hasHeader || hasLinks;
}

async function resolveLegacyBackupPath(
  rootPath: string,
): Promise<string | null> {
  const basePath = path.join(rootPath, `${LEGACY_BACKUP_BASENAME}.md`);
  try {
    await fs.access(basePath);
  } catch {
    return basePath;
  }

  for (let i = 2; i < 50; i += 1) {
    const candidate = path.join(rootPath, `${LEGACY_BACKUP_BASENAME}-${i}.md`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return null;
}

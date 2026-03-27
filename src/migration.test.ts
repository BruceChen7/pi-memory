import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryManager, setTestHomedir } from "./memory-manager";

async function listEntryFiles(entriesPath: string): Promise<string[]> {
  try {
    const files = await fs.readdir(entriesPath);
    return files.filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

describe("Global Memory Migration", () => {
  let testDir: string;
  let legacyGlobalPath: string;
  let newGlobalIndex: string;
  let newGlobalEntries: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    legacyGlobalPath = path.join(testDir, ".config", ".pi-memory", "MEMORY.md");
    newGlobalIndex = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");
    newGlobalEntries = path.join(testDir, ".pi", "pi-memory", "entries");

    setTestHomedir(() => testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    setTestHomedir(null);
  });

  it("should migrate legacy global memory into entries and index", async () => {
    const legacyContent = `# Memory
## User Preferences
- Prefers TypeScript
- Uses 2 spaces for indentation
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    const context = await manager.getMemoryContext(
      testDir,
      "prefers typescript",
    );

    const indexContent = await fs.readFile(newGlobalIndex, "utf-8");
    expect(indexContent).toContain("# Memory Index");
    expect(indexContent).toContain("Prefers TypeScript");

    const entryFiles = await listEntryFiles(newGlobalEntries);
    expect(entryFiles).toEqual(
      expect.arrayContaining([
        "prefers-typescript.md",
        "uses-2-spaces-for-indentation.md",
      ]),
    );

    const entryContent = await fs.readFile(
      path.join(newGlobalEntries, "prefers-typescript.md"),
      "utf-8",
    );
    expect(entryContent).toContain("type: user");
    expect(entryContent).toContain("Prefers TypeScript");

    await expect(fs.access(legacyGlobalPath)).rejects.toThrow();
    expect(context).toContain("Global Memory");
  });

  it("should deduplicate legacy entries when entries already exist", async () => {
    const legacyContent = `# Memory
## User Preferences
- Prefers TypeScript
- Uses 2 spaces for indentation
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    await manager.createEntry("global", testDir, {
      name: "Prefers TypeScript",
      description: "Prefers TypeScript",
      type: "user",
      content: "Prefers TypeScript",
    });

    await manager.getMemoryContext(testDir, "typescript");

    const entryFiles = await listEntryFiles(newGlobalEntries);
    const prefersMatches = entryFiles.filter((file) =>
      file.startsWith("prefers-typescript"),
    );
    expect(prefersMatches).toHaveLength(1);
    expect(entryFiles).toContain("uses-2-spaces-for-indentation.md");
  });

  it("should create empty index when no legacy file exists", async () => {
    const manager = new MemoryManager();
    await manager.getMemoryContext(testDir, "memory");

    const indexContent = await fs.readFile(newGlobalIndex, "utf-8");
    expect(indexContent).toContain("# Memory Index");
    const entryFiles = await listEntryFiles(newGlobalEntries);
    expect(entryFiles).toHaveLength(0);
  });

  it("should map category headings to entry types", async () => {
    const legacyContent = `# Memory
## User Preferences
- Prefers ESLint
## Decisions
- Chose Biome over ESLint
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    await manager.getMemoryContext(testDir, "eslint");

    const indexContent = await fs.readFile(newGlobalIndex, "utf-8");
    expect(indexContent).toContain("## user");
    expect(indexContent).toContain("## project");
  });

  it("should handle empty legacy file", async () => {
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, "", "utf-8");

    const manager = new MemoryManager();
    await manager.getMemoryContext(testDir, "memory");

    const entryFiles = await listEntryFiles(newGlobalEntries);
    expect(entryFiles).toHaveLength(0);
  });

  it("should handle legacy file with only headers", async () => {
    const legacyContent = `# Memory
## User Preferences
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    await manager.getMemoryContext(testDir, "memory");

    const entryFiles = await listEntryFiles(newGlobalEntries);
    expect(entryFiles).toHaveLength(0);
  });
});

describe("Project Memory Migration", () => {
  let testDir: string;
  let legacyProjectPath: string;
  let newProjectIndex: string;
  let newProjectEntries: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    setTestHomedir(() => testDir);

    legacyProjectPath = path.join(testDir, ".pi-memory", "MEMORY.md");
    newProjectIndex = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");
    newProjectEntries = path.join(testDir, ".pi", "pi-memory", "entries");
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    setTestHomedir(null);
  });

  it("should migrate legacy project memory to new location", async () => {
    const legacyContent = `# Memory
## Decisions
- Using React for UI
`;
    await fs.mkdir(path.dirname(legacyProjectPath), { recursive: true });
    await fs.writeFile(legacyProjectPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    await manager.getMemoryContext(testDir, "react");

    const indexContent = await fs.readFile(newProjectIndex, "utf-8");
    expect(indexContent).toContain("Using React for UI");

    const entryFiles = await listEntryFiles(newProjectEntries);
    expect(entryFiles).toContain("using-react-for-ui.md");

    await expect(fs.access(legacyProjectPath)).rejects.toThrow();
  });
});

describe("MemoryManager Public API", () => {
  let testDir: string;
  let legacyGlobalPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    legacyGlobalPath = path.join(testDir, ".config", ".pi-memory", "MEMORY.md");
    setTestHomedir(() => testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    setTestHomedir(null);
  });

  it("should return global index after migration via getMemoryIndexFiles", async () => {
    const legacyContent = `# Memory
## User Preferences
- Uses Bun package manager
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();
    const files = await manager.getMemoryIndexFiles(testDir);

    expect(files.global).toContain("Uses Bun package manager");
  });

  it("should create and remove entries via MemoryManager", async () => {
    const manager = new MemoryManager();
    const created = await manager.createEntry("global", testDir, {
      name: "Prefers dark theme",
      description: "Prefers dark theme",
      type: "user",
      content: "Prefers dark theme",
    });

    const found = await manager.getEntryById("global", testDir, created.id);
    expect(found?.name).toBe("Prefers dark theme");

    const removed = await manager.removeEntry("global", testDir, created.id);
    expect(removed).toBe(true);
  });
});

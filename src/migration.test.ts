import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryManager, setTestHomedir } from "./memory-manager";

describe("Global Memory Migration", () => {
  let testDir: string;
  let legacyGlobalPath: string;
  let newGlobalPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    legacyGlobalPath = path.join(testDir, ".config", ".pi-memory", "MEMORY.md");
    newGlobalPath = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");

    // Set test homedir
    setTestHomedir(() => testDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Reset test homedir
    setTestHomedir(null);
  });

  it("should migrate legacy global memory when new file does not exist", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Prefers TypeScript
- Uses 2 spaces for indentation
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    const context = await manager.getMemoryContext(testDir);

    // Assert
    const newContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(newContent).toContain("Prefers TypeScript");
    expect(newContent).toContain("Uses 2 spaces for indentation");

    // Legacy file should be deleted
    await expect(fs.access(legacyGlobalPath)).rejects.toThrow();

    // Context should include global memory
    expect(context).toContain("Global Memory");
  });

  it("should merge legacy global memory with new file without duplicates", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Prefers TypeScript
- Uses 2 spaces for indentation
`;

    const newContent = `# Memory
## User Preferences
- Prefers TypeScript
## Technical Context
- Using Node.js
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.mkdir(path.dirname(newGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");
    await fs.writeFile(newGlobalPath, newContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert
    const mergedContent = await fs.readFile(newGlobalPath, "utf-8");

    // Should have all entries
    expect(mergedContent).toContain("Prefers TypeScript");
    expect(mergedContent).toContain("Uses 2 spaces for indentation");
    expect(mergedContent).toContain("Using Node.js");

    // Should not have duplicate "Prefers TypeScript"
    const matches = mergedContent.match(/Prefers TypeScript/g);
    expect(matches).toHaveLength(1);

    // Legacy file should be deleted
    await expect(fs.access(legacyGlobalPath)).rejects.toThrow();
  });

  it("should not create new file if legacy file does not exist", async () => {
    // Arrange: No legacy file
    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert
    await expect(fs.access(newGlobalPath)).rejects.toThrow();
  });

  it("should preserve category headers when merging", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Prefers ESLint
## Decisions
- Chose Biome over ESLint
`;

    const newContent = `# Memory
## Technical Context
- Using Vitest for testing
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.mkdir(path.dirname(newGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");
    await fs.writeFile(newGlobalPath, newContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert
    const mergedContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(mergedContent).toContain("## User Preferences");
    expect(mergedContent).toContain("## Decisions");
    expect(mergedContent).toContain("## Technical Context");
  });

  it("should handle empty legacy file", async () => {
    // Arrange
    const legacyContent = "";
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert: New file should be created (even if legacy is empty, we migrate it)
    const newContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(newContent).toBe("");
  });

  it("should handle legacy file with only headers", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert
    const newContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(newContent).toContain("## User Preferences");
  });
});

describe("Project Memory Migration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
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

  it("should migrate legacy project memory to new location", async () => {
    // Arrange
    const legacyProjectPath = path.join(testDir, ".pi-memory", "MEMORY.md");
    const newProjectPath = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");

    const legacyContent = `# Memory
## Decisions
- Using React for UI
`;
    await fs.mkdir(path.dirname(legacyProjectPath), { recursive: true });
    await fs.writeFile(legacyProjectPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.getMemoryContext(testDir);

    // Assert
    const newContent = await fs.readFile(newProjectPath, "utf-8");
    expect(newContent).toContain("Using React for UI");

    // Legacy file should be deleted
    await expect(fs.access(legacyProjectPath)).rejects.toThrow();
  });
});

describe("MemoryManager Public API", () => {
  let testDir: string;
  let legacyGlobalPath: string;
  let newGlobalPath: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    legacyGlobalPath = path.join(testDir, ".config", ".pi-memory", "MEMORY.md");
    newGlobalPath = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");
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

  it("should return global memory after migration via getMemoryFiles", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Uses Bun package manager
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    const files = await manager.getMemoryFiles(testDir);

    // Assert
    expect(files.global).toContain("Uses Bun package manager");
  });

  it("should append to global memory after migration", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Uses VSCode
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    await manager.appendMemory(
      "Prefers dark theme",
      "global",
      testDir,
      "User Preferences",
    );

    // Assert
    const newContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(newContent).toContain("Uses VSCode");
    expect(newContent).toContain("Prefers dark theme");
  });

  it("should remove from global memory after migration", async () => {
    // Arrange
    const legacyContent = `# Memory
## User Preferences
- Uses VSCode
- Prefers dark theme
`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    const manager = new MemoryManager();

    // Act
    const removed = await manager.removeMemory("Prefers dark theme", testDir);

    // Assert
    expect(removed).toBe(true);
    const newContent = await fs.readFile(newGlobalPath, "utf-8");
    expect(newContent).toContain("Uses VSCode");
    expect(newContent).not.toContain("Prefers dark theme");
  });
});

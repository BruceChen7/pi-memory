import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExtractionPrompt } from "./extraction-runner";
import { MemoryManager, setTestHomedir } from "./memory-manager";

vi.mock("./extraction-runner", () => ({
  runExtractionPrompt: vi.fn(),
}));

describe("MemoryManager English index translation fallback", () => {
  let testDir: string;
  let legacyGlobalPath: string;
  let newGlobalIndex: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `pi-memory-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    legacyGlobalPath = path.join(testDir, ".config", ".pi-memory", "MEMORY.md");
    newGlobalIndex = path.join(testDir, ".pi", "pi-memory", "MEMORY.md");

    setTestHomedir(() => testDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    setTestHomedir(null);
  });

  it("uses runtime modelRegistry fallback to translate CJK index when config is missing", async () => {
    const legacyContent = `# Memory\n## User Preferences\n- 偏好中文输出\n`;
    await fs.mkdir(path.dirname(legacyGlobalPath), { recursive: true });
    await fs.writeFile(legacyGlobalPath, legacyContent, "utf-8");

    vi.mocked(runExtractionPrompt).mockResolvedValue({
      success: true,
      content:
        '{"name":"Prefers Chinese output","description":"Prefers Chinese output"}',
    });

    const manager = new MemoryManager();
    manager.setRuntimeModelContext({
      modelRegistry: {
        getAvailable: () => [
          {
            id: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
        getApiKeyAndHeaders: async () => ({
          ok: true,
          headers: { Authorization: "Bearer token" },
        }),
      },
    });

    await manager.getMemoryContext(testDir, "中文输出");

    const indexContent = await fs.readFile(newGlobalIndex, "utf-8");
    expect(runExtractionPrompt).toHaveBeenCalled();
    expect(indexContent).toContain("Prefers Chinese output");
    expect(indexContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});

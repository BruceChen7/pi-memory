import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { error } from "./logger";

function resolvePilotAppDir(): string {
	switch (process.platform) {
		case "win32":
			return path.join(
				process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
				".pilot",
			);
		case "linux":
			return path.join(
				process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
				".pilot",
			);
		default:
			return path.join(homedir(), ".config", ".pilot");
	}
}

const GLOBAL_MEMORY_PATH = path.join(resolvePilotAppDir(), "MEMORY.md");

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
		const global = await this.loadFile(GLOBAL_MEMORY_PATH);
		const projectShared = await this.loadFile(
			path.join(projectPath, ".pilot", "MEMORY.md"),
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

		// Account for wrapper overhead (~140 bytes)
		const WRAPPER_OVERHEAD = 200;
		const effectiveLimit = MAX_MEMORY_INJECT_SIZE - WRAPPER_OVERHEAD;

		if (Buffer.byteLength(content, "utf-8") > effectiveLimit) {
			const lines = content.split("\n");
			const lineSizes = lines.map((l) => Buffer.byteLength(l, "utf-8"));
			let totalSize = lineSizes.reduce((a, b) => a + b, 0) + lines.length - 1;

			const bulletIndices: number[] = [];
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].startsWith("- ")) bulletIndices.push(i);
			}

			const toRemove = new Set<number>();
			for (const idx of bulletIndices) {
				// Stop if we've reached minimum or are under limit (after removing this item)
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
		return {
			global: await this.loadFile(GLOBAL_MEMORY_PATH),
			projectShared: await this.loadFile(
				path.join(projectPath, ".pilot", "MEMORY.md"),
			),
		};
	}

	buildExtractionPrompt(
		userMessage: string,
		agentResponse: string,
		existingMemories: string,
	): string {
		return `You are a memory extraction system. Your job is to identify information worth remembering from a conversation between a user and a coding agent.

<existing_memories>
${existingMemories}
</existing_memories>

<latest_exchange>
User: ${userMessage}

Agent: ${agentResponse}
</latest_exchange>

Analyze the latest exchange and determine if there is anything NEW worth remembering that is NOT already in existing memories. Focus on:

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

			const parsed = JSON.parse(resultJson);
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
		const files = [
			GLOBAL_MEMORY_PATH,
			path.join(projectPath, ".pilot", "MEMORY.md"),
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
			} catch {}
		}
		return false;
	}

	private resolveFilePath(
		scope: "global" | "project",
		projectPath: string,
	): string {
		switch (scope) {
			case "global":
				return GLOBAL_MEMORY_PATH;
			case "project":
				return path.join(projectPath, ".pilot", "MEMORY.md");
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

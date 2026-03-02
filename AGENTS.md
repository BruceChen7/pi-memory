# AGENTS.md — AI Agent Guidelines for pi-memory

## Project Overview

**pi-memory** is a [Pi Agent](https://github.com/badlogic/pi-mono) extension that provides persistent memory across sessions. It remembers user preferences, project decisions, and conventions.

- **Type**: Pi Agent Extension (plugin package)
- **Language**: TypeScript
- **Package Manager**: npm

## Technology Stack

- **Runtime**: Node.js (TypeScript)
- **Linting/Formatting**: Biome
- **Git Hooks**: Husky + lint-staged
- **Peer Dependencies**: `@mariozechner/pi-coding-agent`, `@sinclair/typebox`

## Development Commands

```bash
# Lint code
npm run lint

# Fix lint issues
npm run lint:fix

# Format code
npm run format
```

## Code Style

This project uses **Biome** for linting and formatting. All code should pass biome checks before committing.

### Key Conventions

1. **Imports**: Use Node.js path resolution (e.g., `node:fs/promises`)
2. **Error Handling**: Use typed errors with `instanceof` checks
3. **Async/Await**: Always use for async operations
4. **Types**: Define interfaces for data structures; avoid `any`
5. **Constants**: Use UPPER_SNAKE_CASE for true constants, camelCase for config objects
6. **Strings**: Use template literals for string interpolation

### Example Patterns

```typescript
// Error handling pattern
try {
  const content = await fs.readFile(filePath, "utf-8");
} catch (err: unknown) {
  if (err instanceof Error && "code" in err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") {
      error("Operation failed", err);
    }
  }
}

// Type-safe configuration
interface MemoryConfig {
  baseUrl?: string;
  apiType?: string;
  modelId?: string;
  apiKey?: string;
  timeout?: number;
  provider?: string;
}
```

## Architecture

### Core Components

| File | Purpose |
|------|---------|
| `src/memory-manager.ts` | Core memory management — load, save, extract, truncate |
| `src/extraction.ts` | Memory extraction logic using AI |
| `src/config.ts` | Configuration loading from settings.json |
| `src/cheap-model.ts` | Cheap LLM wrapper for memory extraction |
| `extensions/index.ts` | Pi extension entry point |

### Memory Storage

- **Global Memory**: `~/.config/.pi-memory/MEMORY.md` (cross-project)
- **Project Memory**: `<project>/.pi-memory/MEMORY.md` (project-specific)
- **Legacy Migration**: Automatically migrates from `.pilot` to `.pi-memory`

### Key Classes

- **`MemoryManager`**: Main class for all memory operations
  - `getMemoryContext()`: Get formatted memory for prompt injection
  - `appendMemory()`: Add a new memory entry
  - `removeMemory()`: Remove a memory entry
  - `processExtractionResult()`: Handle AI extraction results
  - `shouldSkipExtraction()`: Debounce check (30s)

## Configuration

The extension reads configuration from Pi's `settings.json` under the `piMemory` key:

```json
{
  "piMemory": {
    "baseUrl": "https://api.openai.com/v1",
    "apiType": "openai-responses",
    "modelId": "gpt-4o-mini",
    "apiKey": "$OPENAI_API_KEY",
    "timeout": 15000,
    "provider": "nahcrof"
  }
}
```

## Testing Changes

Since this is a Pi Agent extension:

1. Make changes to the source
2. Run `npm run lint:fix` and `npm run format`
3. Build/package if needed (Pi loads extensions dynamically)
4. Test in Pi Agent by:
   - Adding to `~/.pi/agent/settings.json` packages
   - Running `/reload` in Pi
   - Having a conversation to trigger memory extraction

## Common Tasks

### Adding a New Memory Category

Edit `src/memory-manager.ts` — the `appendMemory` method handles categories automatically. Valid categories:
- User Preferences
- Technical Context
- Decisions
- Project Notes
- General

### Modifying Extraction Prompt

Edit `buildExtractionPrompt()` in `src/memory-manager.ts`. The prompt is sent to a cheap LLM to extract memory-worthy information from conversations.

### Changing Debounce Period

Modify `EXTRACTION_DEBOUNCE_MS` constant (default: 30,000ms = 30s).

## Notes for AI Agents

- Do NOT modify `.gitignore` to commit node_modules
- Always run biome before committing
- Follow existing error handling patterns
- Keep memory text concise (max 500 chars per entry)
- When adding dependencies, ensure they're compatible with Pi's environment
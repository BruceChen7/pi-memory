# pi-memory

Persistent memory for [Pi Agent](https://github.com/badlogic/pi-mono) — remembers user preferences, project decisions, and conventions across sessions.

## Links

- **Pi Website**: [https://pi.dev/](https://pi.dev/)
- **Pi Agent**: [https://github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)

## Features

- **Global Memory**: Shared across all projects, stored in `~/.pi/pi-memory/MEMORY.md`
- **Project Memory**: Specific to each project, stored in `<project>/.pi/pi-memory/MEMORY.md`
- **Automatic Extraction**: Uses AI to identify valuable information worth remembering
- **Smart Truncation**: Automatically trims memory when it exceeds token limits
- **Debounced Extraction**: Prevents excessive memory operations (30s debounce)
- **Memory Management**: Add, remove, and query memories programmatically

## Installation

Install via a git repository in your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/BruceChen7/pi-memory@main"
  ]
}
```

You can pin a tag or commit by replacing `@main` (for example, `@v0.1.0` or a commit SHA). HTTPS URLs are also supported, e.g. `https://github.com/BruceChen7/pi-memory@main`.

Then restart Pi or run `/reload` to load the extension.

## Usage

The extension is automatically loaded by Pi. Memories are extracted and saved automatically during conversations.

### Memory Scopes

- **global**: Information that applies across all projects (e.g., user preferences, coding style)
- **project**: Information specific to the current project (e.g., architecture decisions, team practices)

### Memory Categories

- User Preferences
- Technical Context
- Decisions
- Project Notes
- General

## API

```typescript
import { MemoryManager } from './src/memory-manager';

const manager = new MemoryManager();

// Get memory context for injection into prompts
const context = await manager.getMemoryContext('/path/to/project');

// Check if extraction should be skipped (debounce)
if (!manager.shouldSkipExtraction()) {
  // Process extraction...
  manager.markExtractionRun();
}

// Append a new memory
await manager.appendMemory(
  'Use TypeScript strict mode for all new projects',
  'global',
  '/path/to/project',
  'Technical Context'
);

// Remove a memory
await manager.removeMemory('some memory text', '/path/to/project');
```

## Configuration

This plugin supports flexible configuration through `settings.json`. Add your configuration under the `piMemory` key.

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | string | Custom base URL for the LLM API (e.g., `"https://api.openai.com/v1"`) |
| `apiType` | string | API type: `"openai-completions"`, `"openai-responses"`, `"anthropic-messages"`, or `"google-generativelanguage"` |
| `modelId` | string | Model ID for memory extraction (e.g., `"gpt-4o-mini"`, `"claude-3-haiku-20240307"`) |
| `apiKey` | string | API key - can be a literal key or environment variable name (e.g., `"$OPENAI_API_KEY"`) |
| `timeout` | number | Timeout for extraction API calls in ms (default: `10000`) |
| `provider` | string | Provider name from `models.json` (e.g., `"nahcrof"`, `"anyrouter"`) |

### Method 1: Direct Configuration

Configure directly in your `~/.pi/agent/settings.json` or project `.pi/settings.json`:

```json
{
  "piMemory": {
    "baseUrl": "https://api.openai.com/v1",
    "apiType": "openai-responses",
    "modelId": "gpt-4o-mini",
    "apiKey": "$OPENAI_API_KEY",
    "timeout": 15000
  }
}
```

### Method 2: Reference models.json

If you have models configured in `~/.pi/agent/models.json`, you can reference a provider:

```json
{
  "piMemory": {
    "provider": "nahcrof",
    "modelId": "gpt-4o-mini",
    "timeout": 15000
  }
}
```

This will automatically load `baseUrl`, `api`, and `apiKey` from your `models.json` provider configuration.

### Default Settings

- **Extraction Debounce**: 30 seconds
- **Max Memory Inject Size**: 50KB
- **Max Memories Per Extraction**: 10
- **Max Memory Text Length**: 500 characters

## File Structure

```
pi-memory/
├── src/
│   ├── memory-manager.ts    # Core memory management
│   ├── extraction.ts        # Memory extraction logic
│   ├── config.ts            # Configuration
│   └── cheap-model.ts       # Cheap model for extraction
├── extensions/
│   └── index.ts             # Pi extension entry point
├── package.json
└── README.md
```

## License

MIT
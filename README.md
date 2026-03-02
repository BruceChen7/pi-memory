# pi-memory

Persistent memory for Pi Agent — remembers user preferences, project decisions, and conventions across sessions.

## Features

- **Global Memory**: Shared across all projects, stored in `~/.config/.pi-memory/MEMORY.md`
- **Project Memory**: Specific to each project, stored in `<project>/.pi-memory/MEMORY.md`
- **Automatic Extraction**: Uses AI to identify valuable information worth remembering
- **Smart Truncation**: Automatically trims memory when it exceeds token limits
- **Debounced Extraction**: Prevents excessive memory operations (30s debounce)
- **Memory Management**: Add, remove, and query memories programmatically

## Installation

Add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/BruceChen7/pi-memory@main"
  ]
}
```

Then restart pi or run `/reload` to load the extension.

## Usage

The extension is automatically loaded by pi. Memories are extracted and saved automatically during conversations.

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

Default settings (can be customized in code):

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
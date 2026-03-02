# Plan: Add Status Bar Animation for Memory Extraction

## Context

Currently, the plugin extracts memories in the background after each agent response via `extractMemoriesInBackground()`. Users have no visual feedback that memory extraction is happening. We want to show a status indicator in the pi-agent status bar during extraction.

## Approach

Use the `ExtensionUIContext.setStatus()` API to display a loading indicator in the status bar while memory extraction is running. The status will show "Extracting memories..." during extraction and be cleared when done.

## Files to modify

1. `src/extraction.ts` - Add `ui` parameter to `MemoryExtractionContext` and implement status bar updates
2. `extensions/index.ts` - Pass `ui` context when calling `extractMemoriesInBackground`

## Reuse

- `ExtensionUIContext.setStatus(key: string, text: string | undefined)` - From `@mariozechner/pi-coding-agent` (see `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` line 67)

## Steps

- [ ] 1. Modify `src/extraction.ts`:
  - Add `ui: ExtensionUIContext` to `MemoryExtractionContext` interface
  - At start of `extractMemoriesInBackground`: call `ctx.ui.setStatus("memory-extract", "💾 Extracting memories...")`
  - In finally block or after completion: call `ctx.ui.setStatus("memory-extract", undefined)` to clear

- [ ] 2. Modify `extensions/index.ts`:
  - Pass `ctx.ui` to `extractMemoriesInBackground()` in the `agent_end` handler

- [ ] 3. Add status bar animation for manual memory extraction in `extensions/index.ts`:
  - In `runMemoryExtract()` function:
    - At start: call `ctx.ui.setStatus("memory-extract", "💾 Extracting memories...")`
    - In finally block: call `ctx.ui.setStatus("memory-extract", undefined)` to clear

## Verification

1. Run pi with the plugin loaded
2. Have a conversation that should trigger auto memory extraction
3. Observe the status bar showing "💾 Extracting memories..." briefly after each agent response
4. Use `/memory_extract` command to manually extract memories
5. Observe the status bar animation during manual extraction as well
6. Verify the status clears after each extraction completes
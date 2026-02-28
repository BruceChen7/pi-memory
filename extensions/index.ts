import { Type } from '@sinclair/typebox';
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, AgentEndEvent, BeforeAgentStartEventResult } from '@mariozechner/pi-coding-agent';
import { MemoryManager } from '../src/memory-manager';
import { extractMemoriesInBackground } from '../src/extraction';
import { callCheapModel } from '../src/cheap-model';
import { loadConfig } from '../src/config';

const memoryManager = new MemoryManager();

let lastUserPrompt = '';

export default function (pi: ExtensionAPI) {

  // ─── System prompt injection ────────────────────────────────────────
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    lastUserPrompt = event.prompt;

    const memoryContext = await memoryManager.getMemoryContext(ctx.cwd);
    if (!memoryContext) return;

    return {
      systemPrompt: event.systemPrompt + '\n\n' + memoryContext,
    };
  });

  // ─── Auto-extraction after agent response ───────────────────────────
  pi.on('agent_end', async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const messages = event.messages;
    if (messages.length === 0) return;

    const lastMessage = messages[messages.length - 1];
    let agentResponseText = '';
    if ('content' in lastMessage && Array.isArray(lastMessage.content)) {
      for (const block of lastMessage.content) {
        if (typeof block === 'string') {
          agentResponseText += block;
        } else if (block && typeof block === 'object' && 'text' in block) {
          agentResponseText += (block as { text: string }).text;
        }
      }
    }

    if (!agentResponseText || !lastUserPrompt) return;

    extractMemoriesInBackground({
      projectPath: ctx.cwd,
      userMessage: lastUserPrompt,
      agentResponseText,
      memoryManager,
      modelRegistry: ctx.modelRegistry,
      cwd: ctx.cwd,
    }).catch(() => {});
  });

  // ─── memory_read ────────────────────────────────────────────────────
  pi.registerTool({
    name: 'memory_read',
    label: 'Memory',
    description:
      'Read stored memories. Returns global and project memory contents. Use to check what has already been remembered before adding new entries.',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [Type.Literal('all'), Type.Literal('global'), Type.Literal('project')],
          { description: 'Which memories to read. Default: all' }
        )
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? 'all';
      const files = await memoryManager.getMemoryFiles(ctx.cwd);
      const sections: string[] = [];

      if ((scope === 'all' || scope === 'global') && files.global) {
        sections.push(`## Global Memory\n${files.global}`);
      }
      if ((scope === 'all' || scope === 'project') && files.projectShared) {
        sections.push(`## Project Memory\n${files.projectShared}`);
      }

      const text = sections.length > 0 ? sections.join('\n\n') : 'No memories stored.';
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  // ─── memory_add ─────────────────────────────────────────────────────
  pi.registerTool({
    name: 'memory_add',
    label: 'Memory',
    description:
      'Save a memory entry. Use for user preferences, project decisions, conventions, and facts worth remembering across sessions. Avoid one-time task details.',
    parameters: Type.Object({
      text: Type.String({ description: 'The memory to save — one concise line' }),
      scope: Type.Optional(
        Type.Union(
          [Type.Literal('global'), Type.Literal('project')],
          { description: 'global = all projects, project = this project only. Default: project' }
        )
      ),
      category: Type.Optional(
        Type.String({ description: 'Category heading, e.g. "User Preferences", "Technical Context", "Decisions". Default: General' })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? 'project';
      const category = params.category ?? 'General';
      await memoryManager.appendMemory(params.text, scope, ctx.cwd, category);
      const text = `Saved to ${scope} memory under "${category}": ${params.text}`;
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  // ─── memory_remove ──────────────────────────────────────────────────
  pi.registerTool({
    name: 'memory_remove',
    label: 'Memory',
    description:
      'Remove a memory entry by matching its text. Use when a memory is outdated, wrong, or the user asks to forget something.',
    parameters: Type.Object({
      text: Type.String({ description: 'Text to match against existing memories (case-insensitive partial match)' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const removed = await memoryManager.removeMemory(params.text, ctx.cwd);
      const text = removed
        ? `Removed memory matching: ${params.text}`
        : `No memory found matching: ${params.text}`;
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });

  // ─── memory_extract ─────────────────────────────────────────────────
  pi.registerTool({
    name: 'memory_extract',
    label: 'Memory',
    description:
      'Extract memories from the current session conversation using AI. Analyzes the session so far and saves useful information worth remembering.',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [Type.Literal('global'), Type.Literal('project')],
          { description: 'global = all projects, project = this project only. Default: project' }
        )
      ),
      category: Type.Optional(
        Type.String({ description: 'Category heading for extracted memories. Default: General' })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params.scope ?? 'project';
      const category = params.category ?? 'General';

      // Get session messages from the current session
      const entries = ctx.sessionManager.getEntries();
      const messageEntries = entries.filter((e) => e.type === 'message');

      if (messageEntries.length === 0) {
        return { content: [{ type: 'text', text: 'No messages in session to extract memories from.' }], details: undefined };
      }

      // Build conversation text from session messages
      const conversationParts: string[] = [];
      for (const entry of messageEntries) {
        if ('message' in entry && entry.message.role && entry.message.content) {
          const role = entry.message.role;
          const content = Array.isArray(entry.message.content)
            ? entry.message.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
            : entry.message.content;
          if (content) {
            conversationParts.push(`${role}: ${content}`);
          }
        }
      }

      const conversationText = conversationParts.join('\n\n');

      // Get existing memories for context
      const existingMemories = await memoryManager.getMemoryContext(ctx.cwd);

      // Build extraction prompt
      const extractionPrompt = `You are a memory extraction system. Your job is to identify information worth remembering from a conversation.

<existing_memories>
${existingMemories || 'No existing memories.'}
</existing_memories>

<conversation>
${conversationText}
</conversation>

Analyze the conversation and determine if there is anything NEW worth remembering that is NOT already in existing memories. Focus on:

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

      try {
        // Load config and call cheap model
        const config = await loadConfig(ctx.cwd);

        if (!config.apiType || !config.modelId || !config.apiKey) {
          return {
            content: [{ type: 'text', text: 'No cheap model configured. Please set piMemory config in settings.json.' }],
            details: undefined,
          };
        }

        const extractionResult = await callCheapModel(config, extractionPrompt, _signal);

        if (!extractionResult) {
          return { content: [{ type: 'text', text: 'Failed to extract memories from the model.' }], details: undefined };
        }

        // Process the result
        const result = await memoryManager.processExtractionResult(extractionResult, ctx.cwd);

        if (result.memories.length === 0) {
          return { content: [{ type: 'text', text: 'No new memories extracted from the session.' }], details: undefined };
        }

        // Save each extracted memory with the specified scope and category
        for (const mem of result.memories) {
          await memoryManager.appendMemory(mem.text, scope, ctx.cwd, category);
        }

        const memoriesList = result.memories.map((m) => `- ${m.text}`).join('\n');
        const text = `Extracted ${result.memories.length} memory(s) from session:\n${memoriesList}`;

        return { content: [{ type: 'text', text }], details: undefined };
      } catch (err) {
        console.debug('[pi-memory] memory_extract failed:', err);
        return { content: [{ type: 'text', text: `Error extracting memories: ${err instanceof Error ? err.message : 'Unknown error'}` }], details: undefined };
      }
    },
  });
}

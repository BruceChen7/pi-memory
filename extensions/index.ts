import { Type } from '@sinclair/typebox';
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent, AgentEndEvent, BeforeAgentStartEventResult } from '@mariozechner/pi-coding-agent';
import { MemoryManager } from '../src/memory-manager';
import { extractMemoriesInBackground } from '../src/extraction';

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
}

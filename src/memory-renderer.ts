import type { MemoryEntry, MemoryEntryType } from "./memory-types";

const TYPE_ORDER: MemoryEntryType[] = [
  "user",
  "project",
  "feedback",
  "reference",
];

export interface RenderSection {
  title: string;
  entries: MemoryEntry[];
}

export interface RenderOptions {
  maxBytes: number;
}

export function renderMemorySections(
  sections: RenderSection[],
  options: RenderOptions,
): string {
  const output: string[] = [];

  for (const section of sections) {
    const sectionStart = output.length;
    if (!tryAppend(output, [`## ${section.title}`], options.maxBytes)) {
      return finalizeLines(output);
    }

    let sectionHasEntries = false;

    for (const type of TYPE_ORDER) {
      const entries = section.entries.filter((entry) => entry.type === type);
      if (entries.length === 0) continue;

      const typeStart = output.length;
      if (!tryAppend(output, [`### ${type}`], options.maxBytes)) {
        output.splice(sectionStart);
        return finalizeLines(output);
      }

      let typeHasEntries = false;

      for (const entry of entries) {
        const entryLines = renderEntryLines(entry);
        if (!tryAppend(output, entryLines, options.maxBytes)) {
          output.splice(typeHasEntries ? output.length : typeStart);
          if (!sectionHasEntries) output.splice(sectionStart);
          return finalizeLines(output);
        }
        typeHasEntries = true;
        sectionHasEntries = true;
      }

      if (!typeHasEntries) {
        output.splice(typeStart);
      }
    }

    if (sectionHasEntries) {
      tryAppend(output, [""], options.maxBytes);
    } else {
      output.splice(sectionStart);
    }
  }

  return finalizeLines(output);
}

function renderEntryLines(entry: MemoryEntry): string[] {
  const header = `- ${entry.name} — ${entry.description}`;
  const body = entry.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `  ${line}`);
  return body.length > 0 ? [header, ...body] : [header];
}

function finalizeLines(lines: string[]): string {
  return lines.join("\n").trimEnd();
}

function tryAppend(
  target: string[],
  addition: string[],
  maxBytes: number,
): boolean {
  const candidate = [...target, ...addition];
  if (byteLength(candidate.join("\n")) > maxBytes) return false;
  target.push(...addition);
  return true;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

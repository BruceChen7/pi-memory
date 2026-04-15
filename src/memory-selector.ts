import type { MemoryEntry, MemoryEntryType } from "./memory-types";

export interface MemorySelection {
  entries: MemoryEntry[];
}

const TYPE_PRIORITY: Record<MemoryEntryType, number> = {
  user: 0,
  project: 1,
  feedback: 2,
  reference: 3,
};

const EN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

const ZH_STOPWORDS = new Set([
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "以及",
  "一个",
  "我们",
  "你",
  "我",
  "他",
  "她",
  "它",
  "这",
  "那",
  "这个",
  "那个",
  "还有",
  "目前",
  "现在",
]);

export function selectMemories(
  entries: MemoryEntry[],
  query: string,
): MemorySelection {
  const tokens = tokenize(query);
  const scored = entries.map((entry) => ({
    entry,
    score: computeScore(entry, tokens),
  }));

  const hasMatches = scored.some((item) => item.score > 0);
  const filtered = scored.filter((item) =>
    hasMatches ? item.score > 0 : item.entry.type === "user",
  );

  const sorted = filtered.sort((a, b) => {
    const typeDiff = TYPE_PRIORITY[a.entry.type] - TYPE_PRIORITY[b.entry.type];
    if (typeDiff !== 0) return typeDiff;
    if (b.score !== a.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  return { entries: sorted.map((item) => item.entry) };
}

function computeScore(entry: MemoryEntry, tokens: Set<string>): number {
  if (tokens.size === 0) return 0;
  const haystack = `${entry.name} ${entry.description} ${entry.content}`;
  const entryTokens = tokenize(haystack);
  let score = 0;
  for (const token of entryTokens) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.match(/[A-Za-z0-9]+|[\u4E00-\u9FFF]+/g) ?? [];
  for (const match of matches) {
    const lowered = match.toLowerCase();
    if (isStopword(lowered)) continue;
    tokens.add(lowered);
  }
  return tokens;
}

function isStopword(token: string): boolean {
  if (token.length <= 1) return true;
  if (EN_STOPWORDS.has(token)) return true;
  if (ZH_STOPWORDS.has(token)) return true;
  return false;
}

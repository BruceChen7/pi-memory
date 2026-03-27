export const MEMORY_POLICY_TEXT = [
  "Only extract durable, reusable information that helps future collaboration.",
  "Allowed: user preferences, stable technical decisions, long-term project facts, corrections.",
  "Disallowed: code structure/paths, short-term tasks, commit/PR history, temporary state.",
  "Even if the user explicitly asks to remember something, you must still follow this policy.",
].join("\n");

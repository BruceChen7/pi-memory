export type MemoryScope = "global" | "project";

export type MemoryEntryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntryInput {
  name: string;
  description: string;
  type: MemoryEntryType;
  content: string;
}

export interface MemoryEntry extends MemoryEntryInput {
  id: string;
  scope: MemoryScope;
  filePath: string;
}

export type MemoryAction =
  | {
      action: "create";
      scope: MemoryScope;
      entry: MemoryEntryInput;
    }
  | {
      action: "update";
      id?: string;
      name?: string;
      scope?: MemoryScope;
      entry: MemoryEntryInput;
    }
  | {
      action: "remove";
      id?: string;
      name?: string;
      scope?: MemoryScope;
      reason?: string;
    };

export interface MemoryActionOutcome {
  action: MemoryAction;
  status: "applied" | "skipped";
  message?: string;
}

export interface MemoryActionReport {
  outcomes: MemoryActionOutcome[];
}

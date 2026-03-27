import os from "node:os";

let customHomedir: (() => string) | null = null;

export function homedir(): string {
  return customHomedir ? customHomedir() : os.homedir();
}

export function setTestHomedir(fn: (() => string) | null): void {
  customHomedir = fn;
}

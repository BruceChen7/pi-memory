/**
 * Simple file-based logger for pi-memory plugin.
 * Writes logs to pi's debug log file.
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_NAME = "pi-memory";
const APP_NAME = "pi";
const CONFIG_DIR_NAME = ".pi";
const ENV_AGENT_DIR = "PI_AGENT_DIR";

function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}

function formatMessage(
	level: string,
	message: string,
	...args: unknown[]
): string {
	const timestamp = new Date().toISOString();
	const argsStr =
		args.length > 0
			? ` ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}`
			: "";
	return `[${timestamp}] [${PLUGIN_NAME}] [${level}] ${message}${argsStr}\n`;
}

/**
 * Write a debug level log message to file.
 */
export function debug(message: string, ...args: unknown[]): void {
	try {
		appendFileSync(getDebugLogPath(), formatMessage("DEBUG", message, ...args));
	} catch {
		// Silently ignore logging errors to avoid infinite loops
	}
}

/**
 * Write an error level log message to file.
 */
export function error(message: string, ...args: unknown[]): void {
	try {
		appendFileSync(getDebugLogPath(), formatMessage("ERROR", message, ...args));
	} catch {
		// Silently ignore logging errors to avoid infinite loops
	}
}

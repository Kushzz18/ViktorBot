import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const logDir = join(config.DATA_DIR, "logs");
const logPath = join(logDir, "viktor.log");

export function logInfo(message: string) {
  writeLog("INFO", message);
}

export function logError(error: unknown) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  writeLog("ERROR", message);
}

function writeLog(level: string, message: string) {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${message}\n`);
}

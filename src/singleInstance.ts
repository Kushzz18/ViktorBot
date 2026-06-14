import { constants } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const lockPath = join(process.cwd(), ".viktor.lock");

export async function claimSingleInstance() {
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch {
    const existingPid = await readExistingPid();

    if (existingPid && isProcessRunning(existingPid)) {
      throw new Error("Another Viktor bot process is already running. Stop it before starting a new one.");
    }

    await rm(lockPath, { force: true });
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(String(process.pid));
    await handle.close();
  }

  const release = async () => {
    await rm(lockPath, { force: true });
  };

  process.once("exit", () => {
    void rm(lockPath, { force: true });
  });
  process.once("SIGINT", () => {
    void release().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void release().finally(() => process.exit(0));
  });

  return release;
}

async function readExistingPid(): Promise<number | undefined> {
  try {
    const value = await readFile(lockPath, "utf8");
    const pid = Number(value.trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

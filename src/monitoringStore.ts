import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type StoredTechnicalSnapshot = {
  title?: string;
  metaDescription?: string;
  h1?: string;
  canonical?: string;
  robotsDirective?: string;
  robotsTxtHash?: string;
  robotsTxtPreview?: string;
  previousRobotsTxtPreview?: string;
  schemaTypes: string[];
};

export type MonitoringState = {
  lastDailyRun?: string;
  lastWeeklyRun?: string;
  lastMonthlyRun?: string;
  alertedKeys: Record<string, string>;
  technicalSnapshots: Record<string, StoredTechnicalSnapshot>;
};

const statePath = join(config.DATA_DIR, "monitoring-state.json");

let state: MonitoringState = {
  alertedKeys: {},
  technicalSnapshots: {}
};

export async function loadMonitoringState() {
  await mkdir(config.DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(statePath, "utf8");
    state = JSON.parse(raw) as MonitoringState;
    state.alertedKeys ??= {};
    state.technicalSnapshots ??= {};
  } catch {
    await saveMonitoringState();
  }
}

export function getMonitoringState() {
  return state;
}

export async function setLastDailyRun(value: string) {
  state.lastDailyRun = value;
  await saveMonitoringState();
}

export async function setLastWeeklyRun(value: string) {
  state.lastWeeklyRun = value;
  await saveMonitoringState();
}

export async function setLastMonthlyRun(value: string) {
  state.lastMonthlyRun = value;
  await saveMonitoringState();
}

export function getTechnicalSnapshot(client: string) {
  return state.technicalSnapshots[client];
}

export async function setTechnicalSnapshot(client: string, snapshot: StoredTechnicalSnapshot) {
  state.technicalSnapshots[client] = snapshot;
  await saveMonitoringState();
}

export function hasAlerted(key: string) {
  return Boolean(state.alertedKeys[key]);
}

export async function markAlerted(key: string) {
  state.alertedKeys[key] = new Date().toISOString();
  await saveMonitoringState();
}

async function saveMonitoringState() {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

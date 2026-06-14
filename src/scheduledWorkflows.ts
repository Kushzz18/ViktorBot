import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type ScheduledWorkflowType =
  | "daily_monitoring_alerts"
  | "weekly_performance_summary"
  | "monthly_performance_summary"
  | "followup_scan";

export type ScheduledWorkflow = {
  id: string;
  type: ScheduledWorkflowType;
  clientName?: string;
  channelName?: string;
  status: "active" | "paused";
  schedule: {
    frequency: "daily" | "weekly" | "monthly";
    hour: number;
    minute: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
  };
  createdBy?: string;
  createdAt: string;
  lastRunKey?: string;
  lastRunAt?: string;
};

const workflowsPath = join(config.DATA_DIR, "scheduled-workflows.json");
let workflows: ScheduledWorkflow[] = [];

export async function loadScheduledWorkflows() {
  await mkdir(config.DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(workflowsPath, "utf8")) as ScheduledWorkflow[];
    workflows = Array.isArray(parsed) ? parsed.filter(isScheduledWorkflow) : [];
  } catch {
    workflows = [];
    await saveScheduledWorkflows();
  }
}

export function listScheduledWorkflows(): ScheduledWorkflow[] {
  return [...workflows];
}

export function activeWorkflowClientNames(type: ScheduledWorkflowType): string[] {
  return [...new Set(workflows
    .filter((workflow) => workflow.status === "active" && workflow.type === type && workflow.clientName)
    .map((workflow) => workflow.clientName as string))];
}

export async function createScheduledWorkflow(input: Omit<ScheduledWorkflow, "id" | "status" | "createdAt" | "lastRunKey" | "lastRunAt">) {
  const now = new Date();
  const workflow: ScheduledWorkflow = {
    ...input,
    id: randomUUID().slice(0, 8),
    status: "active",
    createdAt: now.toISOString()
  };
  if (isDue(workflow, now)) {
    workflow.lastRunKey = runKey(workflow, now);
  }
  workflows.push(workflow);
  await saveScheduledWorkflows();
  return workflow;
}

export async function setScheduledWorkflowStatus(id: string, status: "active" | "paused") {
  const workflow = findWorkflow(id);
  if (!workflow) return undefined;
  workflow.status = status;
  await saveScheduledWorkflows();
  return workflow;
}

export async function deleteScheduledWorkflow(id: string): Promise<ScheduledWorkflow | undefined> {
  const index = workflows.findIndex((workflow) => workflow.id === id);
  if (index < 0) return undefined;
  const [removed] = workflows.splice(index, 1);
  await saveScheduledWorkflows();
  return removed;
}

export function getScheduledWorkflow(id: string): ScheduledWorkflow | undefined {
  return findWorkflow(id);
}

export function dueScheduledWorkflows(now = new Date()): ScheduledWorkflow[] {
  return workflows.filter((workflow) => workflow.status === "active" && isDue(workflow, now));
}

export async function markScheduledWorkflowRun(id: string, now = new Date()) {
  const workflow = findWorkflow(id);
  if (!workflow) return;
  workflow.lastRunAt = now.toISOString();
  workflow.lastRunKey = runKey(workflow, now);
  await saveScheduledWorkflows();
}

export function formatScheduledWorkflow(workflow: ScheduledWorkflow): string {
  const target = workflow.clientName ? ` for ${workflow.clientName}` : "";
  const channel = workflow.channelName ? ` in #${workflow.channelName}` : "";
  return `${workflow.id} - ${workflow.type}${target}${channel}, ${formatSchedule(workflow)}, ${workflow.status}`;
}

export function formatScheduledWorkflows(): string {
  const lines = workflows.map((workflow, index) => `${index + 1}. ${formatScheduledWorkflow(workflow)}`);
  return ["*Scheduled workflows*", ...(lines.length ? lines : ["No opt-in workflows yet."])].join("\n");
}

function isDue(workflow: ScheduledWorkflow, now: Date): boolean {
  const schedule = workflow.schedule;
  if (now.getHours() !== schedule.hour || now.getMinutes() < schedule.minute) return false;
  if (schedule.frequency === "weekly" && now.getDay() !== schedule.dayOfWeek) return false;
  if (schedule.frequency === "monthly" && now.getDate() !== (schedule.dayOfMonth ?? 1)) return false;
  return workflow.lastRunKey !== runKey(workflow, now);
}

function runKey(workflow: ScheduledWorkflow, now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  if (workflow.schedule.frequency === "monthly") return `${workflow.id}:${yyyy}-${mm}`;
  if (workflow.schedule.frequency === "weekly") return `${workflow.id}:${yyyy}-w${weekNumber(now)}`;
  return `${workflow.id}:${yyyy}-${mm}-${dd}`;
}

function weekNumber(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return Math.ceil((((date.getTime() - start.getTime()) / 86400000) + start.getDay() + 1) / 7);
}

function findWorkflow(id: string): ScheduledWorkflow | undefined {
  return workflows.find((workflow) => workflow.id.toLowerCase() === id.toLowerCase());
}

function formatSchedule(workflow: ScheduledWorkflow): string {
  const time = `${String(workflow.schedule.hour).padStart(2, "0")}:${String(workflow.schedule.minute).padStart(2, "0")}`;
  if (workflow.schedule.frequency === "weekly") return `weekly ${dayName(workflow.schedule.dayOfWeek ?? 1)} ${time}`;
  if (workflow.schedule.frequency === "monthly") return `monthly day ${workflow.schedule.dayOfMonth ?? 1} ${time}`;
  return `daily ${time}`;
}

function dayName(day: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "Monday";
}

function isScheduledWorkflow(value: unknown): value is ScheduledWorkflow {
  if (!value || typeof value !== "object") return false;
  const workflow = value as Partial<ScheduledWorkflow>;
  return typeof workflow.id === "string" &&
    typeof workflow.type === "string" &&
    workflow.schedule !== undefined &&
    typeof workflow.schedule.hour === "number" &&
    typeof workflow.schedule.minute === "number";
}

async function saveScheduledWorkflows() {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(workflowsPath, `${JSON.stringify(workflows, null, 2)}\n`, "utf8");
}

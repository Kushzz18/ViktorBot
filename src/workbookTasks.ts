import { google } from "googleapis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { getGoogleAuthClient } from "./googleAuth.js";
import { clientAliases, loadEditableClients, type ClientConfig } from "./clients.js";
import type { DraftTask } from "./taskParser.js";

export type WorkbookTaskResult = {
  spreadsheetId: string;
  spreadsheetName?: string;
  spreadsheetUrl: string;
  sheetName: string;
  rowRange?: string;
};

const WHATS_NEXT_SHEET = "Whats next";
const taskHistoryPath = join(config.DATA_DIR, "workbook-task-history.json");

export async function appendTaskToSeoWorkbook(draft: DraftTask): Promise<WorkbookTaskResult | undefined> {
  const target = await resolveWorkbookTarget(draft);
  if (!target) return undefined;

  const auth = await getGoogleAuthClient(await googleProfileForDraft(draft));
  const sheets = google.sheets({ version: "v4", auth });
  const sheetInfo = await resolveWhatsNextSheet(sheets, target.spreadsheetId);
  const sheetName = sheetInfo.title;
  const headers = await readSheetHeaders(sheets, target.spreadsheetId, sheetName);
  const row = buildTaskRow(draft, headers);
  const dateRange = taskDateRange(draft);
  const rowNumber = await findTaskInsertRow(sheets, target.spreadsheetId, sheetName, dateRange, headers);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: target.spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId: sheetInfo.sheetId,
            dimension: "ROWS",
            startIndex: rowNumber - 1,
            endIndex: rowNumber
          },
          inheritFromBefore: rowNumber > 2
        }
      }]
    }
  });
  const range = `'${sheetName}'!A${rowNumber}:${columnLetter(row.length)}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: target.spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [row]
    }
  });

  const result = {
    spreadsheetId: target.spreadsheetId,
    spreadsheetName: target.name,
    spreadsheetUrl: target.url,
    sheetName,
    rowRange: range.replace(/'/g, "")
  };
  await rememberWorkbookTask(draft, result);
  return result;
}

async function resolveWorkbookTarget(draft: DraftTask): Promise<{ spreadsheetId: string; name?: string; url: string } | undefined> {
  const fromUrl = extractSpreadsheetId(draft.workbookUrl ?? draft.description);
  if (fromUrl) {
    return {
      spreadsheetId: fromUrl,
      url: spreadsheetUrl(fromUrl)
    };
  }

  if (!draft.targetListName) return undefined;

  const auth = await getGoogleAuthClient(await googleProfileForDraft(draft));
  const drive = google.drive({ version: "v3", auth });
  const targetClient = await clientForDraft(draft);
  const targetNames = workbookTargetNames(draft, targetClient);
  const workbookQuery = [
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "name contains 'SEO Workbook'"
  ].join(" and ");

  const response = await drive.files.list({
    pageSize: 100,
    q: workbookQuery,
    fields: "files(id,name,webViewLink,modifiedTime)",
    orderBy: "modifiedTime desc"
  });

  const candidates = (response.data.files ?? [])
    .filter((file) => file.id)
    .map((file) => ({
      file,
      score: scoreWorkbookName(file.name ?? "", targetNames)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const match = candidates[0]?.file;
  if (!match?.id) {
    throw new Error(`Could not find an SEO workbook whose file name matches "${draft.targetListName}".`);
  }

  return {
    spreadsheetId: match.id,
    name: match.name ?? undefined,
    url: match.webViewLink ?? spreadsheetUrl(match.id)
  };
}

async function googleProfileForDraft(draft: DraftTask): Promise<string | undefined> {
  const client = await clientForDraft(draft);
  return client?.googleProfile;
}

async function clientForDraft(draft: DraftTask): Promise<ClientConfig | undefined> {
  if (!draft.targetListName) return undefined;
  const target = normalize(draft.targetListName);
  const clients = await loadEditableClients();
  return clients.find((item) => {
    const names = [item.client, item.clickupListName, item.gscSite].filter((value): value is string => Boolean(value));
    return names.some((name) => {
      const normalized = normalize(name);
      return normalized === target || normalized.includes(target) || target.includes(normalized);
    });
  });
}

async function resolveWhatsNextSheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<{ title: string; sheetId: number }> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(title,sheetId)"
  });
  const sheetsList = response.data.sheets ?? [];
  const exact = sheetsList.find((sheet) => normalize(sheet.properties?.title ?? "") === normalize(WHATS_NEXT_SHEET));
  const loose = sheetsList.find((sheet) => {
    const title = normalize(sheet.properties?.title ?? "");
    return title.includes("what next") || title.includes("whats next");
  });
  const match = exact ?? loose;
  if (match?.properties?.title && typeof match.properties.sheetId === "number") {
    return { title: match.properties.title, sheetId: match.properties.sheetId };
  }

  throw new Error(`Could not find a "${WHATS_NEXT_SHEET}" tab in the SEO workbook.`);
}

type HeaderKey =
  | "date"
  | "task"
  | "taskInfo"
  | "category"
  | "assignee"
  | "status"
  | "checklistFile"
  | "workFile"
  | "taskDescription"
  | "dueDate"
  | "priority"
  | "send"
  | "edit"
  | "clickUpTaskId"
  | "sentStatus";

type HeaderMap = {
  width: number;
  indexes: Partial<Record<HeaderKey, number>>;
};

async function readSheetHeaders(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetName: string
): Promise<HeaderMap> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:Z1`,
    majorDimension: "ROWS"
  });
  const headers = (response.data.values?.[0] ?? []).map((value) => String(value ?? ""));
  const indexes: Partial<Record<HeaderKey, number>> = {};

  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (key && typeof indexes[key] !== "number") indexes[key] = index;
  });

  const fallback: HeaderKey[] = [
    "date",
    "task",
    "taskInfo",
    "category",
    "assignee",
    "status",
    "checklistFile",
    "workFile",
    "taskDescription",
    "dueDate",
    "priority",
    "send",
    "edit",
    "clickUpTaskId",
    "sentStatus"
  ];
  fallback.forEach((key, index) => {
    indexes[key] ??= index;
  });

  return {
    width: Math.max(headers.length, fallback.length),
    indexes
  };
}

function headerKey(value: string): HeaderKey | undefined {
  const normalized = normalize(value);
  if (normalized === "date" || normalized === "date range") return "date";
  if (normalized === "task") return "task";
  if (normalized === "task info" || normalized === "info") return "taskInfo";
  if (normalized === "category") return "category";
  if (normalized === "assignee" || normalized === "assignees") return "assignee";
  if (normalized === "status") return "status";
  if (normalized === "checklist file") return "checklistFile";
  if (normalized === "work file") return "workFile";
  if (normalized === "task description" || normalized === "description") return "taskDescription";
  if (normalized === "due date" || normalized === "due") return "dueDate";
  if (normalized === "priority") return "priority";
  if (normalized === "send" || normalized === "send?") return "send";
  if (normalized === "edit" || normalized === "edit?") return "edit";
  if (normalized === "clickup task id" || normalized === "click up task id") return "clickUpTaskId";
  if (normalized === "sent status") return "sentStatus";
  return undefined;
}

function taskDueDate(draft: DraftTask): Date {
  return draft.dueDate ? new Date(draft.dueDate) : currentWorkWeekEnd();
}

function taskDateRange(draft: DraftTask): string {
  return workWeekRangeForDate(taskDueDate(draft));
}

function buildTaskRow(draft: DraftTask, headers: HeaderMap): string[] {
  const dueDate = taskDueDate(draft);
  const taskInfo = cleanTaskInfo(draft.description, draft.title);
  const priority = formatPriority(draft.priority);
  const values = new Array(Math.max(headers.width, 15)).fill("");
  const set = (key: HeaderKey, value: string) => {
    const index = headers.indexes[key];
    if (typeof index === "number") values[index] = value;
  };

  set("date", workWeekRangeForDate(dueDate));
  set("task", draft.title);
  set("taskInfo", taskInfo);
  set("category", draft.category ?? "");
  set("assignee", draft.assigneeNames.join(", "));
  set("status", "To Do");
  set("checklistFile", "");
  set("workFile", formatWorkFile(draft.description));
  set("taskDescription", formatTaskDescription(taskInfo));
  set("dueDate", formatSheetDate(dueDate));
  set("priority", priority);
  set("send", "TRUE");
  set("edit", "FALSE");
  set("clickUpTaskId", "");
  set("sentStatus", "");

  return values;
}

async function findTaskInsertRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetName: string,
  targetDateRange: string,
  headers: HeaderMap
): Promise<number> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A2:${columnLetter(headers.width)}1500`,
    majorDimension: "ROWS"
  });
  const rows = response.data.values ?? [];
  const targetStart = parseDateRangeStart(targetDateRange);
  let lastContentRow = 1;
  let lastDateRangeRow = 1;
  let currentBlockStart: Date | undefined;
  let exactBlockLastRow: number | undefined;
  let firstLaterBlockRow: number | undefined;

  rows.forEach((row, index) => {
    const sheetRowNumber = index + 2;
    if (hasTaskRowContent(row, headers)) lastContentRow = sheetRowNumber;

    const dateRange = String(row[headers.indexes.date ?? 0] ?? "").trim();
    const parsedStart = dateRange ? parseDateRangeStart(dateRange) : undefined;
    if (parsedStart) {
      currentBlockStart = parsedStart;
      lastDateRangeRow = sheetRowNumber;
      if (!firstLaterBlockRow && targetStart && parsedStart.getTime() > targetStart.getTime()) {
        firstLaterBlockRow = sheetRowNumber;
      }
    }

    if (targetStart && currentBlockStart && currentBlockStart.getTime() === targetStart.getTime() && hasTaskRowContent(row, headers)) {
      exactBlockLastRow = sheetRowNumber;
    }
  });

  if (exactBlockLastRow) return exactBlockLastRow + 1;
  if (firstLaterBlockRow) return firstLaterBlockRow;
  return Math.max(lastContentRow, lastDateRangeRow) + 1;
}

function hasTaskRowContent(row: unknown[], headers: HeaderMap): boolean {
  const importantKeys: HeaderKey[] = ["date", "task", "taskInfo", "category", "assignee", "status", "dueDate", "priority", "send", "clickUpTaskId", "sentStatus"];
  return importantKeys.some((key) => {
    const index = headers.indexes[key];
    return typeof index === "number" && String(row[index] ?? "").trim();
  });
}

function cleanTaskInfo(description: string, title: string): string {
  const clean = description
    .replace(/^create task:\s*/i, "")
    .replace(/^task:\s*/i, "")
    .replace(/\|\s*(client|list|project|due|due date|priority|assignee|assignees|category|workbook|sheet)(?: url)?\s*:[^|]+/gi, "")
    .trim();
  const explicit = description.match(/\|\s*(?:task info|description|desc)\s*:\s*([^|]+)/i)?.[1]?.trim();
  if (explicit) return explicit;
  return clean && normalize(clean) !== normalize(title) && !isTaskCreationInstruction(clean, title) ? clean : "";
}

function formatWorkFile(description: string): string {
  const urls = [...description.matchAll(/https?:\/\/[^\s|]+/g)].map((match) => match[0]);
  if (!urls.length) return 'Description: ""\n\nFile: ""';
  return `Description: ""\n\nFile:\n${urls.map((url) => `"${url}"`).join("\n")}`;
}

function formatTaskDescription(description: string): string {
  return [`Pre Description: ""`, "", description ? `Description: "${description}"` : 'Description: ""', "", 'Checklist File: ""'].join("\n");
}

function formatPriority(priority: DraftTask["priority"]): string {
  if (priority === 1) return "Urgent";
  if (priority === 2) return "High";
  if (priority === 4) return "Low";
  return "Normal";
}

function workWeekRangeForDate(date: Date): string {
  const start = startOfWorkWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 4);
  return `${formatMonthDay(start)} - ${end.getDate()}`;
}

function currentWorkWeekEnd(): Date {
  const start = startOfWorkWeek(new Date());
  const end = new Date(start);
  end.setDate(start.getDate() + 4);
  return end;
}

function startOfWorkWeek(date: Date): Date {
  const copy = new Date(date);
  const day = copy.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + mondayOffset);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function formatSheetDate(date: Date): string {
  return formatMonthDay(date);
}

function formatMonthDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseDateRangeStart(value: string): Date | undefined {
  const match = value.match(/\b([A-Za-z]+)\s+(\d{1,2})\s*-\s*(?:[A-Za-z]+\s+)?\d{1,2}\b/);
  if (!match?.[1] || !match[2]) return undefined;
  const year = new Date().getFullYear();
  const parsed = new Date(`${match[1]} ${match[2]}, ${year}`);
  return Number.isNaN(parsed.getTime()) ? undefined : startOfWorkWeek(parsed);
}

function isTaskCreationInstruction(value: string, title: string): boolean {
  const normalized = normalize(value);
  const normalizedTitle = normalize(title);
  return /\b(create|make|add|set up|open)\b.*\b(task|ticket)\b/.test(normalized) && normalized.includes(normalizedTitle);
}

function extractSpreadsheetId(value: string): string | undefined {
  return value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1];
}

function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

type WorkbookTaskHistoryItem = WorkbookTaskResult & {
  title: string;
  clientName?: string;
  createdAt: string;
};

export async function formatLastWorkbookTaskLocation(): Promise<string> {
  const items = await loadWorkbookTaskHistory();
  const latest = items[0];
  if (!latest) return "I do not have a recent workbook task creation recorded yet.";
  const sheetTarget = `<${latest.spreadsheetUrl}|${latest.spreadsheetName ?? "SEO workbook"}>`;
  const rowNote = latest.rowRange ? `, row ${latest.rowRange}` : "";
  return [
    `The last workbook task I created was for ${latest.clientName ?? "the selected client"}.`,
    `Task: ${latest.title}`,
    `File: ${sheetTarget}`,
    `File URL: ${latest.spreadsheetUrl}`,
    `Tab/row: ${latest.sheetName}${rowNote}.`
  ].join("\n");
}

async function rememberWorkbookTask(draft: DraftTask, result: WorkbookTaskResult) {
  const history = await loadWorkbookTaskHistory();
  const next: WorkbookTaskHistoryItem = {
    ...result,
    title: draft.title,
    clientName: draft.targetListName,
    createdAt: new Date().toISOString()
  };
  await saveWorkbookTaskHistory([next, ...history].slice(0, 50));
}

async function loadWorkbookTaskHistory(): Promise<WorkbookTaskHistoryItem[]> {
  try {
    const raw = await readFile(taskHistoryPath, "utf8");
    return JSON.parse(raw) as WorkbookTaskHistoryItem[];
  } catch {
    return [];
  }
}

async function saveWorkbookTaskHistory(items: WorkbookTaskHistoryItem[]) {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(taskHistoryPath, JSON.stringify(items, null, 2), "utf8");
}

function columnLetter(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || "A";
}

function workbookTargetNames(draft: DraftTask, client?: ClientConfig): string[] {
  const names = [
    draft.targetListName,
    client?.client,
    client?.clickupListName,
    ...(client ? clientAliases(client) : [])
  ].filter((value): value is string => Boolean(value));
  return [...new Set(names.map((name) => stripWorkbookNoise(name)).filter(Boolean))];
}

function scoreWorkbookName(name: string, targetNames: string[]): number {
  const normalized = normalize(name);
  if (!normalized.includes("seo workbook")) return 0;

  let score = 0;
  const nameTokens = normalized.split(/\s+/);
  for (const targetName of targetNames) {
    if (normalized.includes(targetName)) {
      score = Math.max(score, 100 + targetName.length);
      continue;
    }

    const tokens = targetName
      .split(/\s+/)
      .filter((term) => term && !["seo", "workbook", "internal", "file", "client", "the"].includes(term));
    if (tokens.length && tokens.every((term) => nameTokens.includes(term))) {
      score = Math.max(score, 70 + tokens.length);
    }
  }
  return score;
}

function stripWorkbookNoise(value: string): string {
  return normalize(value)
    .replace(/\bseo\b/g, "")
    .replace(/\bworkbook\b/g, "")
    .replace(/\binternal\b/g, "")
    .replace(/\bfile\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

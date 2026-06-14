import { config } from "./config.js";
import { parseDueDate, type DraftTask } from "./taskParser.js";

export type ClickUpTask = {
  id: string;
  url: string;
  name: string;
};

export type ClickUpHealthTask = {
  id: string;
  name: string;
  status?: string;
  url?: string;
  dueDate?: number;
  updatedAt?: number;
  timeEstimate?: number;
  listName?: string;
  assignees: string[];
  priority?: string;
};

export type ClickUpList = {
  id: string;
  name: string;
};

export type ClickUpComment = {
  text: string;
  user?: string;
  createdAt?: number;
};

export type ClickUpDateRange = {
  label: string;
  start?: number;
  end?: number;
};

const STANDARD_STATUSES = [
  "To Do",
  "In Progress",
  "Today's Plan",
  "Roadblock",
  "Review",
  "Revision",
  "Ready To Implement",
  "Complete"
];
const WORKLOAD_STATUSES = STANDARD_STATUSES.filter((status) => status !== "Complete");

export async function createClickUpTask(draft: DraftTask): Promise<ClickUpTask> {
  const listId = await resolveListId(draft.targetListName);
  const assignees = draft.assigneeNames
    .map((name) => config.ASSIGNEE_MAP[name.toLowerCase()])
    .filter((id): id is number => typeof id === "number");

  const response = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
    method: "POST",
    headers: {
      Authorization: config.CLICKUP_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: draft.title,
      markdown_description: draft.description,
      assignees,
      due_date: draft.dueDate,
      priority: draft.priority
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickUp task creation failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { id: string; url?: string; name: string };

  return {
    id: data.id,
    url: data.url ?? `https://app.clickup.com/t/${data.id}`,
    name: data.name
  };
}

export async function getClickUpTaskHealth(targetListName?: string): Promise<ClickUpHealthTask[]> {
  const listId = await resolveListId(targetListName);
  return fetchClickUpTasksForList(listId, targetListName);
}

export async function searchClickUpTasks(query: string, options: { listName?: string; includeClosed?: boolean; range?: ClickUpDateRange } = {}): Promise<ClickUpHealthTask[]> {
  const tasks = await getClickUpTasksForScope(options.listName, options.includeClosed ?? false);
  const normalized = normalizeSearch(query);
  return tasks
    .filter((task) => taskInRange(task, options.range))
    .filter((task) => {
      const haystack = normalizeSearch(`${task.name} ${task.id} ${task.status ?? ""} ${task.listName ?? ""} ${task.assignees.join(" ")}`);
      return normalized.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
    });
}

export async function getClickUpWorkload(scope?: { assignee?: string; team?: string; listName?: string; range?: ClickUpDateRange; includeClosed?: boolean }): Promise<ClickUpHealthTask[]> {
  const tasks = await getClickUpTasksForScope(scope?.listName, scope?.includeClosed ?? true);
  const assignee = scope?.assignee ? normalizeSearch(scope.assignee) : undefined;
  const team = scope?.team ? normalizeSearch(scope.team) : undefined;
  return tasks
    .filter((task) => taskInRange(task, scope?.range))
    .filter((task) => {
      if (assignee && !task.assignees.some((name) => assigneeMatches(name, assignee))) return false;
      if (team && !normalizeSearch(`${task.listName ?? ""} ${task.name}`).includes(team)) return false;
      return true;
    });
}

export async function getClickUpOverdueTasks(scope?: { assignee?: string; team?: string; listName?: string; range?: ClickUpDateRange }): Promise<ClickUpHealthTask[]> {
  const now = Date.now();
  return (await getClickUpWorkload({ ...scope, includeClosed: false }))
    .filter((task) => task.dueDate && task.dueDate < now)
    .sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0));
}

export async function getClickUpTaskDetails(taskId: string): Promise<ClickUpHealthTask> {
  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: {
      Authorization: config.CLICKUP_API_TOKEN
    }
  });

  if (!response.ok) {
    throw new Error(`ClickUp task fetch failed (${response.status}): ${await response.text()}`);
  }

  return normalizeTask(await response.json());
}

export async function getClickUpTaskComments(taskId: string): Promise<ClickUpComment[]> {
  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    headers: {
      Authorization: config.CLICKUP_API_TOKEN
    }
  });

  if (!response.ok) {
    throw new Error(`ClickUp comments fetch failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as {
    comments?: Array<{
      comment_text?: string;
      date?: string;
      user?: { username?: string; email?: string };
    }>;
  };
  return (data.comments ?? []).map((comment) => ({
    text: stripHtml(comment.comment_text ?? ""),
    user: comment.user?.username ?? comment.user?.email,
    createdAt: comment.date ? Number(comment.date) : undefined
  }));
}

export async function getClickUpTasksForScope(listName?: string, includeClosed = false): Promise<ClickUpHealthTask[]> {
  if (listName) return fetchClickUpTasksForList(await resolveListId(listName), listName, includeClosed);
  const lists = await listClickUpLists();
  const scopedLists = lists.length ? lists : [{ id: config.CLICKUP_LIST_ID, name: "Default" }];
  const chunks = await Promise.all(scopedLists.map((list) => fetchClickUpTasksForList(list.id, list.name, includeClosed)));
  return chunks.flat();
}

export async function listClickUpLists(): Promise<ClickUpList[]> {
  if (!config.CLICKUP_FOLDER_ID) return [];
  const response = await fetch(`https://api.clickup.com/api/v2/folder/${config.CLICKUP_FOLDER_ID}/list`, {
    headers: {
      Authorization: config.CLICKUP_API_TOKEN
    }
  });

  if (!response.ok) return [];
  const data = (await response.json()) as { lists?: Array<{ id: string; name: string }> };
  return (data.lists ?? []).map((list) => ({ id: list.id, name: list.name }));
}

async function fetchClickUpTasksForList(listId: string, listName?: string, includeClosed = false): Promise<ClickUpHealthTask[]> {
  const tasks: unknown[] = [];
  for (let page = 0; page < 20; page += 1) {
    const response = await fetch(
      `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=${includeClosed ? "true" : "false"}&subtasks=true&page=${page}`,
      {
        headers: {
          Authorization: config.CLICKUP_API_TOKEN
        }
      }
    );

    if (!response.ok) {
      throw new Error(`ClickUp health fetch failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as { tasks?: unknown[] };
    const pageTasks = data.tasks ?? [];
    tasks.push(...pageTasks);
    if (pageTasks.length < 100) break;
  }

  return tasks.map((task) => normalizeTask(task, listName));
}

export async function addClickUpComment(taskId: string, commentText: string): Promise<void> {
  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
    method: "POST",
    headers: {
      Authorization: config.CLICKUP_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      comment_text: commentText
    })
  });

  if (!response.ok) {
    throw new Error(`ClickUp comment failed (${response.status}): ${await response.text()}`);
  }
}

export async function updateClickUpTask(input: {
  taskId: string;
  status?: string;
  due?: string;
  priority?: 1 | 2 | 3 | 4;
  name?: string;
  description?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.status) body.status = input.status;
  if (input.due) body.due_date = parseDueDate(input.due);
  if (input.priority) body.priority = input.priority;
  if (input.name) body.name = input.name;
  if (input.description) body.markdown_description = input.description;

  const response = await fetch(`https://api.clickup.com/api/v2/task/${input.taskId}`, {
    method: "PUT",
    headers: {
      Authorization: config.CLICKUP_API_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`ClickUp update failed (${response.status}): ${await response.text()}`);
  }
}

export async function closeClickUpTask(taskId: string): Promise<void> {
  await updateClickUpTask({ taskId, status: "complete" });
}

export function formatClickUpHealth(tasks: ClickUpHealthTask[], listName?: string): string {
  const now = Date.now();
  const overdue = tasks.filter((task) => task.dueDate && task.dueDate < now);
  const unassigned = tasks.filter((task) => !task.assignees.length);
  const urgent = tasks.filter((task) => task.priority?.toLowerCase() === "urgent");

  const sample = [...overdue, ...unassigned, ...urgent].slice(0, 10).map((task, index) => {
    const flags = [
      task.dueDate && task.dueDate < now ? "overdue" : "",
      !task.assignees.length ? "unassigned" : "",
      task.priority ? `priority: ${task.priority}` : ""
    ].filter(Boolean).join(", ");
    return `${index + 1}. <${task.url ?? `https://app.clickup.com/t/${task.id}`}|${task.name}> (${flags || task.status || "open"})`;
  });

  return [
    `ClickUp health${listName ? ` for ${listName}` : ""}:`,
    `Open tasks: ${tasks.length}`,
    `Overdue: ${overdue.length}`,
    `Unassigned: ${unassigned.length}`,
    `Urgent: ${urgent.length}`,
    sample.length ? "Needs attention:" : "No obvious task-health issues found.",
    ...sample
  ].filter(Boolean).join("\n");
}

export function formatClickUpTaskList(title: string, tasks: ClickUpHealthTask[], options: { limit?: number; rangeLabel?: string; followUp?: string } = {}): string {
  const limit = options.limit ?? 50;
  const shown = tasks.slice(0, limit);
  const rows = shown.map((task, index) => {
    const parts = [
      task.status,
      task.dueDate ? `due ${formatDate(task.dueDate)}` : "",
      task.timeEstimate ? `estimate ${formatDuration(task.timeEstimate)}` : "",
      task.assignees.length ? task.assignees.join(", ") : "unassigned",
      task.listName
    ].filter(Boolean).join(" | ");
    return `${index + 1}. <${task.url ?? `https://app.clickup.com/t/${task.id}`}|${task.name}>${parts ? ` (${parts})` : ""}`;
  });
  return [
    title,
    options.rangeLabel ? `Date scope: ${options.rangeLabel}` : "",
    `Tasks found: ${tasks.length}${shown.length < tasks.length ? ` (showing ${shown.length})` : ""}`,
    rows.length ? rows.join("\n") : "No matching tasks found.",
    options.followUp ? `Follow-up: ${options.followUp}` : ""
  ].filter(Boolean).join("\n");
}

export function formatClickUpWorkload(title: string, tasks: ClickUpHealthTask[], options: { rangeLabel?: string; includeTaskSample?: boolean; memberNames?: string[] } = {}): string {
  const activeTasks = tasks.filter((task) => !isCompleteStatus(task.status));
  const statusTable = formatStatusTable(tasks, "Status overview");
  const peopleTable = formatPeopleWorkloadTable(tasks, "People workload", options.memberNames);
  const sample = options.includeTaskSample
    ? formatClickUpTaskList("Task sample", tasks, { limit: 15 }).split("\n").slice(2).join("\n")
    : "";

  return [
    title,
    options.rangeLabel ? `Date scope: ${options.rangeLabel}` : "",
    `Active tasks in scope: ${activeTasks.length}`,
    statusTable,
    peopleTable,
    activeTasks.length ? "" : "No active tasks found.",
    sample ? `*Tasks*\n${sample}` : ""
  ].filter(Boolean).join("\n\n");
}

export function formatClickUpTeamStatusMatrix(title: string, teamTasks: Array<{ team: string; tasks: ClickUpHealthTask[]; memberNames?: string[] }>, options: { rangeLabel?: string; includePeople?: boolean } = {}): string {
  const statuses = unique([...WORKLOAD_STATUSES, ...teamTasks.flatMap((entry) => entry.tasks.map((task) => normalizeStatus(task.status)).filter((status) => status !== "Complete"))])
    .sort((a, b) => statusSort(a) - statusSort(b) || a.localeCompare(b));
  const teamNames = teamTasks.map((entry) => entry.team);
  const rows = statuses.map((status) => [
    status,
    ...teamTasks.map((entry) => String(entry.tasks.filter((task) => normalizeStatus(task.status) === status).length))
  ]);
  const totals = [
    "Not Completed Tasks",
    ...teamTasks.map((entry) => String(entry.tasks.filter((task) => !isCompleteStatus(task.status)).length))
  ];
  return [
    title,
    options.rangeLabel ? `Date scope: ${options.rangeLabel}` : "",
    codeTable(["Status", ...teamNames], [...rows, totals]),
    ...(options.includePeople === false ? [] : teamTasks.map((entry) => formatPeopleWorkloadTable(entry.tasks, `${entry.team} people workload`, entry.memberNames)))
  ].filter(Boolean).join("\n\n");
}

export function formatClickUpTaskChange(task: ClickUpHealthTask, comments: ClickUpComment[]): string {
  const recent = comments
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 5)
    .map((comment) => `- ${comment.createdAt ? formatDate(comment.createdAt) : "unknown date"}${comment.user ? ` by ${comment.user}` : ""}: ${shorten(comment.text, 180)}`);

  return [
    `ClickUp task: <${task.url ?? `https://app.clickup.com/t/${task.id}`}|${task.name}>`,
    `Status: ${task.status ?? "unknown"}`,
    task.dueDate ? `Due: ${formatDate(task.dueDate)}` : "",
    task.updatedAt ? `Last updated: ${formatDate(task.updatedAt)}` : "",
    task.assignees.length ? `Assignees: ${task.assignees.join(", ")}` : "Assignees: none",
    recent.length ? "Recent comments/activity I can see:" : "No recent comments were returned by ClickUp.",
    ...recent
  ].filter(Boolean).join("\n");
}

async function resolveListId(targetListName?: string): Promise<string> {
  if (!targetListName || !config.CLICKUP_FOLDER_ID) {
    return config.CLICKUP_LIST_ID;
  }

  const response = await fetch(`https://api.clickup.com/api/v2/folder/${config.CLICKUP_FOLDER_ID}/list`, {
    headers: {
      Authorization: config.CLICKUP_API_TOKEN
    }
  });

  if (!response.ok) {
    return config.CLICKUP_LIST_ID;
  }

  const data = (await response.json()) as { lists?: Array<{ id: string; name: string }> };
  const target = normalizeListName(targetListName);
  const lists = data.lists ?? [];
  const match = lists.find((list) => normalizeListName(list.name) === target) ??
    lists.find((list) => normalizeListName(list.name).includes(target)) ??
    lists.find((list) => target.includes(normalizeListName(list.name)));

  return match?.id ?? config.CLICKUP_LIST_ID;
}

function normalizeTask(raw: unknown, listName?: string): ClickUpHealthTask {
  const task = raw as {
    id?: string;
    name?: string;
    url?: string;
    due_date?: string | null;
    date_updated?: string | null;
    time_estimate?: number | null;
    status?: { status?: string };
    assignees?: Array<{ username?: string; email?: string }>;
    priority?: { priority?: string };
    list?: { name?: string };
  };
  const id = task.id ?? "unknown";
  return {
    id,
    name: task.name ?? "Untitled task",
    status: task.status?.status,
    url: task.url ?? `https://app.clickup.com/t/${id}`,
    dueDate: task.due_date ? Number(task.due_date) : undefined,
    updatedAt: task.date_updated ? Number(task.date_updated) : undefined,
    timeEstimate: typeof task.time_estimate === "number" ? task.time_estimate : undefined,
    listName: task.list?.name ?? listName,
    assignees: task.assignees?.map((assignee) => assignee.username ?? assignee.email ?? "unknown").filter(Boolean) ?? [],
    priority: task.priority?.priority
  };
}

function formatDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function formatDuration(milliseconds: number): string {
  const hours = milliseconds / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(milliseconds / (60 * 1000))}m`;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(hours * 10) / 10}h`;
}

function shorten(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 3)}...`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function taskInRange(task: ClickUpHealthTask, range?: ClickUpDateRange): boolean {
  if (!range || (!range.start && !range.end)) return true;
  const value = task.dueDate;
  if (!value) return false;
  if (range.start && value < range.start) return false;
  if (range.end && value > range.end) return false;
  return true;
}

function assigneeMatches(name: string, normalizedTarget: string): boolean {
  const normalizedName = normalizeSearch(name);
  return normalizedName.includes(normalizedTarget) || normalizedTarget.includes(normalizedName) ||
    normalizedTarget.split(/\s+/).every((part) => normalizedName.includes(part));
}

function formatStatusTable(tasks: ClickUpHealthTask[], title: string): string {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (isCompleteStatus(task.status)) continue;
    const status = normalizeStatus(task.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const rows = unique([...WORKLOAD_STATUSES, ...counts.keys()])
    .sort((a, b) => statusSort(a) - statusSort(b) || a.localeCompare(b))
    .map((status) => [status, String(counts.get(status) ?? 0)]);
  rows.push(["Not Completed Tasks", String(tasks.filter((task) => !isCompleteStatus(task.status)).length)]);
  return [`*${title}*`, codeTable(["Status", "Tasks"], rows.length ? rows : [["None", "0"]])].join("\n");
}

function formatPeopleWorkloadTable(tasks: ClickUpHealthTask[], title = "People workload", memberNames?: string[]): string {
  const rosterMembers = splitRosterMembers(memberNames ?? []);
  const people = new Map<string, ClickUpHealthTask[]>();
  for (const member of rosterMembers) people.set(member, []);

  for (const task of tasks) {
    const assignees = task.assignees.length ? task.assignees : ["Unassigned"];
    for (const assignee of assignees) {
      const person = rosterMembers.length ? matchRosterMember(assignee, rosterMembers) : assignee;
      if (!person) continue;
      const existing = people.get(person) ?? [];
      existing.push(task);
      people.set(person, existing);
    }
  }
  const displayNames = shortDisplayNames([...people.keys()]);
  const rows = [...people.entries()]
    .map(([name, assignedTasks]) => [name, assignedTasks.filter((task) => !isCompleteStatus(task.status))] as const)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, activeAssignedTasks]) => [
      displayNames.get(name) ?? name,
      String(activeAssignedTasks.length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "To Do").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "In Progress").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "Today's Plan").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "Roadblock").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "Review").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "Revision").length),
      String(activeAssignedTasks.filter((task) => normalizeStatus(task.status) === "Ready To Implement").length)
    ]);
  return [`*${title}*`, codeTable(
    ["Person", "Total", "ToDo", "Prog", "Plan", "Block", "Review", "Rev", "Ready"],
    rows.length ? rows : [["None", "0", "0", "0", "0", "0", "0", "0", "0"]]
  )].join("\n");
}

function normalizePersonName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanPersonName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function splitRosterMembers(names: string[]): string[] {
  const seen = new Set<string>();
  return names
    .flatMap((name) => name.split("+"))
    .map(cleanPersonName)
    .filter((name) => {
      if (!name) return false;
      const key = normalizePersonName(name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function matchRosterMember(name: string, rosterMembers: string[]): string | undefined {
  const normalizedName = normalizePersonName(name);
  const exact = rosterMembers.find((member) => normalizePersonName(member) === normalizedName);
  if (exact) return exact;
  const fuzzy = rosterMembers.find((member) => personMatchesRosterMember(normalizedName, member));
  if (fuzzy) return fuzzy;
  return uniqueFirstNameRosterMatch(normalizedName, rosterMembers);
}

function personMatchesRosterMember(normalizedName: string, member: string): boolean {
  return rosterMemberAliases(member).some((alias) =>
    normalizedName === alias ||
    normalizedName.includes(alias) ||
    alias.split(/\s+/).every((part) => normalizedName.includes(part))
  );
}

function uniqueFirstNameRosterMatch(normalizedName: string, rosterMembers: string[]): string | undefined {
  if (!normalizedName || normalizedName.includes(" ")) return undefined;
  const matches = rosterMembers.filter((member) => normalizePersonName(firstName(member)) === normalizedName);
  return matches.length === 1 ? matches[0] : undefined;
}

function rosterMemberAliases(member: string): string[] {
  const aliases = [member];
  if (member.includes("+")) {
    aliases.push(...member.split("+").map((part) => part.trim()).filter(Boolean));
  }
  return aliases.map(normalizePersonName).filter(Boolean);
}

function shortDisplayNames(names: string[]): Map<string, string> {
  const pieces = names.map((name) => ({ name, first: firstName(name), lastInitial: lastInitial(name), combined: compactCombinedName(name) }));
  const firstCounts = new Map<string, number>();
  for (const piece of pieces) {
    firstCounts.set(piece.first.toLowerCase(), (firstCounts.get(piece.first.toLowerCase()) ?? 0) + 1);
  }
  return new Map(pieces.map((piece) => [
    piece.name,
    piece.combined ?? (shouldUseLastInitial(piece.first, firstCounts) && piece.lastInitial ? `${piece.first} ${piece.lastInitial}` : piece.first)
  ]));
}

function shouldUseLastInitial(first: string, firstCounts: Map<string, number>): boolean {
  const key = first.toLowerCase();
  return (firstCounts.get(key) ?? 0) > 1 || ["anish", "manish", "prakash"].includes(key);
}

function firstName(name: string): string {
  const firstPart = name.split("+")[0] ?? name;
  return titleCaseName(firstPart.trim().split(/\s+/)[0] ?? firstPart);
}

function lastInitial(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[parts.length - 1][0].toUpperCase()}.` : "";
}

function titleCaseName(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function compactCombinedName(name: string): string | undefined {
  if (!name.includes("+")) return undefined;
  const parts = name.split("+").map((part) => firstName(part)).filter(Boolean);
  return parts.length ? parts.join("+") : undefined;
}

function normalizeStatus(status?: string): string {
  const normalized = (status ?? "No status").toLowerCase().replace(/[_-]+/g, " ").trim();
  const map: Record<string, string> = {
    "to do": "To Do",
    todo: "To Do",
    open: "To Do",
    "in progress": "In Progress",
    "today's plan": "Today's Plan",
    "today s plan": "Today's Plan",
    "todays plan": "Today's Plan",
    roadblock: "Roadblock",
    "road block": "Roadblock",
    review: "Review",
    "implemented need review": "Review",
    "implemented needs review": "Review",
    revision: "Revision",
    "ready to implement": "Ready To Implement",
    complete: "Complete",
    completed: "Complete",
    closed: "Complete",
    done: "Complete"
  };
  return map[normalized] ?? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusSort(status: string): number {
  const index = STANDARD_STATUSES.indexOf(status);
  return index === -1 ? 999 : index;
}

function isCompleteStatus(status?: string): boolean {
  return normalizeStatus(status) === "Complete";
}

function codeTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length))
  );
  const formatRow = (row: string[]) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index] ?? 0)).join(" | ");
  return [
    "```",
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("-+-"),
    ...rows.map(formatRow),
    "```"
  ].join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeListName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/seo/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

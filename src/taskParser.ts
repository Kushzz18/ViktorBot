export type DraftTask = {
  title: string;
  description: string;
  dueDate?: number;
  assigneeNames: string[];
  priority?: 1 | 2 | 3 | 4;
  targetListName?: string;
  category?: string;
  workbookUrl?: string;
};

const priorityMap: Record<string, 1 | 2 | 3 | 4> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4
};

export function parseTaskDraft(input: string): DraftTask {
  const cleanInput = input
    .replace(/^create task:\s*/i, "")
    .replace(/^task:\s*/i, "")
    .trim();

  const parts = cleanInput
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  const title = parts[0] || "Untitled task";
  const fields = parts.slice(1);
  const assigneeNames: string[] = [];
  let dueDate: number | undefined;
  let priority: 1 | 2 | 3 | 4 | undefined;
  let targetListName: string | undefined;
  let category: string | undefined;
  let workbookUrl: string | undefined;

  for (const field of fields) {
    const [rawKey, ...rawValueParts] = field.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim();

    if (key === "due" || key === "due date") {
      dueDate = parseDueDate(value);
    }

    if (key === "assignee" || key === "assignees") {
      assigneeNames.push(
        ...value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      );
    }

    if (key === "priority") {
      priority = priorityMap[value.toLowerCase()];
    }

    if (key === "client" || key === "list" || key === "project") {
      targetListName = value;
    }

    if (key === "category") {
      category = value || undefined;
    }

    if (key === "workbook" || key === "sheet" || key === "workbook url" || key === "sheet url") {
      workbookUrl = value || undefined;
    }
  }

  return {
    title,
    description: cleanInput,
    dueDate,
    assigneeNames,
    priority: priority ?? 3,
    targetListName,
    category,
    workbookUrl
  };
}

export function parseDueDate(value: string): number | undefined {
  if (!value) return undefined;

  const normalized = value.toLowerCase();
  const now = new Date();

  if (normalized === "today") {
    return endOfDay(now).getTime();
  }

  if (normalized === "tomorrow") {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return endOfDay(tomorrow).getTime();
  }

  if (/\bthis week\b/.test(normalized)) {
    return endOfWorkWeek(now).getTime();
  }

  if (/\b(?:next|coming)\s+week\b/.test(normalized)) {
    const nextWeek = endOfWorkWeek(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return nextWeek.getTime();
  }

  const relative = normalized.match(/\b(?:in|after)?\s*(\d{1,5})\s*(days?|d|weeks?|w)\s*(?:after|later|from now)?\b/);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const target = new Date(now);
    target.setDate(target.getDate() + amount * (unit.startsWith("w") ? 7 : 1));
    return endOfDay(target).getTime();
  }

  const cleaned = value.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const monthDay = parseMonthDayDate(cleaned, now);
  if (monthDay) return endOfDay(monthDay).getTime();

  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return endOfDay(parsed).getTime();
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function endOfWorkWeek(date: Date): Date {
  const copy = new Date(date);
  const day = copy.getDay();
  const fridayOffset = day <= 5 ? 5 - day : 12 - day;
  copy.setDate(copy.getDate() + fridayOffset);
  return endOfDay(copy);
}

function parseMonthDayDate(value: string, now: Date): Date | undefined {
  const match = value.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if (!match?.[1] || !match[2]) return undefined;
  const month = monthIndex(match[1]);
  if (month < 0) return undefined;
  const year = match[3] ? Number(match[3]) : now.getFullYear();
  const parsed = new Date(year, month, Number(match[2]));
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (!match[3] && parsed.getTime() < startOfDay(now).getTime()) parsed.setFullYear(parsed.getFullYear() + 1);
  return parsed;
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function monthIndex(value: string): number {
  const key = value.toLowerCase().slice(0, 3);
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key);
}

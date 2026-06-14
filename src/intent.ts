export type NaturalIntent =
  | {
      domain: "client_memory";
      action: "show" | "save" | "update";
    }
  | {
      domain: "task_location";
      action: "find_recent";
    }
  | {
      domain: "drive";
      action: "search" | "summarize" | "answer" | "append" | "update";
    }
  | {
      domain: "data";
      action: "fetch";
    }
  | {
      domain: "monitoring";
      action: "run" | "report";
    }
  | {
      domain: "settings";
      action: "show" | "update";
    }
  | {
      domain: "slack";
      action: "send_message";
    }
  | {
      domain: "task_creation";
      action: "create";
    }
  | {
      domain: "learning";
      action: "remember";
    }
  | {
      domain: "clickup";
      action: "workload";
      scope: "all_teams" | "team" | "assignee";
      target?: string;
    }
  | {
      domain: "clickup";
      action: "overdue";
      assignee?: string;
    }
  | {
      domain: "clickup";
      action: "search_tasks";
      query: string;
    }
  | {
      domain: "clickup";
      action: "task_activity";
      taskId: string;
    }
  | {
      domain: "unknown";
    };

export function classifyNaturalIntent(text: string): NaturalIntent {
  const normalized = text.replace(/\s+/g, " ").trim();

  const highLevel = classifyHighLevelIntent(normalized);
  if (highLevel) return highLevel;

  const taskId = extractClickUpTaskId(normalized);
  if (taskId && /\b(what changed|changed|updates?|activity|comments?|status)\b/i.test(normalized)) {
    return { domain: "clickup", action: "task_activity", taskId };
  }

  const overdue = normalized.match(/\b(?:what(?:'s| is)|show|list|find)?\s*overdue(?:\s+(?:for|assigned to)\s+([^?]+))?/i);
  if (overdue && /\b(clickup|tasks?|tickets?|overdue)\b/i.test(normalized)) {
    const assignee = overdue[1]?.replace(/\b(clickup|tasks?|tickets?)\b/gi, "").trim();
    return { domain: "clickup", action: "overdue", assignee: assignee || undefined };
  }

  if (isAllTeamWorkload(normalized)) {
    return { domain: "clickup", action: "workload", scope: "all_teams" };
  }

  const teamWorkload = normalized.match(/\b(?:show|what(?:'s| is)|list)?\s*(team\s+(?:ab|cd|[a-d]))\s+workload\b/i) ??
    normalized.match(/\bworkload\s+(?:for\s+)?(team\s+(?:ab|cd|[a-d]))\b/i) ??
    normalized.match(/\b(?:overall\s+)?(?:task|tasks|clickup|workload)\s+(?:overview|summary|status|workload)\s+(?:of|for)\s+(team\s+(?:ab|cd|[a-d])|ab|cd|[a-d])\b/i) ??
    normalized.match(/\b(team\s+(?:ab|cd|[a-d]))\s+(?:task|tasks|clickup|workload)\s+(?:overview|summary|status|workload)\b/i);
  if (teamWorkload?.[1]) {
    return { domain: "clickup", action: "workload", scope: "team", target: normalizeTeamTarget(teamWorkload[1]) };
  }

  const assigneeWorkload = normalized.match(/\b(?:show|what(?:'s| is)|list)?\s*(?:workload|tasks?)\s+(?:for|assigned to)\s+([^?]+)$/i);
  if (assigneeWorkload?.[1]) {
    const target = assigneeWorkload[1].replace(/\b(clickup|tasks?|tickets?)\b/gi, "").trim();
    return { domain: "clickup", action: "workload", scope: "assignee", target };
  }

  const search = normalized.match(/\b(?:find|search|show|list)\s+(?:clickup\s+)?tasks?\s+(?:about|for|matching|with)?\s+(.+)$/i);
  if (search?.[1]) {
    const query = cleanClickUpSearchQuery(search[1]);
    if (query) return { domain: "clickup", action: "search_tasks", query };
  }

  return { domain: "unknown" };
}

function classifyHighLevelIntent(text: string): NaturalIntent | undefined {
  if (/\b(create|make|add|draft)\b[\s\S]*\b(task|ticket|clickup)\b|^create task:/i.test(text)) {
    return { domain: "task_creation", action: "create" };
  }

  if (/\b(remember|learn|going forward|next time|for future)\b/i.test(text)) {
    return { domain: "learning", action: "remember" };
  }

  if (/\b(where|which|what)\b/i.test(text) &&
    /\b(created|added|wrote|saved)\b/i.test(text) &&
    /\b(task|workbook|sheet|clickup)\b/i.test(text)) {
    return { domain: "task_location", action: "find_recent" };
  }

  if (/\b(what do you know|what do you remember|client memory|client log|notes?|logs?)\b/i.test(text)) {
    if (/\b(add|save|remember|update|remove|delete)\b/i.test(text)) return { domain: "client_memory", action: "update" };
    return { domain: "client_memory", action: "show" };
  }

  if (/\b(google status|google access|google summary|settings|learned rules|client mappings|threshold|report channel|admin settings)\b/i.test(text)) {
    return /\b(set|map|update|remove|forget|delete)\b/i.test(text)
      ? { domain: "settings", action: "update" }
      : { domain: "settings", action: "show" };
  }

  if (/\b(daily monitoring|weekly report|monthly report|monitoring report|rerun daily monitoring)\b/i.test(text)) {
    return /\b(report|summary)\b/i.test(text)
      ? { domain: "monitoring", action: "report" }
      : { domain: "monitoring", action: "run" };
  }

  if (/\b(data|performance|analytics|gsc|ga4|ga|search console|comparison)\b/i.test(text) &&
    (/\b(show|get|pull|fetch|send|give|need|provide|compare)\b/i.test(text) ||
      /\b(daily|weekly|monthly|week|month|quarterly)\b/i.test(text))) {
    return { domain: "data", action: "fetch" };
  }

  if (isDriveIntent(text)) {
    if (/\b(append|add|update|replace|set)\b/i.test(text)) return { domain: "drive", action: /\b(append|add)\b/i.test(text) ? "append" : "update" };
    if (/\b(summarize|summary|recap)\b/i.test(text)) return { domain: "drive", action: "summarize" };
    if (/\b(answer|question|what|why|how|which)\b/i.test(text)) return { domain: "drive", action: "answer" };
    return { domain: "drive", action: "search" };
  }

  if (/\b(go to|send|post|message)\b[\s\S]*#?[a-z0-9_-]+[\s\S]*\b(message|say|post|send)\b/i.test(text)) {
    return { domain: "slack", action: "send_message" };
  }

  return undefined;
}

function isDriveIntent(text: string): boolean {
  if (/\b(drive|docs?|documents?|files?|folders?|knowledge|pdf|sheet|spreadsheet|workbook)\b/i.test(text)) return true;
  return /\b(fetch|get|find|search|show|send|pull)\b[\s\S]*\b(topical\s+map|eav|domain\s*wide|domainwide|attribute\s+mapping|content\s+brief|seo\s+brief)\b/i.test(text);
}

function isAllTeamWorkload(text: string): boolean {
  return /\ball\s+teams?\b[\s\S]*\bworkload\b/i.test(text) ||
    /\bworkload\b[\s\S]*\ball\s+teams?\b/i.test(text) ||
    /\bteam\s+a\b[\s\S]*\bteam\s+d\b[\s\S]*\bworkload\b/i.test(text) ||
    /\bworkload\b[\s\S]*\bteam\s+a\b[\s\S]*\bteam\s+d\b/i.test(text) ||
    /\bteam\s+a\s*,\s*(?:team\s+)?b\s*,\s*(?:team\s+)?c\s*,\s*(?:team\s+)?d\b[\s\S]*\bworkload\b/i.test(text);
}

function cleanClickUpSearchQuery(value: string): string {
  return value
    .replace(/\b(clickup|tasks?|tickets?|open|closed|done|complete)\b/gi, " ")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTeamTarget(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/^(team )?ab$/.test(compact)) return "Team AB";
  if (/^(team )?cd$/.test(compact)) return "Team CD";
  const letter = value.trim().match(/(?:team\s*)?([a-d])$/i)?.[1];
  if (letter) return ["a", "b"].includes(letter.toLowerCase()) ? "Team AB" : "Team CD";
  return value.trim();
}

function extractClickUpTaskId(text: string): string | undefined {
  const value = text.trim();
  return value.match(/app\.clickup\.com\/t\/(?:[a-z0-9-]+\/)?([a-zA-Z0-9]+)/i)?.[1] ??
    value.match(/\b(?:task|id)\s+([a-zA-Z0-9]{6,})\b/i)?.[1];
}

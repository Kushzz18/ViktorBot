import { config } from "./config.js";
import type { NaturalIntent } from "./intent.js";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const historyByConversation = new Map<string, ChatMessage[]>();

export type AlertThreadIntent = "explain" | "affected_urls" | "urgency" | "create_task" | "summarize" | "general";

type AiModelRole = "chat" | "classifier" | "report" | "reasoning";

export async function askAssistant(conversationId: string, userText: string, context?: string): Promise<string> {
  if (!hasOpenRouterKey()) {
    return [
      "I can talk with you once `OPENROUTER_API_KEY` is set.",
      "For now I can create ClickUp tasks with `create task:` and send simple channel messages."
    ].join("\n");
  }

  const history = historyByConversation.get(conversationId) ?? [];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are Viktor, a Slack automation assistant for an SEO operations team.",
        "Be concise, practical, and action-oriented.",
        "Use any provided source context before answering. If source context is insufficient, say what is missing.",
        "You can discuss plans, draft steps, summarize what you can do, and ask for missing details.",
        "Do not claim you already performed actions unless the user used a supported explicit command.",
        "Never create or propose ClickUp tasks unless the user explicitly asks to create a task.",
        "If a Slack mention is casual or unclear, answer with a friendly offer to help.",
        "If the user asks for data, settings, Drive, ClickUp, or Slack actions and source context says a tool is available, explain the next concrete action or ask only for the missing detail.",
        "Supported explicit commands right now:",
        "1. create task: <title> | Client: <client> | Due: <date> | Priority: <priority>",
        "2. go to channel #channel-name and message <message>",
        "3. weekly GSC data for <client> with comparison",
        "4. weekly GA data for <client> with comparison",
        "5. daily monitoring, weekly report, monthly report",
        "If the user asks for GSC/GA data without a period, ask whether they want daily, weekly, monthly, or a custom date range and whether they want comparison.",
        "If the user asks whether earlier data was week or month, explain that Viktor's default performance pull is weekly: latest available 7 days compared with the previous 7 days.",
        "If the user teaches a preference or correction, acknowledge it naturally and say you will remember it. Do not over-explain implementation limits unless the user asks.",
        "If the user asks for a feature that truly needs code changes, explain the limitation briefly and suggest the next practical step.",
        "If the user wants broader automation, explain what access or data is needed.",
        "When answering from context, briefly name the source such as client mapping, client memory, recent Slack context, Drive, GSC, GA4, or settings."
      ].join("\n")
    },
    ...(context ? [{ role: "user" as const, content: `Recent Slack context:\n${context}` }] : []),
    ...history,
    { role: "user", content: userText }
  ];

  const body: Record<string, unknown> = {
    messages,
    max_tokens: config.AI_MAX_REPLY_TOKENS,
    temperature: 0.3
  };

  const data = await sendOpenRouterChat(body, inferAssistantRole(userText, context));

  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    throw new Error("AI returned an empty response.");
  }

  const updatedHistory = [...history, { role: "user" as const, content: userText }, { role: "assistant" as const, content: answer }].slice(-12);
  historyByConversation.set(conversationId, updatedHistory);

  return answer;
}

export async function classifyAlertThreadIntent(userText: string, context: string): Promise<AlertThreadIntent> {
  const ruleBased = classifyAlertThreadIntentRules(userText);
  if (ruleBased) return ruleBased;
  if (!hasOpenRouterKey()) return "general";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Classify the user's intent in a Slack monitoring-alert thread.",
        "Return only one lowercase label from this exact list:",
        "explain, affected_urls, urgency, create_task, summarize, general.",
        "Use create_task only if the user is asking to make/open/create a task or ticket.",
        "Use affected_urls if they ask where, which page, from where, affected page, URL, or what page.",
        "Use urgency if they ask priority, urgent, important, serious, should we worry, impact.",
        "Use explain if they ask why, what happened, reason, cause, meaning, explain.",
        "Use summarize if they ask summary, recap, what are the issues, list issues.",
        "Use general if none of the above fits."
      ].join("\n")
    },
    {
      role: "user",
      content: [`User message: ${userText}`, `Thread context:\n${context.slice(-3000)}`].join("\n\n")
    }
  ];

  try {
    const data = await sendOpenRouterChat({
      messages,
      max_tokens: 8,
      temperature: 0
    }, "classifier");
    const label = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    return isAlertThreadIntent(label) ? label : "general";
  } catch {
    return "general";
  }
}

export async function classifyStructuredIntent(userText: string, context?: string): Promise<NaturalIntent | undefined> {
  if (!hasOpenRouterKey()) return undefined;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Classify a Slack message for Viktor, an SEO operations assistant.",
        "Return only compact JSON. No markdown. No explanation.",
        "Allowed shapes:",
        "{\"domain\":\"drive\",\"action\":\"search|summarize|answer|append|update\"}",
        "{\"domain\":\"clickup\",\"action\":\"workload\",\"scope\":\"all_teams|team|assignee\",\"target\":\"optional\"}",
        "{\"domain\":\"clickup\",\"action\":\"overdue\",\"assignee\":\"optional\"}",
        "{\"domain\":\"clickup\",\"action\":\"search_tasks\",\"query\":\"text\"}",
        "{\"domain\":\"clickup\",\"action\":\"task_activity\",\"taskId\":\"id\"}",
        "{\"domain\":\"data\",\"action\":\"fetch\"}",
        "{\"domain\":\"monitoring\",\"action\":\"run|report\"}",
        "{\"domain\":\"settings\",\"action\":\"show|update\"}",
        "{\"domain\":\"slack\",\"action\":\"send_message\"}",
        "{\"domain\":\"task_creation\",\"action\":\"create\"}",
        "{\"domain\":\"client_memory\",\"action\":\"show|save|update\"}",
        "{\"domain\":\"task_location\",\"action\":\"find_recent\"}",
        "{\"domain\":\"learning\",\"action\":\"remember\"}",
        "{\"domain\":\"unknown\"}",
        "Use drive for SEO asset/file requests such as topical map, EAV, domain-wide analysis, briefs, docs, sheets, PDFs, or Drive URLs even if the word Drive is omitted.",
        "Use data/monitoring only for GSC, GA4, analytics, anomaly alerts, or reports.",
        "Use clickup only for tasks, workload, overdue, task comments/activity/status, or task search.",
        "Do not classify vague casual chat as an action."
      ].join("\n")
    },
    {
      role: "user",
      content: [`Message: ${userText}`, context ? `Context:\n${context.slice(-1200)}` : ""].filter(Boolean).join("\n\n")
    }
  ];

  try {
    const data = await sendOpenRouterChat({
      messages,
      max_tokens: 120,
      temperature: 0
    }, "classifier");
    return parseNaturalIntentJson(data.choices?.[0]?.message?.content, userText);
  } catch {
    return undefined;
  }
}

function parseNaturalIntentJson(value?: string, userText = ""): NaturalIntent | undefined {
  if (!value) return undefined;
  const json = value.match(/\{[\s\S]*\}/)?.[0] ?? value;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return normalizeNaturalIntent(parsed, userText);
  } catch {
    return undefined;
  }
}

function normalizeNaturalIntent(parsed: Record<string, unknown>, userText = ""): NaturalIntent | undefined {
  const domain = String(parsed.domain ?? "");
  const action = String(parsed.action ?? "");
  if (domain === "unknown") return { domain: "unknown" };
  if (domain === "drive" && ["search", "summarize", "answer", "append", "update"].includes(action)) return { domain, action: action as "search" | "summarize" | "answer" | "append" | "update" };
  if (domain === "data" && action === "fetch") return { domain, action };
  if (domain === "monitoring" && ["run", "report"].includes(action)) return { domain, action: action as "run" | "report" };
  if (domain === "settings" && ["show", "update"].includes(action)) return { domain, action: action as "show" | "update" };
  if (domain === "slack" && action === "send_message") return { domain, action };
  if (domain === "task_creation" && action === "create") return { domain, action };
  if (domain === "learning" && action === "remember") return { domain, action };
  if (domain === "task_location" && action === "find_recent") return { domain, action };
  if (domain === "client_memory" && ["show", "save", "update"].includes(action)) return { domain, action: action as "show" | "save" | "update" };
  if (domain === "clickup" && action === "workload") {
    const scope = ["all_teams", "team", "assignee"].includes(String(parsed.scope)) ? String(parsed.scope) as "all_teams" | "team" | "assignee" : "assignee";
    const target = typeof parsed.target === "string" && parsed.target.trim()
      ? parsed.target.trim()
      : inferClassifierTarget(scope, userText);
    return { domain, action, scope, target: scope === "team" ? normalizeTeamTarget(target) : target };
  }
  if (domain === "clickup" && action === "overdue") {
    const assignee = typeof parsed.assignee === "string" ? parsed.assignee.trim() : undefined;
    return { domain, action, assignee };
  }
  if (domain === "clickup" && action === "search_tasks") {
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    return query ? { domain, action, query } : undefined;
  }
  if (domain === "clickup" && action === "task_activity") {
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId.trim() : "";
    return taskId ? { domain, action, taskId } : undefined;
  }
  return undefined;
}

function inferClassifierTarget(scope: "all_teams" | "team" | "assignee", userText: string): string | undefined {
  if (scope === "all_teams") return undefined;
  if (scope === "team") return userText.match(/\bteam\s+(?:ab|cd|[a-d])\b/i)?.[0] ?? userText.match(/\bof\s+(ab|cd|[a-d])\b/i)?.[1];
  return userText.match(/\b(?:for|assigned to|late for|overdue for)\s+([a-z][a-z .'-]{1,40})/i)?.[1]?.trim();
}

function normalizeTeamTarget(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/^(team )?ab$/.test(compact)) return "Team AB";
  if (/^(team )?cd$/.test(compact)) return "Team CD";
  const letter = value.trim().match(/(?:team\s*)?([a-d])$/i)?.[1];
  if (letter) return ["a", "b"].includes(letter.toLowerCase()) ? "Team AB" : "Team CD";
  return value.trim();
}

function classifyAlertThreadIntentRules(text: string): AlertThreadIntent | undefined {
  if (/\b(create|make|open|add)\b.*\b(task|ticket|clickup)\b|\btask\s+(this|it)\b/i.test(text)) return "create_task";
  if (/\b(affected\s+urls?|urls?|links?|from where|which page|what page|where exactly|which url)\b/i.test(text)) return "affected_urls";
  if (/\b(urgent|priority|serious|important|worry|impact|critical)\b/i.test(text)) return "urgency";
  if (/\b(summary|summarize|recap|list issues|what are the issues)\b/i.test(text)) return "summarize";
  if (/\b(why|explain|what happened|reason|cause|meaning|what does this mean)\b/i.test(text)) return "explain";
  return undefined;
}

function isAlertThreadIntent(value: string | undefined): value is AlertThreadIntent {
  return value === "explain" ||
    value === "affected_urls" ||
    value === "urgency" ||
    value === "create_task" ||
    value === "summarize" ||
    value === "general";
}

export async function composeSlackMessage(input: {
  conversationId: string;
  channelName: string;
  instruction: string;
  exact: boolean;
  availableUsers: Array<{ id: string; name: string }>;
}): Promise<string> {
  if (input.exact || !hasOpenRouterKey()) {
    return input.instruction;
  }

  const users = input.availableUsers
    .slice(0, 80)
    .map((user) => `${user.name} => <@${user.id}>`)
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You write Slack messages for an operations assistant named Viktor.",
        "Return only the final Slack message text. No explanation.",
        "Make the message natural, concise, and useful.",
        "Do not invent facts, deadlines, names, or promises.",
        "Use Slack mention syntax only when the user instruction clearly identifies a person from the available users list.",
        "Do not tag people just to be decorative.",
        "If the instruction is a welcome, write a warm welcome message.",
        "If the instruction is too vague, keep the final message simple rather than asking a question."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Target channel: #${input.channelName}`,
        `User instruction: ${input.instruction}`,
        users ? `Available users:\n${users}` : "Available users: none"
      ].join("\n\n")
    }
  ];

  try {
    const data = await sendOpenRouterChat({
      messages,
      max_tokens: Math.min(config.AI_MAX_REPLY_TOKENS, 220),
      temperature: 0.5
    }, "chat");
    return data.choices?.[0]?.message?.content?.trim() || input.instruction;
  } catch {
    return input.instruction;
  }
}

function modelForRole(role: AiModelRole): string {
  if (role === "classifier") return config.AI_CLASSIFIER_MODEL || config.OPENROUTER_MODEL || "glm-5.1";
  if (role === "report") return config.AI_REPORT_MODEL || config.OPENROUTER_MODEL || "claude-sonnet-4-5";
  if (role === "reasoning") return config.AI_REASONING_MODEL || config.AI_REPORT_MODEL || config.OPENROUTER_MODEL || "claude-sonnet-4-5";
  return config.OPENROUTER_MODEL || "claude-sonnet-4-5";
}

function inferAssistantRole(userText: string, context?: string): AiModelRole {
  const combined = `${userText}\n${context ?? ""}`;
  if (/\b(why|explain|reason|cause|urgent|priority|affected|schema|redirect|canonical|noindex|technical|anomaly|issue)\b/i.test(combined)) {
    return "reasoning";
  }
  if (/\b(report|summary|summarize|monthly|weekly|performance|analytics|gsc|ga4|search console|traffic|revenue|clicks|impressions)\b/i.test(combined)) {
    return "report";
  }
  return "chat";
}

async function sendOpenRouterChat(
  body: Record<string, unknown>,
  role: AiModelRole
): Promise<{ choices?: Array<{ message?: { content?: string } }> }> {
  const models = fallbackModelsForRole(role);
  const keys = openRouterKeys();
  const errors: string[] = [];

  for (const model of models) {
    for (const key of keys) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://local.viktor",
          "X-Title": "Viktor Slack Bot"
        },
        body: JSON.stringify({ ...body, model })
      });

      if (response.ok) {
        return (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      }

      const text = await response.text();
      errors.push(`${model}: ${response.status}`);
      if (!isRetryableAiStatus(response.status, text)) continue;
    }
  }

  throw new Error(`AI is temporarily busy after trying ${errors.join(", ")}. Please try again shortly.`);
}

function fallbackModelsForRole(role: AiModelRole): string[] {
  return unique([
    modelForRole(role),
    role !== "reasoning" ? config.AI_REASONING_MODEL : undefined,
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "close-work-4-8",
    "close-work-4-7",
    "close-work-4-6",
    "glm-5.1",
    role !== "classifier" ? config.AI_CLASSIFIER_MODEL : undefined,
    role !== "chat" ? config.OPENROUTER_MODEL : undefined,
    role !== "report" ? config.AI_REPORT_MODEL : undefined,
    role !== "reasoning" ? config.AI_REASONING_MODEL : undefined,
    "openai/gpt-oss-20b:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "openai/gpt-oss-120b:free",
    "qwen/qwen3-coder:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "z-ai/glm-4.5-air:free"
  ]);
}

function hasOpenRouterKey(): boolean {
  return openRouterKeys().length > 0;
}

function openRouterKeys(): string[] {
  return unique([...(config.OPENROUTER_KEYS ?? []), config.OPENROUTER_API_KEY]);
}

function isRetryableAiStatus(status: number, body: string): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 || /rate.?limit|temporarily|timeout|overloaded/i.test(body);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

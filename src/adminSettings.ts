import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

export type AdminSettings = {
  reportChannel?: string;
  followupMinAgeMinutes?: number;
  accessMode?: "open" | "restricted";
  allowedUserIds?: string[];
  clientChannels: Record<string, string>;
  teamMembers: Record<string, string[]>;
  thresholds: Record<string, {
    pct?: number;
    absolute?: number;
  }>;
  preferences: string[];
  learnedRules: LearnedRule[];
  learningObservations: Record<string, number>;
  pendingLearning: Record<string, LearningSuggestion>;
  dismissedLearning: Record<string, string>;
};

export type LearnedRule = {
  id: string;
  type: "data-default" | "client-channel" | "preference";
  key: string;
  value: string;
  text: string;
  createdAt: string;
};

export type LearningSuggestion = {
  id: string;
  type: LearnedRule["type"];
  key: string;
  value: string;
  text: string;
};

const settingsPath = join(config.DATA_DIR, "admin-settings.json");

let settings: AdminSettings = {
  clientChannels: {},
  teamMembers: {},
  thresholds: {},
  preferences: [],
  learnedRules: [],
  learningObservations: {},
  pendingLearning: {},
  dismissedLearning: {}
};

export async function loadAdminSettings() {
  await mkdir(config.DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(settingsPath, "utf8");
    settings = {
      ...settings,
      ...(JSON.parse(raw) as Partial<AdminSettings>)
    };
    settings.clientChannels ??= {};
    settings.teamMembers ??= {};
    settings.accessMode ??= "open";
    settings.allowedUserIds ??= [];
    settings.thresholds ??= {};
    settings.preferences ??= [];
    settings.learnedRules ??= [];
    settings.learningObservations ??= {};
    settings.pendingLearning ??= {};
    settings.dismissedLearning ??= {};
  } catch {
    await saveAdminSettings();
  }
}

export function getAdminSettings(): AdminSettings {
  return settings;
}

export function getReportChannel(): string | undefined {
  return settings.reportChannel || config.SLACK_REPORT_CHANNEL;
}

export function getFollowupMinAgeMinutes(): number {
  return settings.followupMinAgeMinutes ?? config.FOLLOWUP_MIN_AGE_MINUTES;
}

export function canUseBot(userId?: string): boolean {
  if ((settings.accessMode ?? "open") !== "restricted") return true;
  if (!userId) return false;
  return getAllowedUserIds().includes(userId);
}

export function getAccessSettings(): { mode: "open" | "restricted"; allowedUserIds: string[] } {
  return {
    mode: settings.accessMode ?? "open",
    allowedUserIds: getAllowedUserIds()
  };
}

export async function setAccessMode(mode: "open" | "restricted") {
  settings.accessMode = mode;
  settings.allowedUserIds ??= [];
  await saveAdminSettings();
}

export async function addAllowedUser(userId: string) {
  const cleaned = cleanUserId(userId);
  if (!cleaned) return;
  const existing = new Set(settings.allowedUserIds ?? []);
  existing.add(cleaned);
  settings.allowedUserIds = [...existing];
  await saveAdminSettings();
}

export async function removeAllowedUser(userId: string) {
  const cleaned = cleanUserId(userId);
  settings.allowedUserIds = (settings.allowedUserIds ?? []).filter((id) => id !== cleaned);
  await saveAdminSettings();
}

export function getThreshold(key: string, fallbackPct: number, fallbackAbsolute: number) {
  const override = settings.thresholds[normalizeKey(key)];
  return {
    pct: override?.pct ?? fallbackPct,
    absolute: override?.absolute ?? fallbackAbsolute
  };
}

export function getClientChannel(clientName: string): string | undefined {
  return settings.clientChannels[normalizeKey(clientName)];
}

export function getTeamMembers(team: string, fallback: string[] = []): string[] {
  const key = normalizeTeamKey(team);
  const members = settings.teamMembers[key];
  return cleanStringArray(members?.length ? members : fallback);
}

export async function setReportChannel(channel: string) {
  settings.reportChannel = cleanChannel(channel);
  await saveAdminSettings();
}

export async function setFollowupMinAgeMinutes(minutes: number) {
  settings.followupMinAgeMinutes = minutes;
  await saveAdminSettings();
}

export async function setClientChannel(clientName: string, channel: string) {
  settings.clientChannels[normalizeKey(clientName)] = cleanChannel(channel);
  await saveAdminSettings();
}

export async function setTeamMembers(team: string, members: string[]) {
  const key = normalizeTeamKey(team);
  if (!key) throw new Error("Team is required.");
  settings.teamMembers[key] = cleanStringArray(members);
  await saveAdminSettings();
}

export async function addTeamMember(team: string, member: string) {
  const key = normalizeTeamKey(team);
  const cleaned = cleanStringArray([member]);
  if (!key || !cleaned.length) return;
  const current = settings.teamMembers[key] ?? [];
  settings.teamMembers[key] = cleanStringArray([...current, ...cleaned]);
  await saveAdminSettings();
}

export async function removeTeamMember(team: string, member: string): Promise<boolean> {
  const key = normalizeTeamKey(team);
  const current = settings.teamMembers[key] ?? [];
  const next = current.filter((item) => normalizeKey(item) !== normalizeKey(member));
  settings.teamMembers[key] = next;
  await saveAdminSettings();
  return next.length !== current.length;
}

export async function setThreshold(key: string, pct?: number, absolute?: number) {
  const normalized = normalizeKey(key);
  settings.thresholds[normalized] = {
    ...settings.thresholds[normalized],
    ...(pct !== undefined ? { pct } : {}),
    ...(absolute !== undefined ? { absolute } : {})
  };
  await saveAdminSettings();
}

export async function removeThreshold(key: string): Promise<boolean> {
  const normalized = normalizeKey(key);
  if (!settings.thresholds[normalized]) return false;
  delete settings.thresholds[normalized];
  await saveAdminSettings();
  return true;
}

export async function removeClientChannel(clientName: string): Promise<boolean> {
  const normalized = normalizeKey(clientName);
  if (!settings.clientChannels[normalized]) return false;
  delete settings.clientChannels[normalized];
  await saveAdminSettings();
  return true;
}

export async function rememberPreference(preference: string) {
  const cleaned = preference.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  settings.preferences = [cleaned, ...settings.preferences.filter((item) => item.toLowerCase() !== cleaned.toLowerCase())].slice(0, 100);
  await saveAdminSettings();
}

export async function createLearningSuggestion(input: {
  type?: LearnedRule["type"];
  key?: string;
  value?: string;
  text: string;
}): Promise<LearningSuggestion> {
  const cleaned = input.text.replace(/\s+/g, " ").trim() || "Remember this preference for future interactions.";
  const key = input.key ?? `preference:${normalizeKey(cleaned).slice(0, 70) || "manual"}`;
  const value = input.value ?? cleaned;
  const id = stableLearningId(key, value);
  const suggestion: LearningSuggestion = {
    id,
    type: input.type ?? "preference",
    key,
    value,
    text: cleaned
  };

  settings.pendingLearning[id] = suggestion;
  await saveAdminSettings();
  return suggestion;
}

export async function removePreference(query: string): Promise<string | undefined> {
  const normalized = normalizeKey(query);
  const index = settings.preferences.findIndex((item) => normalizeKey(item).includes(normalized));
  if (index < 0) return undefined;
  const [removed] = settings.preferences.splice(index, 1);
  await saveAdminSettings();
  return removed;
}

export function getDataDefault(sourceKey: string): { period?: "daily" | "weekly" | "monthly" | "quarterly" | `${number}d`; compare?: boolean } {
  const rule = settings.learnedRules.find((item) => item.type === "data-default" && item.key === dataDefaultKey(sourceKey));
  if (!rule) return {};

  const [period, compare] = rule.value.split(":");
  return {
    period: isDataPeriod(period) ? period : undefined,
    compare: compare === "compare" ? true : compare === "no-compare" ? false : undefined
  };
}

export async function observeDataDefault(input: {
  sourceKey: string;
  period: "daily" | "weekly" | "monthly" | "quarterly" | `${number}d`;
  compare: boolean;
}): Promise<LearningSuggestion | undefined> {
  const key = dataDefaultKey(input.sourceKey);
  const value = `${input.period}:${input.compare ? "compare" : "no-compare"}`;
  const id = stableLearningId(key, value);

  if (settings.dismissedLearning[id]) return undefined;
  if (settings.learnedRules.some((rule) => rule.id === id || (rule.key === key && rule.value === value))) return undefined;

  const observationKey = `${key}:${value}`;
  settings.learningObservations[observationKey] = (settings.learningObservations[observationKey] ?? 0) + 1;

  const suggestion: LearningSuggestion = {
    id,
    type: "data-default",
    key,
    value,
    text: `Use ${input.period} ${input.compare ? "with comparison" : "without comparison"} as the default for ${input.sourceKey.toUpperCase()} data requests.`
  };

  if (settings.learningObservations[observationKey] >= 2) {
    settings.pendingLearning[id] = suggestion;
    await saveAdminSettings();
    return suggestion;
  }

  await saveAdminSettings();
  return undefined;
}

function isDataPeriod(value: string): value is "daily" | "weekly" | "monthly" | "quarterly" | `${number}d` {
  return value === "daily" || value === "weekly" || value === "monthly" || value === "quarterly" || /^\d+d$/.test(value);
}

export async function observeClientChannel(input: {
  clientName: string;
  channel: string;
}): Promise<LearningSuggestion | undefined> {
  const key = `client-channel:${normalizeKey(input.clientName)}`;
  const value = cleanChannel(input.channel);
  const id = stableLearningId(key, value);

  if (settings.dismissedLearning[id]) return undefined;
  if (settings.clientChannels[normalizeKey(input.clientName)] === value) return undefined;
  if (settings.learnedRules.some((rule) => rule.id === id || (rule.key === key && rule.value === value))) return undefined;

  const observationKey = `${key}:${value}`;
  settings.learningObservations[observationKey] = (settings.learningObservations[observationKey] ?? 0) + 1;

  const suggestion: LearningSuggestion = {
    id,
    type: "client-channel",
    key,
    value,
    text: `Use #${value} as the default channel for ${input.clientName}.`
  };

  if (settings.learningObservations[observationKey] >= 2) {
    settings.pendingLearning[id] = suggestion;
    await saveAdminSettings();
    return suggestion;
  }

  await saveAdminSettings();
  return undefined;
}

export async function approveLearningSuggestion(id: string): Promise<LearnedRule | undefined> {
  const suggestion = settings.pendingLearning[id];
  if (!suggestion) return undefined;

  const rule: LearnedRule = {
    ...suggestion,
    createdAt: new Date().toISOString()
  };

  if (suggestion.type === "client-channel") {
    const client = suggestion.key.replace(/^client-channel:/, "");
    settings.clientChannels[client] = suggestion.value;
  }

  if (suggestion.type === "preference") {
    settings.preferences = [
      suggestion.value,
      ...settings.preferences.filter((item) => item.toLowerCase() !== suggestion.value.toLowerCase())
    ].slice(0, 100);
  }

  settings.learnedRules = [
    rule,
    ...settings.learnedRules.filter((item) => item.id !== rule.id && item.key !== rule.key)
  ].slice(0, 100);
  delete settings.pendingLearning[id];
  await saveAdminSettings();
  return rule;
}

export async function rejectLearningSuggestion(id: string): Promise<LearningSuggestion | undefined> {
  const suggestion = settings.pendingLearning[id];
  if (!suggestion) return undefined;

  settings.dismissedLearning[id] = new Date().toISOString();
  delete settings.pendingLearning[id];
  await saveAdminSettings();
  return suggestion;
}

export async function removeLearnedRule(query: string): Promise<LearnedRule | undefined> {
  const normalized = normalizeKey(query);
  const index = settings.learnedRules.findIndex((rule) =>
    normalizeKey(rule.id) === normalized ||
    normalizeKey(rule.key).includes(normalized) ||
    normalizeKey(rule.text).includes(normalized)
  );
  if (index < 0) return undefined;

  const [removed] = settings.learnedRules.splice(index, 1);
  await saveAdminSettings();
  return removed;
}

export function formatLearnedRules(): string {
  return [
    "*Learned rules*",
    ...(settings.learnedRules.length
      ? settings.learnedRules.map((rule, index) => `${index + 1}. ${rule.text} (${rule.id})`)
      : ["No approved learned rules yet."])
  ].join("\n");
}

export function formatAdminSettings(): string {
  const thresholdLines = Object.entries(settings.thresholds).map(([key, value]) => {
    const parts = [
      value.pct !== undefined ? `${value.pct}%` : "",
      value.absolute !== undefined ? `absolute ${value.absolute}` : ""
    ].filter(Boolean).join(", ");
    return `- ${key}: ${parts}`;
  });

  const channelLines = Object.entries(settings.clientChannels).map(([client, channel]) => `- ${client}: #${channel}`);

  return [
    "*Viktor admin settings*",
    `Report fallback channel: ${settings.reportChannel ? `#${settings.reportChannel}` : config.SLACK_REPORT_CHANNEL || "not set"}`,
    `Follow-up delay: ${getFollowupMinAgeMinutes()} minutes`,
    `Access: ${settings.accessMode ?? "open"}${getAllowedUserIds().length ? ` (${getAllowedUserIds().map((id) => `<@${id}>`).join(", ")})` : ""}`,
    "",
    "*Client channels*",
    ...(channelLines.length ? channelLines : ["- none set from Slack yet"]),
    "",
    "*Thresholds*",
    ...(thresholdLines.length ? thresholdLines : ["- defaults are active"]),
    "",
    "*Remembered preferences*",
    ...(settings.preferences.length ? settings.preferences.slice(0, 10).map((item) => `- ${item}`) : ["- none yet"]),
    "",
    "*Approved learned rules*",
    ...(settings.learnedRules.length ? settings.learnedRules.slice(0, 10).map((item) => `- ${item.text}`) : ["- none yet"]),
    "",
    "*Pending learning suggestions*",
    ...(Object.values(settings.pendingLearning).length ? Object.values(settings.pendingLearning).slice(0, 10).map((item) => `- ${item.text}`) : ["- none"])
  ].join("\n");
}

function cleanChannel(value: string): string {
  return value.trim().replace(/^#/, "");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanStringArray(values: unknown[]): string[] {
  const cleaned = values.flatMap((value) =>
    typeof value === "string"
      ? value.split("+").map((item) => cleanText(item)).filter(Boolean)
      : []
  );
  const seen = new Set<string>();
  return cleaned.filter((item) => {
    const key = normalizeKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanUserId(value: string): string {
  return value.trim().replace(/^<@/, "").replace(/>$/, "");
}

function getAllowedUserIds(): string[] {
  return [...new Set([...(settings.allowedUserIds ?? []), ...config.BOT_ALLOWED_USERS])].filter(Boolean);
}

function dataDefaultKey(sourceKey: string): string {
  return `data-default:${normalizeKey(sourceKey)}`;
}

function stableLearningId(key: string, value: string): string {
  return `${key}:${value}`.replace(/[^a-z0-9:-]+/g, "-");
}

export function normalizeAdminKey(value: string): string {
  return normalizeKey(value);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTeamKey(value: string): string {
  const match = normalizeKey(value).match(/^team ([a-d])$/);
  return match ? `Team ${match[1].toUpperCase()}` : value.trim();
}

async function saveAdminSettings() {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
}

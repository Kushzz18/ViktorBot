import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasViktorMention } from "./botIdentity.js";
import { config } from "./config.js";
import { getFollowupMinAgeMinutes } from "./adminSettings.js";

export type StoredSlackMessage = {
  channel: string;
  channelType?: string;
  user?: string;
  botId?: string;
  text: string;
  ts: string;
  threadTs?: string;
  files?: Array<{
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    url_private?: string;
    url_private_download?: string;
  }>;
  storedAt: string;
};

export type FollowUpCandidate = {
  channel: string;
  user?: string;
  text: string;
  ts: string;
  threadTs?: string;
  ageMinutes: number;
  reason: string;
  client?: string;
  ownerSlackUserIds?: string[];
};

export type ThreadReminder = {
  id: string;
  channel: string;
  threadTs: string;
  target?: "thread" | "channel";
  requester?: string;
  message: string;
  remindAt: string;
  createdAt: string;
  deliveredAt?: string;
  canceledAt?: string;
};

type MemoryState = {
  messages: StoredSlackMessage[];
  alertedFollowUps: Record<string, string>;
  suppressedFollowUpThreads: Record<string, string>;
  threadReminders: ThreadReminder[];
};

const maxMessages = 20000;
const maxFollowUpCandidateAgeMinutes = 36 * 60;
const repeatFollowUpDelayMinutes = 120;
const statePath = join(config.DATA_DIR, "memory.json");

let state: MemoryState = {
  messages: [],
  alertedFollowUps: {},
  suppressedFollowUpThreads: {},
  threadReminders: []
};

export async function loadMemory() {
  await mkdir(config.DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(statePath, "utf8");
    state = JSON.parse(raw) as MemoryState;
    state.messages ??= [];
    state.alertedFollowUps ??= {};
    state.suppressedFollowUpThreads ??= {};
    state.threadReminders ??= [];
  } catch {
    await persistMemory();
  }
}

export async function rememberSlackMessage(message: StoredSlackMessage) {
  if (!message.text.trim() && !message.files?.length) return;

  const key = messageKey(message.channel, message.ts);
  if (state.messages.some((stored) => messageKey(stored.channel, stored.ts) === key)) {
    return;
  }

  state.messages.push(message);
  if (state.messages.length > maxMessages) {
    state.messages = state.messages.slice(-maxMessages);
  }

  await persistMemory();
}

export function memoryStats() {
  const channels = new Set(state.messages.map((message) => message.channel));

  return {
    messages: state.messages.length,
    channels: channels.size,
    alertedFollowUps: Object.keys(state.alertedFollowUps).length
  };
}

export function getMostRecentDmUser(): string | undefined {
  return [...state.messages]
    .reverse()
    .find((message) => message.channelType === "im" && message.user && !message.botId)
    ?.user;
}

export function recentMemoryContext(options?: { channel?: string; limit?: number }): string {
  const limit = options?.limit ?? 12;
  const messages = [...state.messages]
    .filter((message) => !options?.channel || message.channel === options.channel)
    .slice(-limit)
    .map((message) => {
      const speaker = message.botId ? "Viktor" : (message.user ? `<@${message.user}>` : "Someone");
      return `${speaker}: ${message.text}`;
    });

  return messages.join("\n");
}

export function getStoredSlackMessage(channel: string, ts: string): StoredSlackMessage | undefined {
  return state.messages.find((message) => message.channel === channel && message.ts === ts);
}

export async function markFollowUpAlerted(candidate: FollowUpCandidate) {
  state.alertedFollowUps[followUpKey(candidate)] = new Date().toISOString();
  await persistMemory();
}

export async function scheduleThreadReminder(reminder: Omit<ThreadReminder, "id" | "createdAt">): Promise<ThreadReminder> {
  const createdAt = new Date().toISOString();
  const stored: ThreadReminder = {
    ...reminder,
    id: `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt
  };

  state.threadReminders.push(stored);
  state.suppressedFollowUpThreads[threadKey(reminder.channel, reminder.threadTs)] = createdAt;
  await persistMemory();
  return stored;
}

export async function cancelThreadFollowUps(channel: string, threadTs: string): Promise<number> {
  const now = new Date().toISOString();
  let canceledCount = 0;
  for (const reminder of state.threadReminders) {
    if (reminder.channel !== channel || reminder.threadTs !== threadTs || reminder.deliveredAt || reminder.canceledAt) continue;
    reminder.canceledAt = now;
    canceledCount += 1;
  }
  state.suppressedFollowUpThreads[threadKey(channel, threadTs)] = now;
  await persistMemory();
  return canceledCount;
}

export function findDueThreadReminders(now = new Date(), limit = 20): ThreadReminder[] {
  const nowTime = now.getTime();
  return state.threadReminders
    .filter((reminder) => !reminder.deliveredAt && !reminder.canceledAt && Date.parse(reminder.remindAt) <= nowTime)
    .sort((a, b) => Date.parse(a.remindAt) - Date.parse(b.remindAt))
    .slice(0, limit);
}

export function hasSimilarThreadReminder(input: {
  channel: string;
  threadTs: string;
  remindAt: string;
  message: string;
  requester?: string;
}): boolean {
  const targetTime = Date.parse(input.remindAt);
  return state.threadReminders.some((reminder) => {
    if (reminder.channel !== input.channel || reminder.threadTs !== input.threadTs) return false;
    if (reminder.canceledAt) return false;
    if ((reminder.requester ?? "") !== (input.requester ?? "")) return false;
    if (normalizeReminderText(reminder.message) !== normalizeReminderText(input.message)) return false;
    const reminderTime = Date.parse(reminder.remindAt);
    return Number.isFinite(targetTime) && Number.isFinite(reminderTime) && Math.abs(reminderTime - targetTime) < 60 * 1000;
  });
}

export async function markThreadReminderDelivered(id: string) {
  const reminder = state.threadReminders.find((item) => item.id === id);
  if (!reminder) return;
  const now = new Date().toISOString();
  reminder.deliveredAt = now;
  state.suppressedFollowUpThreads[threadKey(reminder.channel, reminder.threadTs)] = now;
  await persistMemory();
}

export function findFollowUpCandidates(options?: {
  minAgeMinutes?: number;
  includeAlreadyAlerted?: boolean;
  limit?: number;
}): FollowUpCandidate[] {
  const minAgeMinutes = options?.minAgeMinutes ?? getFollowupMinAgeMinutes();
  const now = Date.now();
  const limit = options?.limit ?? 10;
  const candidates: FollowUpCandidate[] = [];

  const sorted = [...state.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
  const seenThreads = new Set<string>();

  for (const message of sorted) {
    if (message.channelType === "im") continue;

    const parent = message.threadTs ?? message.ts;
    const key = threadKey(message.channel, parent);
    if (seenThreads.has(key)) continue;
    seenThreads.add(key);
    if (state.suppressedFollowUpThreads[key]) continue;

    const threadMessages = sorted.filter((candidate) =>
      candidate.channel === message.channel && (candidate.threadTs ?? candidate.ts) === parent
    );
    const parentMessage = threadMessages.find((candidate) => candidate.ts === parent);
    if (!isFollowUpThreadEligible(threadMessages, parentMessage)) continue;

    const followUpMessage = latestOpenFollowUpMessage(threadMessages, parentMessage);
    if (!followUpMessage?.user) continue;

    const reason = followUpReason(followUpMessage.text, parentMessage?.text) ?? "thread without resolution";
    const ageMinutes = Math.floor((now - slackTsToMs(followUpMessage.ts)) / 60000);
    if (ageMinutes < minAgeMinutes) continue;
    if (ageMinutes > maxFollowUpCandidateAgeMinutes) continue;

    const candidate: FollowUpCandidate = {
      channel: followUpMessage.channel,
      user: followUpMessage.user,
      text: followUpMessage.text,
      ts: followUpMessage.ts,
      threadTs: followUpMessage.threadTs,
      ageMinutes,
      reason
    };

    const lastAlertedAt = state.alertedFollowUps[followUpKey(candidate)];
    if (!options?.includeAlreadyAlerted && lastAlertedAt) {
      const elapsedSinceAlert = now - Date.parse(lastAlertedAt);
      if (Number.isFinite(elapsedSinceAlert) && elapsedSinceAlert < repeatFollowUpDelayMinutes * 60000) {
        continue;
      }
    }

    candidates.push(candidate);
  }

  return candidates.slice(-limit).reverse();
}

function isFollowUpThreadEligible(threadMessages: StoredSlackMessage[], parent?: StoredSlackMessage): boolean {
  if (parent?.text && hasViktorMention(parent.text)) return true;
  return threadMessages.some((message) => isFollowUpEligibleMention(message, parent));
}

function latestOpenFollowUpMessage(threadMessages: StoredSlackMessage[], parent?: StoredSlackMessage): StoredSlackMessage | undefined {
  let latest: StoredSlackMessage | undefined;
  let closed = false;

  for (const message of threadMessages) {
    if (!message.text.trim()) continue;
    if (message.botId) {
      if (isBotResolution(message.text)) {
        latest = undefined;
        closed = true;
      }
      continue;
    }
    if (!message.user) continue;
    if (isHumanResolution(message.text)) {
      latest = undefined;
      closed = true;
      continue;
    }
    if (closed && !isExplicitFollowUpReopen(message)) continue;
    if (isThreadFollowUpNoise(message.text, parent?.text)) continue;
    closed = false;
    latest = message;
  }

  return latest;
}

function isExplicitFollowUpReopen(message: StoredSlackMessage): boolean {
  return hasViktorMention(message.text) &&
    (isClientFollowUpHandoff(message.text) || /\b(remind|follow up|follow-up|check back|keep an eye|ping|nudge|update)\b/i.test(message.text));
}

function isThreadFollowUpNoise(text: string, parentText = ""): boolean {
  const normalized = text.toLowerCase();
  const normalizedWithoutMentions = stripMentions(normalized);
  const parentNormalized = parentText.toLowerCase();
  const parentTagged = Boolean(parentText && hasViktorMention(parentText));
  return isLightweightAcknowledgement(normalizedWithoutMentions) ||
    isMentionOnlyMessage(normalized) ||
    (!parentTagged && !isClientFollowUpHandoff(text) && (
    isViktorControlConversation(normalized) ||
    isViktorControlConversation(parentNormalized)
    ));
}

function stripMentions(normalized: string): string {
  return normalized
    .replace(/<@[a-z0-9]+>/gi, " ")
    .replace(/<!channel>|<!here>|<#[a-z0-9|_-]+>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMentionOnlyMessage(normalized: string): boolean {
  const compact = normalized
    .replace(/<@[a-z0-9]+>/gi, " ")
    .replace(/<!channel>|<!here>|<#[a-z0-9|_-]+>/gi, " ")
    .replace(/\bcc\b\s*:*/gi, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !compact;
}

function followUpReason(text: string, parentText = ""): string | undefined {
  const normalized = text.toLowerCase();
  const parentNormalized = parentText.toLowerCase();

  if (isLightweightAcknowledgement(normalized)) return undefined;
  if (/\b(you need to understand|you should understand|that's why|going forward|from now on|remember that)\b/i.test(normalized)) {
    return undefined;
  }
  if (isViktorControlConversation(normalized) || isViktorControlConversation(parentNormalized)) return undefined;

  if (text.includes("?")) return "question without a later reply";
  if (/\b(can you|could you|please|pls|need|needs|waiting|follow up|remind|reminder|any update|update on|status|let me know|let us know|keep me posted)\b/i.test(normalized)) {
    return "request-looking message without a later reply";
  }
  if (/\b(client|customer)\b/i.test(normalized) && /\b(asks?|asked|wants?|wanted|needs?|requested|requesting|requires?|todo|to do|action|reply|respond|approve|approval|fix|check|review|send|share|provide|update|confirm)\b/i.test(normalized)) {
    return "client request without a later reply";
  }
  if (/\b(approval|urgent|blocked|blocker|issue|problem)\b/i.test(normalized)) {
    return "client or blocker signal without a later reply";
  }

  return undefined;
}

function isFollowUpEligibleMention(message: StoredSlackMessage, parent?: StoredSlackMessage): boolean {
  const isParent = !message.threadTs || message.threadTs === message.ts;
  const parentTagged = Boolean(parent?.text && hasViktorMention(parent.text));
  const messageTagged = hasViktorMention(message.text);

  if (isParent) return messageTagged;
  if (parentTagged) return true;
  return messageTagged && /\b(remind|follow up|follow-up|check back|keep an eye|ping|nudge|update)\b/i.test(message.text);
}

function isClientFollowUpHandoff(text: string): boolean {
  return /\b(client|customer)\s+(?:message|response|reply|request|asks?|asked|says?|said|note|feedback)\s*\d*\s*:?\b/i.test(text);
}

function isHumanResolution(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  return [
    /\b(done|resolved|fixed|completed|handled|sent|shared|posted|created|updated|removed|added|saved|closed)\b/,
    /\b(no need|not needed|not required|ignore|leave it|stop follow(?:ing)? up|do not follow up|don t follow up)\b/,
    /\b(client replied|client responded|got response|received response)\b/
  ].some((pattern) => pattern.test(normalized));
}

function isBotResolution(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/\bfollow-up check\b/i.test(text)) return false;
  return [
    /\bdone\b/,
    /\bclient log update\b/,
    /\bremoved this from\b/,
    /\bupdated .* memory\b/,
    /\bapproved and created\b/,
    /\bapproved and added\b/,
    /\bapproval received\. creating\b/,
    /\bclickup sync should create the task\b/,
    /\bi sent\b|\bi posted\b|\bi created\b|\bi updated\b|\bi removed\b|\bi saved\b/,
    /\bno saved notes yet\b/
  ].some((pattern) => pattern.test(normalized));
}

function isLightweightAcknowledgement(normalized: string): boolean {
  const compact = normalized.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  if (!compact) return true;

  return [
    /^(hi|hey|hello|thanks|thank you|ok|okay|done|cool|great)$/,
    /^(yes|yeah|yep|sure|okay|ok)( please)?( do so| proceed| go ahead| do it| thanks)?$/,
    /^(sounds good|looks good|got it|noted|fine|alright)$/
  ].some((pattern) => pattern.test(compact));
}

function isViktorControlConversation(normalized: string): boolean {
  return [
    /\b(?:create|make|add|set up|open)\b.*\b(?:task|ticket)\b/,
    /\b(?:task|ticket)\b.*\b(?:create|make|add|set up|open)\b/,
    /\btask proposal\b/,
    /\bapproved and (?:added|created)\b/,
    /\bclickup\b/,
    /\bseo workbook\b/,
    /\bwhats?\s+next\b/,
    /\b(?:client\s+)?(?:log|logs|log file|memory|notes?)\b/,
    /\bpriority\s+(?:keywords?|queries?|urls?|pages?|list)\b/,
    /\b(?:keywords?|queries?|urls?|pages?)\s+priority\s+list\b/,
    /\badd this\b.*\b(?:log|memory|notes?)\b/,
    /\bprovide me\b.*\b(?:log|memory|notes?)\b/,
    /\bsend me\b.*\b(?:log|memory|notes?)\b/,
    /\b(?:remind|reminder|follow\s*up|follow-up|check\s*back|ping|nudge)\b/,
    /\bdaily monitoring\b/,
    /\bweekly (?:monitoring|summary|report|data)\b/,
    /\bmonthly (?:monitoring|summary|report|data)\b/,
    /\b3 months?\b|\bthree months?\b|\bquarterly\b|\b90 days?\b/,
    /\bgsc\b|\bga4\b|\bpagespeed\b|\bschema\b/,
    /\bare you (?:up|running)\b/,
    /\binitiate\b.*\bmonitoring\b/,
    /\bsend me\b.*\bdata\b/
  ].some((pattern) => pattern.test(normalized));
}

function followUpKey(candidate: FollowUpCandidate): string {
  return messageKey(candidate.channel, candidate.ts);
}

function messageKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function slackTsToMs(ts: string): number {
  return Number.parseFloat(ts) * 1000;
}

function normalizeReminderText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

async function persistMemory() {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

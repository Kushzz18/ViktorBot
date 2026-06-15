import "dotenv/config";
import { App } from "@slack/bolt";
import type { BlockAction, ButtonAction } from "@slack/bolt";
import { startAdminDashboard } from "./adminDashboard.js";
import {
  formatAdminSettings,
  formatLearnedRules,
  getDataDefault,
  getFollowupMinAgeMinutes,
  getReportChannel,
  getTeamMembers,
  loadAdminSettings,
  addAllowedUser,
  canUseBot,
  getAccessSettings,
  observeDataDefault,
  observeClientChannel,
  createLearningSuggestion,
  approveLearningSuggestion,
  rejectLearningSuggestion,
  rememberPreference,
  removeLearnedRule,
  removeAllowedUser,
  setAccessMode,
  setClientChannel,
  setFollowupMinAgeMinutes,
  setReportChannel,
  setThreshold
} from "./adminSettings.js";
import { claimSingleInstance } from "./singleInstance.js";
import type { ExportFormat } from "./exportArtifacts.js";
import { createClickUpExportArtifact, createTextExportArtifact } from "./exportArtifacts.js";
import { logError, logInfo } from "./logger.js";
import { config } from "./config.js";
import { hasViktorMention, setSlackBotUserId } from "./botIdentity.js";
import { classifyNaturalIntent, type NaturalIntent } from "./intent.js";
import {
  answerSlackFileQuestion,
  formatSlackFileMentions,
  hasReadableSlackFiles,
  type SlackFileRef
} from "./slackFiles.js";
import {
  formatClientMappings,
  formatLiveSheetMappings,
  findClientByName,
  inferClientFromChannelName,
  inferClientFromText,
  loadClients,
  updateClientMainCountry,
  updateClientGoogleProfile,
  type ClientConfig
} from "./clients.js";
import { formatClientDataRequest, type ClientDataFocus, type ClientDataRequest } from "./clientData.js";
import type { MonitoringDateSelection, MonitoringPeriod } from "./monitoringGoogle.js";
import { createClickUpTask } from "./clickup.js";
import {
  addClickUpComment,
  closeClickUpTask,
  type ClickUpDateRange,
  type ClickUpHealthTask,
  formatClickUpHealth,
  formatClickUpTeamStatusMatrix,
  formatClickUpTaskChange,
  formatClickUpTaskList,
  formatClickUpWorkload,
  getClickUpOverdueTasks,
  getClickUpTaskComments,
  getClickUpTaskDetails,
  getClickUpTaskHealth,
  getClickUpTasksForScope,
  getClickUpWorkload,
  searchClickUpTasks,
  updateClickUpTask
} from "./clickup.js";
import {
  askAssistant,
  classifyAlertThreadIntent,
  classifyStructuredIntent,
  composeSlackMessage,
  extractClientLogFacts,
  extractPriorityListUpdate,
  type PriorityListExtraction
} from "./ai.js";
import {
  answerDriveKnowledgeQuestion,
  answerDriveKnowledgeUrlQuestion,
  appendToGoogleDocument,
  appendToGoogleSheet,
  formatDriveFolderSearch,
  formatDriveKnowledgeSearch,
  replaceInGoogleDocument,
  summarizeDriveKnowledgeFile,
  summarizeDriveKnowledgeUrl,
  updateGoogleSheetCell
} from "./driveKnowledge.js";
import { appendTaskToSeoWorkbook, formatLastWorkbookTaskLocation } from "./workbookTasks.js";
import { checkGoogleApiHealth } from "./googleHealth.js";
import {
  formatDriveFiles,
  formatGaProperties,
  formatGoogleAccessSummary,
  formatGscSites
} from "./googleFormat.js";
import {
  findDueThreadReminders,
  findFollowUpCandidates,
  getMostRecentDmUser,
  getStoredSlackMessage,
  hasSimilarThreadReminder,
  loadMemory,
  cancelThreadFollowUps,
  markFollowUpAlerted,
  markThreadReminderDelivered,
  memoryStats,
  recentMemoryContext,
  rememberSlackMessage,
  scheduleThreadReminder,
  type FollowUpCandidate
} from "./memory.js";
import {
  formatReportForClient,
  getReportClientsForMode,
  hasDailyMonitoringRunToday,
  initializeMonitoring,
  markMonitoringAlertsSent,
  runDailyMonitoring,
  runDueMonitoring,
  runMonthlySummary,
  runWeeklySummary
} from "./monitoring.js";
import { hasAlerted, markAlerted } from "./monitoringStore.js";
import { isTrustedMessageRoute, rememberTrustedMessageRoute } from "./messageTrust.js";
import {
  beginProposalApproval,
  createMessageProposal,
  createProposal,
  getProposal,
  getProposalByMessage,
  updateProposalStatus
} from "./proposals.js";
import {
  activeWorkflowClientNames,
  createScheduledWorkflow,
  deleteScheduledWorkflow,
  dueScheduledWorkflows,
  formatScheduledWorkflow,
  formatScheduledWorkflows,
  getScheduledWorkflow,
  loadScheduledWorkflows,
  markScheduledWorkflowRun,
  setScheduledWorkflowStatus,
  type ScheduledWorkflow,
  type ScheduledWorkflowType
} from "./scheduledWorkflows.js";
import { learningBlocks, messageProposalBlocks, proposalBlocks } from "./slackBlocks.js";
import { parseDueDate, parseTaskDraft, type DraftTask } from "./taskParser.js";
import {
  addClientNote,
  addPriorityQueries,
  addPriorityUrls,
  formatClientNotePreview,
  formatClientNotes,
  formatPriorityQueries,
  formatPriorityUrls,
  getPriorityQueries,
  getPriorityUrls,
  ignoreSchemaUrls,
  loadClientMemory,
  removePriorityQueries,
  removePriorityUrls,
  removeClientNote,
  replacePriorityQueries,
  replacePriorityUrls,
  updateClientNote
} from "./clientMemory.js";

type SlackClient = {
  chat: {
    postMessage(input: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
    postEphemeral(input: {
      channel: string;
      user: string;
      thread_ts?: string;
      text: string;
    }): Promise<unknown>;
    delete(input: {
      channel: string;
      ts: string;
    }): Promise<unknown>;
    update(input: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
    getPermalink(input: {
      channel: string;
      message_ts: string;
    }): Promise<{ permalink?: string }>;
  };
  files: {
    uploadV2(input: {
      channel_id: string;
      thread_ts?: string;
      filename: string;
      title?: string;
      initial_comment?: string;
      file: Buffer;
    }): Promise<unknown>;
  };
  conversations: {
    list(input: {
      cursor?: string;
      exclude_archived?: boolean;
      limit?: number;
      types?: string;
    }): Promise<{
      channels?: Array<{ id?: string; name?: string; is_member?: boolean; is_private?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>;
    history(input: {
      channel: string;
      latest?: string;
      oldest?: string;
      limit?: number;
      inclusive?: boolean;
    }): Promise<{
      messages?: Array<{
        bot_id?: string;
        user?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        subtype?: string;
        files?: SlackFileRef[];
        reply_count?: number;
      }>;
    }>;
    replies(input: {
      channel: string;
      ts: string;
      limit?: number;
    }): Promise<{
      messages?: Array<{ bot_id?: string; user?: string; text?: string; ts?: string; thread_ts?: string; subtype?: string; files?: SlackFileRef[] }>;
    }>;
    join(input: { channel: string }): Promise<{
      ok?: boolean;
      error?: string;
      channel?: { id?: string; name?: string; is_member?: boolean };
    }>;
    info(input: { channel: string }): Promise<{
      channel?: { id?: string; name?: string };
    }>;
    open(input: { users: string }): Promise<{
      channel?: { id?: string };
    }>;
  };
  users: {
    list(input: {
      cursor?: string;
      limit?: number;
    }): Promise<{
      members?: Array<{
        id?: string;
        name?: string;
        real_name?: string;
        deleted?: boolean;
        is_bot?: boolean;
      }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
};

type BotLogger = {
  error(error: unknown): void;
};

type PendingDataRequest = Partial<ClientDataRequest> & {
  requestedAt: number;
  destinationChannelName?: string;
};

const pendingDataRequests = new Map<string, PendingDataRequest>();
type LastDataResponse = ClientDataRequest & {
  text: string;
  title: string;
};

type MessageCommand = {
  channelName?: string;
  targets?: string[];
  message: string;
  exact: boolean;
};

type PreparedMessageTarget = {
  channelId: string;
  channelName: string;
  isMember?: boolean;
  isPrivate?: boolean;
  kind?: "channel" | "dm";
};

type PreparedChannelMessage = PreparedMessageTarget & {
  text: string;
  targets?: PreparedMessageTarget[];
};
const lastDataResponses = new Map<string, LastDataResponse>();
const recentClientContexts = new Map<string, { clientName: string; updatedAt: number }>();
const recentPriorityRemovals = new Map<string, { queries: string[]; urls: string[]; updatedAt: number }>();
const pendingTaskDrafts = new Map<string, { draft: DraftTask; requester: string; updatedAt: number }>();
const pendingClickUpActions = new Map<string, {
  action: "comment" | "update" | "close";
  task: ClickUpHealthTask;
  updateText?: string;
  commentText?: string;
  updatedAt: number;
}>();
const processedFollowUpCancelRequests = new Set<string>();
let activeManualRequests = 0;
let manualPriorityUntil = 0;
let scheduledMonitoringRunning = false;
let scheduledClickUpWorkloadRunning = false;
let dashboardWeeklyRunning = false;
const monitoringRuntimeStartedAt = Date.now();
const monitoringRuntimeId = String(monitoringRuntimeStartedAt);
let latestDailyPreparedReport: Awaited<ReturnType<typeof runDailyMonitoring>> | undefined;
let latestDailyPreparedAt = 0;
const CLICKUP_WORKLOAD_HOUR = 9;
const WORKFLOW_TEAMS = ["Team AB", "Team CD"] as const;
type WorkflowTeam = (typeof WORKFLOW_TEAMS)[number];
const DAILY_ALERT_TEAM_CHANNELS: Record<WorkflowTeam, string> = {
  "Team AB": "daily-alert-team-ab",
  "Team CD": "daily-alert-team-cd"
};
const WEEKLY_ALERT_TEAM_CHANNELS: Record<WorkflowTeam, string> = {
  "Team AB": "weekly-alert-team-ab",
  "Team CD": "weekly-alert-team-cd"
};
const CLICKUP_WORKLOAD_TEAM_CHANNELS: Record<WorkflowTeam, string> = {
  "Team AB": "clickup-workload-team-ab",
  "Team CD": "clickup-workload-team-cd"
};
const WORKFLOW_TEAM_MEMBERS: Record<WorkflowTeam, string[]> = {
  "Team AB": [
    "Kushal",
    "Teammate AB 1",
    "Teammate AB 2",
    "Teammate AB 3",
    "Teammate AB 4"
  ],
  "Team CD": [
    "Kushal",
    "Teammate CD 1",
    "Teammate CD 2",
    "Teammate CD 3",
    "Teammate CD 4"
  ]
};
const UNSUPPORTED_REQUEST_NOTIFY_USER_ID = "U048TPLUE1J";
const FOLLOWUP_BACKFILL_LOOKBACK_HOURS = 36;
let followUpBackfillRunning = false;

function hasManualPriority() {
  return activeManualRequests > 0 || Date.now() < manualPriorityUntil;
}

async function runWithManualPriority<T>(work: () => Promise<T>): Promise<T> {
  activeManualRequests += 1;
  manualPriorityUntil = Date.now() + 2 * 60 * 1000;

  try {
    return await work();
  } finally {
    activeManualRequests = Math.max(0, activeManualRequests - 1);
    manualPriorityUntil = Date.now() + 30 * 1000;
  }
}

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: config.SLACK_APP_TOKEN
});

app.error(async (error) => {
  logError(error);
});

try {
  const auth = await app.client.auth.test();
  setSlackBotUserId(auth.user_id);
} catch (error) {
  logError(error);
}

const releaseSingleInstance = await claimSingleInstance();
await loadAdminSettings();
await loadClientMemory();
await loadMemory();
await loadScheduledWorkflows();
await initializeMonitoring();
await startAdminDashboard({
  runWorkflow: runDashboardWorkflow
});

process.on("uncaughtException", (error) => {
  logError(error);
  void releaseSingleInstance().finally(() => process.exit(1));
});

process.on("unhandledRejection", (error) => {
  logError(error);
  void releaseSingleInstance().finally(() => process.exit(1));
});

app.command("/viktor-task", async ({ ack, command, client, logger }) => {
  await ack();

  try {
    const draft = parseTaskDraft(command.text);
    const message = await client.chat.postMessage({
      channel: command.channel_id,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, "pending")
    });

    if (!message.ts) {
      throw new Error("Slack did not return a message timestamp.");
    }

    const proposal = createProposal({
      channel: command.channel_id,
      messageTs: message.ts,
      requester: command.user_id,
      draft
    });

    await client.chat.update({
      channel: command.channel_id,
      ts: message.ts,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, proposal.id)
    });
  } catch (error) {
    logger.error(error);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "I could not prepare that task proposal. Please check the format and try again."
    });
  }
});

app.event("app_mention", async (args) => {
  const { client, logger } = args;
  const event = args.event as {
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    files?: SlackFileRef[];
  } | undefined;

  try {
    if (!event?.channel || !event.ts) return;
    if (!canUseBot(event.user)) {
      await notifyRestrictedAccess(client as SlackClient, event.channel, event.user, event.ts);
      return;
    }
    const rawText = event.text ?? "";
    let text = rawText.replace(/<@[^>]+>/g, "").trim();
    const replyThreadTs = event.thread_ts ?? event.ts;

    if (isStatusQuestion(text)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: statusMessage()
      });
      return;
    }

    const mentionChannelInfo = await getChannelInfo(client as SlackClient, event.channel);
    const mentionClient = mentionChannelInfo?.name ? await inferClientFromChannelName(mentionChannelInfo.name) : undefined;
    if (!text && event.thread_ts) {
      text = await getThreadRequestForBareMention(client as SlackClient, event.channel, event.thread_ts, event.ts);
    }

    if (event.thread_ts && hasThreadResolutionMention(rawText)) {
      await acknowledgeThreadFollowUpCancel(
        client as SlackClient,
        event.channel,
        replyThreadTs,
        event.ts,
        "Got it. I will stop follow-ups for this thread."
      );
      return;
    }

    if (isFollowUpCancelRequest(text)) {
      await acknowledgeThreadFollowUpCancel(
        client as SlackClient,
        event.channel,
        replyThreadTs,
        event.ts,
        "Got it. I cancelled follow-ups for this thread. No more pings will be sent unless a new reminder is created."
      );
      return;
    }

    const forwardedWorkflowThread = await handleWorkflowThreadForwardRequest(
      client as SlackClient,
      event.channel,
      replyThreadTs,
      event.ts,
      text
    );
    if (forwardedWorkflowThread) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: forwardedWorkflowThread
      });
      return;
    }

    const countryResult = await handleClientCountryCommand(text, mentionClient?.client);
    if (countryResult) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: countryResult
      });
      return;
    }

    const learningRequest = parseLearningButtonRequest(text);
    if (learningRequest) {
      await maybePostLearningSuggestion(
        client as SlackClient,
        event.channel,
        await createLearningSuggestion({ text: learningRequest }),
        replyThreadTs
      );
      return;
    }

    const threadReminder = parseThreadReminderRequest(text);
    if (threadReminder) {
      await scheduleThreadReminder({
        channel: event.channel,
        threadTs: replyThreadTs,
        target: threadReminder.target,
        requester: event.user,
        message: threadReminder.message,
        remindAt: threadReminder.remindAt.toISOString()
      });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: `Got it. I’ll remind ${threadReminder.target === "channel" ? "the channel" : "this thread"} on ${formatReminderDate(threadReminder.remindAt)}.`
      });
      return;
    }

    if (isPassiveFollowUpHandoff(text)) {
      if (!event.thread_ts) return;
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: `Got it. I’ll track this thread for follow-up during office hours.`
      });
      return;
    }

    const savedThreadLog = await handleSaveThisToClientLogCommand(client as SlackClient, event.channel, replyThreadTs, event.ts, text, mentionClient?.client, event.user);
    if (savedThreadLog) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: savedThreadLog
      });
      return;
    }

    const clientMemoryResult = await handleClientMemoryCommand(text, mentionClient?.client, event.user);
    if (clientMemoryResult) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: clientMemoryResult
      });
      return;
    }

    if (isClientLogIntent(text)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: "I can help with that client log, but I could not find a note to save or a client log to show from this message. Reply in the same thread with `add client log: <note>` or ask `send me the log of this client`."
      });
      return;
    }

    const channelMessage = isClientLogIntent(text) ? undefined : parseChannelMessageCommand(text) ?? parseNaturalMessageCommand(text);
    if (channelMessage) {
      await postMessageProposal(client as SlackClient, event.channel, replyThreadTs, channelMessage, event.user ?? "unknown", `${event.channel}:${event.ts}`);
      return;
    }

    const dashboardWorkflowId = parseDashboardWorkflowRunCommand(text);
    if (dashboardWorkflowId) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: await runDashboardWorkflow(dashboardWorkflowId)
      });
      return;
    }

    const monitoringRequest = parseMonitoringCommand(text);
    if (monitoringRequest) {
      await runManualMonitoringCommand(client as SlackClient, monitoringRequest, event.channel, replyThreadTs);
      return;
    }

    const workflowResult = await handleScheduledWorkflowCommand(client as SlackClient, text, event.channel, event.user, replyThreadTs);
    if (workflowResult) {
      await client.chat.postMessage({ channel: event.channel, thread_ts: replyThreadTs, text: workflowResult });
      return;
    }

    if (await handleExportCommand(client as SlackClient, text, event.channel, replyThreadTs)) return;

    const channelInfo = mentionChannelInfo;
    const inferredClient = mentionClient;
    if (event.thread_ts && isThreadResolutionOnly(text)) {
      await acknowledgeThreadFollowUpCancel(
        client as SlackClient,
        event.channel,
        replyThreadTs,
        event.ts,
        "Got it. I will stop follow-ups for this thread."
      );
      return;
    }

    if (event.thread_ts && /\b(schema|json-ld)\b/i.test(text) && /\b(not needed|not required|ignore|exclude|don't flag|do not flag|no need|remove)\b/i.test(text)) {
      const context = await getThreadContext(client as SlackClient, event.channel, event.thread_ts);
      if (await routeAlertThreadTool(client as SlackClient, event.channel, event.thread_ts, text, context, event.user)) return;
    }

    const taskDraft = await resolveTaskDraftFromTextOrThread(client as SlackClient, event.channel, replyThreadTs, text, inferredClient?.client, event.user);
    if (taskDraft) {
      await postTaskProposal(client as SlackClient, event.channel, replyThreadTs, taskDraft, event.user ?? "unknown");
      return;
    }

    const dataRequest = parseDataRequest(text, inferredClient?.client);
    if (dataRequest) {
      if (isCompleteDataRequest(dataRequest)) {
        await sendDataRequestResponse(client as SlackClient, event.channel, dataRequest, event.ts);
      } else {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: replyThreadTs,
          text: dataClarificationPrompt(dataRequest)
        });
      }
      return;
    }

    if (!isCreateTaskCommand(text)) {
      const answer = await answerWithAgentContext(client as SlackClient, event.channel, text || "How can I help?", {
        channelName: channelInfo?.name,
        inferredClient,
        threadTs: replyThreadTs,
        files: event.files
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: replyThreadTs,
        text: answer
      });
      return;
    }

    const draft = parseTaskDraft(text);
    const message = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: replyThreadTs,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, "pending")
    });

    if (!message.ts) {
      throw new Error("Slack did not return a message timestamp.");
    }

    const proposal = createProposal({
      channel: event.channel,
      messageTs: message.ts,
      requester: event.user ?? "unknown",
      draft
    });

    await client.chat.update({
      channel: event.channel,
      ts: message.ts,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, proposal.id)
    });
  } catch (error) {
    logger.error(error);
  }
});

app.message(async (args) => {
  const { client, logger } = args;
  if (!args.message) return;

  const directMessage = args.message as {
    bot_id?: string;
    channel: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    user?: string;
    files?: SlackFileRef[];
  };

  if (directMessage.ts && (directMessage.text || directMessage.files?.length)) {
    await rememberSlackMessage({
      channel: directMessage.channel,
      channelType: directMessage.channel_type,
      user: directMessage.user,
      botId: directMessage.bot_id,
      text: [directMessage.text, formatSlackFileMentions(directMessage.files)].filter(Boolean).join(" "),
      ts: directMessage.ts,
      threadTs: directMessage.thread_ts,
      files: directMessage.files,
      storedAt: new Date().toISOString()
    });
  }

  if (directMessage.bot_id || (!directMessage.text && !hasReadableSlackFiles(directMessage.files))) {
    return;
  }

  if (!canUseBot(directMessage.user)) {
    if (directMessage.channel_type === "im") {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: restrictedAccessMessage()
      });
    }
    return;
  }

  try {
    let text = directMessage.text?.trim() || "summarize the attached file";

    if (directMessage.channel_type !== "im") {
      if (directMessage.thread_ts && hasViktorMention(text)) {
        const mentionText = text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (hasThreadResolutionMention(text) || isFollowUpCancelRequest(mentionText) || isThreadResolutionOnly(mentionText)) {
          await acknowledgeThreadFollowUpCancel(
            client as SlackClient,
            directMessage.channel,
            directMessage.thread_ts,
            directMessage.ts,
            "Got it. I will stop follow-ups for this thread."
          );
          return;
        }
      }
      if (directMessage.thread_ts && !hasViktorMention(text)) {
        const handled = await handleChannelThreadContinuation(client as SlackClient, {
          channel: directMessage.channel,
          text,
          ts: directMessage.ts,
          threadTs: directMessage.thread_ts,
          user: directMessage.user
        });
        if (handled) return;
      }
      return;
    }

    if (directMessage.thread_ts && directMessage.ts && isBareMention(text)) {
      text = await getThreadRequestForBareMention(client as SlackClient, directMessage.channel, directMessage.thread_ts, directMessage.ts);
      if (!text) {
        await client.chat.postMessage({
          channel: directMessage.channel,
          thread_ts: directMessage.thread_ts,
          text: "I could not find the request above this mention. Send the request again in the thread and I will handle it."
        });
        return;
      }
    }

    const pendingData = pendingDataRequests.get(directMessage.channel);
    const resendLastData = parseSendLastDataToClientChannel(text);
    if (await handleLastDataExportRequest(client as SlackClient, text, directMessage.channel, directMessage.thread_ts)) return;
    if (resendLastData) {
      const previous = getLastDataResponse(directMessage.channel, directMessage.thread_ts);
      if (!previous) {
        await client.chat.postMessage({
          channel: directMessage.channel,
          text: "I do not have a recent data response to resend yet. Ask for the client data first, then say `send this in channel`."
        });
        return;
      }

      const targetClient = await inferClientFromText(previous.clientName);
      const destinationChannelName = targetClient?.slackChannel || previous.clientName;
      await sendDataRequestResponse(client as SlackClient, directMessage.channel, {
        ...previous,
        destinationChannelName
      });
      return;
    }

    if (pendingData && isLikelyDataClarification(text)) {
      const completed = mergeDataRequest(pendingData, text);
      if (isCompleteDataRequest(completed)) {
        pendingDataRequests.delete(directMessage.channel);
        await sendDataRequestResponse(client as SlackClient, directMessage.channel, completed);
        return;
      }

      pendingDataRequests.set(directMessage.channel, completed);
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: dataClarificationPrompt(completed)
      });
      return;
    }

    if (!parseDataRequest(text) && /\b(week|weekly|month|monthly|daily|comparison|compare)\b/i.test(text) && /\b(data|comparison)\b/i.test(text) && /\?$/.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: "The last GSC/GA performance format uses weekly data by default: the latest available 7 days compared with the previous 7 days. Going forward, if you ask for data without saying daily, weekly, or monthly, I’ll ask first before fetching it."
      });
      return;
    }

    if (/^(help|hi|hello)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: helpMessage()
      });
      return;
    }

    if (isHowToRequest(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: howToHelpMessage(text)
      });
      return;
    }

    if (isStatusQuestion(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: statusMessage()
      });
      return;
    }

    const learningRequest = parseLearningButtonRequest(text);
    if (learningRequest) {
      await maybePostLearningSuggestion(
        client as SlackClient,
        directMessage.channel,
        await createLearningSuggestion({ text: learningRequest })
      );
      return;
    }

    if (/^(memory stats|stats)$/i.test(text)) {
      const stats = memoryStats();
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: [
          `I remember ${stats.messages} Slack messages across ${stats.channels} conversations.`,
          `${stats.alertedFollowUps} follow-up alerts have already been marked.`
        ].join("\n")
      });
      return;
    }

    const adminResult = await handleAdminSettingsCommand(text);
    if (adminResult) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: adminResult
      });
      return;
    }

    const countryResult = await handleClientCountryCommand(text);
    if (countryResult) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: countryResult
      });
      return;
    }

    const mentionedClient = await inferClientFromText(text);
    if (mentionedClient) rememberRecentClientContext(directMessage.channel, mentionedClient.client);
    const previousData = getLastDataResponse(directMessage.channel, directMessage.thread_ts);
    const contextualClientName = mentionedClient?.client ?? previousData?.clientName ?? getRecentClientContext(directMessage.channel);

    const savedThreadLog = directMessage.thread_ts && directMessage.ts
      ? await handleSaveThisToClientLogCommand(client as SlackClient, directMessage.channel, directMessage.thread_ts, directMessage.ts, text, contextualClientName, directMessage.user)
      : undefined;
    if (savedThreadLog) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        thread_ts: directMessage.thread_ts,
        text: savedThreadLog
      });
      return;
    }

    const clientMemoryResult = await handleClientMemoryCommand(text, contextualClientName, directMessage.user);
    if (clientMemoryResult) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: clientMemoryResult
      });
      return;
    }

    if (isClientLogIntent(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: "I can help with client logs, but I need either a client name or the note text. Try `show client log for Example Client X` or `add client log for Example Client X: <note>`."
      });
      return;
    }

    if (/^(google status|google access|google summary)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatGoogleAccessSummary()
      });
      return;
    }

    if (/^(list|show)\s+clients$|^client mappings$|^monitoring clients$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatClientMappings()
      });
      return;
    }

    if (/^(sheet sync|sheets sync|team tracker sync|live mappings)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatLiveSheetMappings()
      });
      return;
    }

    const channelMapRequest = text.match(/^(?:map|match|infer)\s+channel\s+#?([a-z0-9_-]+)$/i);
    if (channelMapRequest?.[1]) {
      const inferred = await inferClientFromChannelName(channelMapRequest[1]);
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: inferred
          ? `#${channelMapRequest[1]} maps to ${inferred.client}.`
          : `I could not confidently map #${channelMapRequest[1]} to a client yet.`
      });
      return;
    }

    if (/^(list|show)\s+(drive|google drive)\s+(files|docs|documents)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatDriveFiles()
      });
      return;
    }

    const driveSearch = text.match(/^(?:search|find)\s+(?:drive|knowledge|docs|documents)\s+(.+)$/i);
    if (driveSearch?.[1]) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatDriveKnowledgeSearch(driveSearch[1].trim())
      });
      return;
    }

    if (/^(list|show)\s+(gsc|search console)\s+(sites|properties)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatGscSites()
      });
      return;
    }

    if (/^(list|show)\s+(ga|ga4|analytics)\s+(properties|accounts)$/i.test(text)) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatGaProperties()
      });
      return;
    }

    const dashboardWorkflowId = parseDashboardWorkflowRunCommand(text);
    if (dashboardWorkflowId) {
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await runDashboardWorkflow(dashboardWorkflowId)
      });
      return;
    }

    const monitoringRequest = parseMonitoringCommand(text);
    if (monitoringRequest) {
      await runManualMonitoringCommand(client as SlackClient, monitoringRequest, directMessage.channel);
      return;
    }

    const workflowResult = await handleScheduledWorkflowCommand(client as SlackClient, text, directMessage.channel, directMessage.user);
    if (workflowResult) {
      await client.chat.postMessage({ channel: directMessage.channel, text: workflowResult });
      return;
    }

    if (await handleExportCommand(client as SlackClient, text, directMessage.channel)) return;

    const dmThreadTs = directMessage.thread_ts ?? directMessage.ts;
    if (dmThreadTs) {
      const taskDraft = await resolveTaskDraftFromTextOrThread(
        client as SlackClient,
        directMessage.channel,
        dmThreadTs,
        text,
        contextualClientName,
        directMessage.user
      );
      if (taskDraft) {
        await postTaskProposal(client as SlackClient, directMessage.channel, directMessage.thread_ts, taskDraft, directMessage.user ?? "unknown");
        return;
      }
    }

    const dataRequest = resolveDataRequestFromRecentContext(parseDataRequest(text, contextualClientName), text, previousData);
    if (dataRequest) {
      rememberRecentClientContext(directMessage.channel, dataRequest.clientName);
      if (isCompleteDataRequest(dataRequest)) {
        await sendDataRequestResponse(client as SlackClient, directMessage.channel, dataRequest);
      } else {
        pendingDataRequests.set(directMessage.channel, dataRequest);
        await client.chat.postMessage({
          channel: directMessage.channel,
          text: dataClarificationPrompt(dataRequest)
        });
      }
      return;
    }

    const channelMessage = isClientLogIntent(text) ? undefined : parseChannelMessageCommand(text) ?? parseNaturalMessageCommand(text);
    if (channelMessage) {
      await postMessageProposal(client as SlackClient, directMessage.channel, undefined, channelMessage, directMessage.user ?? "unknown", directMessage.channel);
      return;
    }

    if (/^(scan followups|scan follow-ups|followups|follow-ups)$/i.test(text)) {
      const candidates = findFollowUpCandidates({ includeAlreadyAlerted: true, limit: 10 });
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: await formatFollowUpReport(client as SlackClient, candidates, true)
      });
      return;
    }

    const clickupHealth = text.match(/^(?:clickup\s+)?(?:health|task health)(?:\s+(.+))?$/i);
    if (clickupHealth) {
      const listName = clickupHealth[1]?.trim();
      const tasks = await getClickUpTaskHealth(listName);
      await client.chat.postMessage({
        channel: directMessage.channel,
        text: formatClickUpHealth(tasks, listName)
      });
      return;
    }

    const clickupComment = text.match(/^comment\s+(?:on\s+)?(?:clickup\s+)?task\s+([a-zA-Z0-9]+)\s*:\s*([\s\S]+)$/i);
    if (clickupComment?.[1] && clickupComment[2]) {
      await addClickUpComment(clickupComment[1], clickupComment[2].trim());
      await client.chat.postMessage({ channel: directMessage.channel, text: `Comment added to ClickUp task ${clickupComment[1]}.` });
      return;
    }

    const clickupUpdate = text.match(/^update\s+(?:clickup\s+)?task\s+([a-zA-Z0-9]+)\s+(.+)$/i);
    if (clickupUpdate?.[1] && clickupUpdate[2]) {
      await updateClickUpTask(parseClickUpUpdate(clickupUpdate[1], clickupUpdate[2]));
      await client.chat.postMessage({ channel: directMessage.channel, text: `Updated ClickUp task ${clickupUpdate[1]}.` });
      return;
    }

    const dmTaskDraft = parseNaturalTaskDraft(text, contextualClientName);
    if (dmTaskDraft) {
      await postTaskProposal(client as SlackClient, directMessage.channel, undefined, dmTaskDraft, directMessage.user ?? "unknown");
      return;
    }

    if (!isCreateTaskCommand(text)) {
      const answer = await answerWithAgentContext(client as SlackClient, directMessage.channel, text, { files: directMessage.files });
      await client.chat.postMessage({ channel: directMessage.channel, text: answer });
      return;
    }

    const draft = parseTaskDraft(text);
    const messageResponse = await client.chat.postMessage({
      channel: directMessage.channel,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, "pending")
    });

    if (!messageResponse.ts) {
      throw new Error("Slack did not return a message timestamp.");
    }

    const proposal = createProposal({
      channel: directMessage.channel,
      messageTs: messageResponse.ts,
      requester: directMessage.user ?? "unknown",
      draft
    });

    await client.chat.update({
      channel: directMessage.channel,
      ts: messageResponse.ts,
      text: `Task proposal: ${draft.title}`,
      blocks: proposalBlocks(draft, proposal.id)
    });
  } catch (error) {
    logger.error(error);

    await client.chat.postMessage({
      channel: directMessage.channel,
      text: error instanceof Error ? error.message : "I could not complete that request. Try `help` for the current format."
    });
  }
});

setInterval(() => {
  void runScheduledFollowUpScan(app.client as SlackClient, consoleLogger);
}, config.FOLLOWUP_SCAN_INTERVAL_MINUTES * 60 * 1000);

setInterval(() => {
  void runScheduledMonitoringIfDue(app.client as SlackClient, consoleLogger);
}, 60 * 1000);

setInterval(() => {
  void runOptInScheduledWorkflows(app.client as SlackClient, consoleLogger);
}, 60 * 1000);

setTimeout(() => {
  void runScheduledFollowUpScan(app.client as SlackClient, consoleLogger);
  void runScheduledMonitoringIfDue(app.client as SlackClient, consoleLogger);
  void runOptInScheduledWorkflows(app.client as SlackClient, consoleLogger);
}, 15 * 1000);

const consoleLogger: BotLogger = {
  error(error: unknown) {
    console.error(error);
  }
};

function isCreateTaskCommand(text: string): boolean {
  return /^(?:hey\s+viktor[,.]?\s*)?(?:create\s+task|task):/i.test(text.trim());
}

function isStatusQuestion(text: string): boolean {
  return /^(?:are\s+you\s+)?(?:up\s+and\s+running|running|online|alive|working|status|bot status)\??$/i.test(text.trim());
}

function statusMessage(): string {
  return "Yes, I am running. I can listen in Slack, answer DMs and mentions, fetch mapped GSC/GA data, create ClickUp tasks when explicitly asked, and send scheduled monitoring alerts.";
}

type ParsedThreadReminder = {
  remindAt: Date;
  message: string;
  target: "thread" | "channel";
};

function parseThreadReminderRequest(text: string, now = new Date()): ParsedThreadReminder | undefined {
  const normalized = text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!/\b(remind|reminder|follow\s*up|follow-up|check\s*back|ping|nudge)\b/i.test(normalized)) {
    return undefined;
  }

  const duration = normalized.match(/\b(?:in|after)\s+(?:every\s+)?(\d{1,5})\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i);
  if (duration?.[1] && duration[2]) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const multiplier =
      unit.startsWith("m") ? 60 * 1000 :
      unit.startsWith("h") ? 60 * 60 * 1000 :
      unit.startsWith("d") ? 24 * 60 * 60 * 1000 :
      7 * 24 * 60 * 60 * 1000;
    return {
      remindAt: new Date(now.getTime() + amount * multiplier),
      message: parseReminderMessage(normalized),
      target: parseReminderTarget(normalized)
    };
  }

  const explicitDate = parseExplicitReminderDate(normalized, now);
  if (explicitDate) {
    return {
      remindAt: explicitDate,
      message: parseReminderMessage(normalized),
      target: parseReminderTarget(normalized)
    };
  }

  if (/\btomorrow\b/i.test(normalized)) {
    return {
      remindAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      message: parseReminderMessage(normalized),
      target: parseReminderTarget(normalized)
    };
  }

  if (/\bnext week\b/i.test(normalized)) {
    return {
      remindAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      message: parseReminderMessage(normalized),
      target: parseReminderTarget(normalized)
    };
  }

  if (/\b(?:this\s+)?thread\b/i.test(normalized) || /\b(remind|follow\s*up|follow-up)\b/i.test(normalized)) {
    return {
      remindAt: new Date(now.getTime() + getFollowupMinAgeMinutes() * 60 * 1000),
      message: parseReminderMessage(normalized),
      target: parseReminderTarget(normalized)
    };
  }

  return undefined;
}

function isFollowUpCancelRequest(text: string): boolean {
  return /\b(?:stop|cancel|remove|delete|clear)\b[\s\S]{0,40}\b(?:follow\s*up|follow-up|reminder|ping|nudge)\b/i.test(text) ||
    /\b(?:no more|do not|don['’]?t)\b[\s\S]{0,40}\b(?:follow\s*ups?|follow-up|reminders?|pings?|nudges?)\b/i.test(text);
}

function parseExplicitReminderDate(text: string, now: Date): Date | undefined {
  const match = text.match(/\b(?:on|by|at)?\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/i);
  if (match?.[1]) {
    const cleaned = match[1].replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
    const parsed = parseMonthDayReminderDate(cleaned, now);
    if (!parsed) return undefined;
    const dateTime = parseReminderTime(text);
    if (dateTime) {
      parsed.setHours(dateTime.hours, dateTime.minutes, 0, 0);
    } else {
      parsed.setHours(9, 0, 0, 0);
    }
    return parsed;
  }

  const timeOnly = parseReminderTime(text);
  if (!timeOnly) return undefined;
  const parsed = new Date(now);
  parsed.setHours(timeOnly.hours, timeOnly.minutes, 0, 0);
  if (/\btomorrow\b/i.test(text) || parsed.getTime() <= now.getTime()) {
    parsed.setDate(parsed.getDate() + 1);
  }
  return parsed;
}

function parseReminderTime(text: string): { hours: number; minutes: number } | undefined {
  const twentyFourHour = text.match(/\b(?:at|by)\s+([01]?\d|2[0-3]):([0-5]\d)\b/i);
  if (twentyFourHour?.[1] && twentyFourHour[2]) {
    return { hours: Number(twentyFourHour[1]), minutes: Number(twentyFourHour[2]) };
  }

  const match = text.match(/\b(?:at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match?.[1] || !match[3]) return undefined;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return undefined;
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;
  return { hours, minutes };
}

function parseMonthDayReminderDate(value: string, now: Date): Date | undefined {
  const match = value.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i);
  if (!match?.[1] || !match[2]) return undefined;
  const month = monthIndex(match[1]);
  if (month < 0) return undefined;
  const year = match[3] ? Number(match[3]) : now.getFullYear();
  const parsed = new Date(year, month, Number(match[2]));
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (!match[3] && parsed.getTime() < reminderStartOfDay(now).getTime()) parsed.setFullYear(parsed.getFullYear() + 1);
  return parsed;
}

function reminderStartOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function monthIndex(value: string): number {
  const key = value.toLowerCase().slice(0, 3);
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key);
}

function parseReminderMessage(text: string): string {
  const explicit = text.match(/:\s*(.+)$/s)?.[1]?.trim();
  const afterTo = text.match(/\bto\s+(.+)$/is)?.[1]?.trim();
  return explicit || afterTo || "Please follow up on this thread.";
}

function parseReminderTarget(text: string): "thread" | "channel" {
  return /\b(?:in|to|on)\s+(?:the\s+)?channel\b/i.test(text) && !/\b(?:this\s+)?thread\b/i.test(text) ? "channel" : "thread";
}

function formatReminderDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Katmandu"
  }).format(date);
}

function restrictedAccessMessage(): string {
  return "Viktor is currently limited to the management/testing group during deployment. Please ask an admin to add you once rollout expands.";
}

async function notifyRestrictedAccess(client: SlackClient, channel: string, user?: string, ts?: string) {
  if (!user) return;
  try {
    await client.chat.postEphemeral({
      channel,
      user,
      thread_ts: ts,
      text: restrictedAccessMessage()
    });
  } catch {
    // Avoid noisy public replies if Slack cannot send an ephemeral message.
  }
}

function helpMessage(): string {
  return [
    "I can help with client data, Drive files, ClickUp, Slack messages, monitoring, and client memory.",
    "",
    "*Reliable commands*",
    "- `show weekly data for Client Name`",
    "- `send daily monitoring for Client Name`",
    "- `find drive topical map for Client Name`",
    "- `summarize the document <Google Drive URL>`",
    "- `create task: Task title | Client: Client Name | Due: tomorrow | Priority: high`",
    "- `show Team AB workload`",
    "- `find tasks about Example Client X`",
    "- `comment on task \"Task name\" for Client Name: comment text`",
    "- `go to channel #channel-name and message your message`",
    "- `add client log for Client Name: note text`",
    "- In a thread: `@Viktor remind in 2 days: ask for an update`",
    "- `scan followups`"
  ].join("\n");
}

function isHowToRequest(text: string): boolean {
  return /\b(how\s+(?:do|can|should)\s+i|how\s+to|what\s+command|commands?\s+for|show\s+me\s+how)\b/i.test(text);
}

function howToHelpMessage(text: string): string {
  const lower = text.toLowerCase();
  const lines = ["Here are the safest commands for that:"];

  if (/\b(data|gsc|ga4|analytics|performance|report)\b/i.test(lower)) {
    lines.push("- `show weekly data for Client Name`");
    lines.push("- `show monthly GSC data for Client Name`");
    lines.push("- `send daily monitoring for Client Name`");
  }
  if (/\b(drive|doc|document|sheet|pdf|summar)/i.test(lower)) {
    lines.push("- `find drive topical map for Client Name`");
    lines.push("- `summarize the document <Google Drive URL>`");
    lines.push("- `answer from <Google Drive URL>: your question`");
    lines.push("- `append note text to the doc Document Name`");
  }
  if (/\b(task|clickup|workload|overdue)\b/i.test(lower)) {
    lines.push("- `show Team AB workload`");
    lines.push("- `what's overdue for Kushal?`");
    lines.push("- `find tasks about Client Name`");
    lines.push("- `create task: Task title | Client: Client Name | Due: tomorrow | Priority: high`");
    lines.push("- `comment on task \"Task name\" for Client Name: comment text`");
  }
  if (/\b(slack|message|channel|post|send)\b/i.test(lower)) {
    lines.push("- `go to channel #channel-name and message your message`");
  }
  if (/\b(follow|followup|follow-up|client message|unanswered)\b/i.test(lower)) {
    lines.push("- In a client thread, tag Viktor with `@Viktor client message:` followed by the client request. Viktor will track it quietly.");
    lines.push("- For a custom thread reminder, use `@Viktor remind in 2 days: ask for an update`.");
    lines.push("- To stop tracking, reply in the thread with `resolved`, `done`, `handled`, `no need`, or `stop follow up`.");
    lines.push("- To check manually in DM, use `scan followups`.");
  }
  if (lines.length === 1) lines.push(helpMessage());
  return lines.join("\n");
}

async function acknowledgeThreadFollowUpCancel(
  client: SlackClient,
  channel: string,
  threadTs: string,
  messageTs: string | undefined,
  text: string
): Promise<void> {
  const key = `${channel}:${messageTs ?? threadTs}:followup-cancel`;
  if (processedFollowUpCancelRequests.has(key)) return;
  processedFollowUpCancelRequests.add(key);
  await cancelThreadFollowUps(channel, threadTs);
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text
  });
}

async function getThreadRequestForBareMention(
  client: SlackClient,
  channel: string,
  threadTs: string,
  mentionTs: string
): Promise<string> {
  try {
    const response = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
    const candidates = (response.messages ?? [])
      .filter((message) => !message.bot_id && message.text && message.ts !== mentionTs)
      .filter((message) => !isBareMention(message.text ?? ""))
      .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    const previous = candidates
      .filter((message) => Number(message.ts ?? 0) < Number(mentionTs))
      .at(-1) ?? candidates.at(-1);
    return (previous?.text ?? "").replace(/<@[^>]+>/g, "").trim();
  } catch {
    return "";
  }
}

function isBareMention(text: string): boolean {
  return text.replace(/<@[^>]+>/g, "").trim().length === 0;
}

function isPassiveFollowUpHandoff(text: string): boolean {
  const normalized = text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!isClientFollowUpHandoffText(normalized)) {
    return false;
  }
  return true;
}

function isClientFollowUpHandoffText(text: string): boolean {
  return /\b(client|customer)\s+(?:message|response|reply|request|asks?|asked|says?|said|note|feedback)\s*:?\b/i.test(text);
}

function isThreadResolutionOnly(text: string): boolean {
  const normalized = text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\?/.test(normalized)) return false;
  if (/\b(create|make|add|open|update|fetch|show|get|summarize|send|post|reply|explain|why|how|what)\b/i.test(normalized)) return false;
  return /\b(done|resolved|fixed|completed|handled|no need|not needed|stop follow(?:ing)? up|do not follow up)\b/i.test(normalized);
}

function hasThreadResolutionMention(text: string): boolean {
  return /<@[A-Z0-9]+>\s*(?:done|resolved|fixed|completed|handled|no need|not needed|stop follow(?:ing)? up|do not follow up)\b/i.test(text);
}

async function resolveTaskDraftFromTextOrThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
  text: string,
  clientName?: string,
  requester = "unknown"
): Promise<DraftTask | undefined> {
  const directDraft = parseNaturalTaskDraft(text, clientName);
  if (directDraft) {
    pendingTaskDrafts.set(`${channel}:${threadTs}`, { draft: directDraft, requester, updatedAt: Date.now() });
    return directDraft;
  }

  const priority = parsePriorityFromText(text);
  const dueDate = parseNaturalDueDate(text);
  if (!priority && !dueDate) return undefined;

  const key = `${channel}:${threadTs}`;
  const pending = pendingTaskDrafts.get(key);
  if (pending && Date.now() - pending.updatedAt < 60 * 60 * 1000) {
    const draft = {
      ...pending.draft,
      priority: priority ?? pending.draft.priority,
      dueDate: dueDate ?? pending.draft.dueDate
    };
    pendingTaskDrafts.delete(key);
    return draft;
  }

  const threadDraft = await findTaskDraftInThread(client, channel, threadTs, clientName, text);
  if (!threadDraft) return undefined;
  pendingTaskDrafts.delete(key);
  return threadDraft;
}

async function findTaskDraftInThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
  clientName: string | undefined,
  currentText: string
): Promise<DraftTask | undefined> {
  try {
    const response = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
    const humanMessages = (response.messages ?? [])
      .filter((message) => !message.bot_id && message.text)
      .map((message) => message.text ?? "");

    for (const message of humanMessages) {
      const draft = parseNaturalTaskDraft(`${message}\n${currentText}`, clientName);
      if (draft) return draft;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function handleChannelThreadContinuation(
  client: SlackClient,
  message: { channel: string; text: string; ts?: string; threadTs: string; user?: string }
): Promise<boolean> {
  if (!message.ts) return false;
  if (/<@[A-Z0-9]+>/i.test(message.text)) return false;

  let thread;
  try {
    thread = await client.conversations.replies({ channel: message.channel, ts: message.threadTs, limit: 20 });
  } catch {
    return false;
  }

  const messages = thread.messages ?? [];
  const botIsInThread = messages.some((candidate) => candidate.bot_id);
  const parentMentionedViktor = Boolean(messages[0]?.text && hasViktorMention(messages[0].text));
  if (!botIsInThread && !parentMentionedViktor) return false;

  const threadIsClientFollowUp = messages
    .filter((candidate) => !candidate.bot_id && candidate.text)
    .some((candidate) => isPassiveFollowUpHandoff(candidate.text ?? ""));
  if (threadIsClientFollowUp) return true;

  if (await handleLastDataExportRequest(client, message.text, message.channel, message.threadTs)) {
    return true;
  }

  const channelInfo = await getChannelInfo(client, message.channel);
  const inferredClient = channelInfo?.name ? await inferClientFromChannelName(channelInfo.name) : undefined;
  if (looksLikeQuestionForViktor(message.text)) {
    const answer = await answerWithAgentContext(client, message.channel, message.text, {
      channelName: channelInfo?.name,
      inferredClient,
      threadTs: message.threadTs
    });
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.threadTs,
      text: answer
    });
    return true;
  }

  return false;
}

async function postTaskProposal(
  client: SlackClient,
  channel: string,
  threadTs: string | undefined,
  draft: DraftTask,
  requester: string
) {
  const message = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Task proposal: ${draft.title}`,
    blocks: proposalBlocks(draft, "pending")
  }) as { ts?: string };

  if (!message.ts) {
    throw new Error("Slack did not return a message timestamp.");
  }

  const proposal = createProposal({
    channel,
    messageTs: message.ts,
    requester,
    draft
  });

  await client.chat.update({
    channel,
    ts: message.ts,
    text: `Task proposal: ${draft.title}`,
    blocks: proposalBlocks(draft, proposal.id)
  });
}

function parseNaturalTaskDraft(text: string, clientName?: string): DraftTask | undefined {
  const explicitTitle = extractTaskField(text, ["task name", "task title", "title"]);
  if (explicitTitle && /\b(create|make|add|set up|open)\b[\s\S]{0,120}\b(task|ticket)\b|\btask\s+name\s*:/i.test(text)) {
    return {
      title: cleanTaskTitle(explicitTitle),
      description: extractTaskField(text, ["task description", "description"]) ?? text.trim(),
      dueDate: parseNaturalDueDate(text),
      assigneeNames: extractAssignees(text),
      priority: parsePriorityFromText(text) ?? 3,
      targetListName: clientName ?? extractClientNameForTask(text),
      category: extractTaskCategory(text)
    };
  }

  if (isCreateTaskCommand(text)) {
    const draft = parseTaskDraft(text);
    return {
      ...draft,
      targetListName: draft.targetListName ?? clientName,
      priority: draft.priority ?? parsePriorityFromText(text) ?? 3,
      dueDate: draft.dueDate ?? parseNaturalDueDate(text)
    };
  }

  if (!/\b(create|make|add|set up|open)\b[\s\S]{0,80}\b(task|ticket)\b|\b(task|ticket)\b[\s\S]{0,40}\b(create|make|add|set up|open)\b/i.test(text)) {
    return undefined;
  }

  const title = extractNaturalTaskTitle(text);
  if (!title) return undefined;

  return {
    title,
    description: text.trim(),
    dueDate: parseNaturalDueDate(text),
    assigneeNames: extractAssignees(text),
    priority: parsePriorityFromText(text) ?? 3,
    targetListName: clientName ?? extractClientNameForTask(text),
    category: extractTaskCategory(text)
  };
}

function extractTaskField(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const labelPattern = label.replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`\\b${labelPattern}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:task\\s+name|task\\s+title|title|task\\s+description|description|category|assignee|assigned\\s+to|client|project|list)\\s*:|$)`, "i");
    const value = text.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function extractNaturalTaskTitle(text: string): string | undefined {
  const quoted = text.match(/\b(?:called|named|titled)\s+["“]([^"”]+)["”]/i)?.[1];
  if (quoted) return cleanTaskTitle(quoted);

  const called = text.match(/\b(?:called|named|titled)\s+(.+?)(?:\s+(?:for|due|with|priority|assigned|assignee|this week|today|tomorrow)\b|[.!?]|$)/i)?.[1];
  if (called) return cleanTaskTitle(called);

  const afterTask = text.match(/\b(?:create|make|add|set up|open)\s+(?:a\s+)?(?:task|ticket)\s+(?:to\s+)?(.+?)(?:\s+(?:for|due|with|priority|assigned|assignee|this week|today|tomorrow)\b|[.!?]|$)/i)?.[1];
  if (afterTask) return cleanTaskTitle(afterTask);

  return undefined;
}

function cleanTaskTitle(value: string): string {
  return value
    .replace(/^called\s+/i, "")
    .replace(/\s*\|\s*.*$/s, "")
    .replace(/^["“]|["”]$/g, "")
    .trim() || "Untitled task";
}

function parsePriorityFromText(text: string): DraftTask["priority"] | undefined {
  if (/\burgent\b/i.test(text)) return 1;
  if (/\bhigh\b/i.test(text)) return 2;
  if (/\b(normal|medium)\b/i.test(text)) return 3;
  if (/\blow\b/i.test(text)) return 4;
  return undefined;
}

function parseNaturalDueDate(text: string): number | undefined {
  if (/\bthis week\b/i.test(text)) return endOfCurrentWeek().getTime();
  if (/\b(?:next|coming)\s+week\b/i.test(text)) return endOfNextWeek().getTime();
  const explicit = text.match(/\bdue\s+(?:on\s+|by\s+)?([^|.,\n]+)/i)?.[1];
  if (explicit) return parseDueDate(explicit.trim());

  const relative = text.match(/\b(?:in|after|for)\s+(\d{1,5})\s*(days?|d|weeks?|w)\s*(?:after|later|from now)?\b|\b(\d{1,5})\s*(days?|d|weeks?|w)\s+after\b/i);
  const relativeText = relative?.[0];
  if (relativeText) return parseDueDate(relativeText);

  const date = text.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/i)?.[1];
  return date ? parseDueDate(date.trim()) : undefined;
}

function endOfCurrentWeek(): Date {
  const now = new Date();
  const end = new Date(now);
  const day = end.getDay();
  const fridayOffset = day <= 5 ? 5 - day : 12 - day;
  end.setDate(end.getDate() + fridayOffset);
  end.setHours(23, 59, 59, 999);
  return end;
}

function endOfNextWeek(): Date {
  const end = endOfCurrentWeek();
  end.setDate(end.getDate() + 7);
  return end;
}

function extractAssignees(text: string): string[] {
  const assigneeText = text.match(/\b(?:assignee|assigned to|assign to)\s*:?\s*([^|.,\n]+)/i)?.[1];
  if (!assigneeText) return [];
  return assigneeText.split(/,| and /i).map((name) => name.trim()).filter(Boolean);
}

function extractClientNameForTask(text: string): string | undefined {
  const client = text.match(/\bclient\s*:?\s*([^|.,\n]+)/i)?.[1]
    ?? text.match(/\b(?:for|project|list)\s+([a-z0-9][a-z0-9 &.'-]{2,}?)(?=\s+(?:task\s+name|task\s+description|category|assignee|due|priority)\b|[.,\n]|$)/i)?.[1];
  return client?.trim();
}

function extractTaskCategory(text: string): string | undefined {
  const category = text.match(/\bcategory\s*:?\s*([^|.,\n]+)/i)?.[1];
  return category?.trim();
}

function parseChannelMessageCommand(text: string): MessageCommand | undefined {
  const normalized = text.trim();
  if (/\b(send|show|get|fetch)\s+me\s+(?:gsc|ga4|ga|analytics|data|performance)\b/i.test(normalized)) {
    return undefined;
  }
  if (isClientLogIntent(normalized) || /\b(?:to|in|into)\s+(?:the\s+)?(?:client\s+)?log\b/i.test(normalized)) {
    return undefined;
  }
  const match = normalized.match(
    /^(?:hey\s+viktor[,.]?\s*)?(?:(?:go|post|send)\s+to\s+(?:channel\s+)?|(?:go|post|send)\s+(?:channel\s+))(?:<#([A-Z0-9]+)(?:\|([a-z0-9_-]+))?>|#([a-z0-9_-]+)|([a-z0-9_-]+))\s+(?:and\s+)?(?:(?:message|send|post)\s+)?([\s\S]+)$/i
  );

  const channelName = (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
  const message = match?.[5]?.trim();
  if (!channelName || !message) return undefined;

  return {
    channelName,
    message: cleanMessageInstruction(message),
    exact: /\b(exactly|verbatim|copy\s*paste|copy and paste|same message)\b/i.test(normalized)
  };
}

function parseNaturalMessageCommand(text: string): MessageCommand | undefined {
  const normalized = text.trim();
  if (normalized.length > 700) return undefined;
  if (/\b(?:fetch|show|get|summarize|read|search|find|create|update|close|comment|workload|overdue|report|alert)\b/i.test(normalized)) {
    return undefined;
  }

  const match = normalized.match(
    /^(?:hey\s+viktor[,.]?\s*)?(?:please\s+)?(?:tell|message|dm|ping|let)\s+(.+?)\s+(?:know\s+)?(?:that\s+|saying\s+|to\s+)?([\s\S]+)$/i
  );
  if (!match) return undefined;

  const rawTargets = match[1]?.trim();
  const message = match[2]?.trim();
  if (!rawTargets || !message) return undefined;
  if (/^(me|us|everyone|all|the team)$/i.test(rawTargets)) return undefined;

  const targets = splitMessageTargets(rawTargets);
  if (!targets.length) return undefined;

  return {
    targets,
    message: cleanMessageInstruction(message),
    exact: /\b(exactly|verbatim|copy\s*paste|copy and paste|same message)\b/i.test(normalized)
  };
}

function splitMessageTargets(rawTargets: string): string[] {
  return rawTargets
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => target.replace(/^to\s+/i, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function cleanMessageInstruction(message: string): string {
  return message.replace(/^(exactly|verbatim|copy\s*paste|copy and paste)\s+/i, "").trim();
}

async function sendChannelMessage(
  client: SlackClient,
  command: MessageCommand,
  conversationId: string
) {
  const prepared = await prepareChannelMessage(client, command, conversationId);
  await sendPreparedChannelMessage(client, prepared);
}

async function prepareChannelMessage(
  client: SlackClient,
  command: MessageCommand,
  conversationId: string
) : Promise<PreparedChannelMessage> {
  const rawTargets = command.targets?.length ? command.targets : command.channelName ? [command.channelName] : [];
  const targets: PreparedMessageTarget[] = [];

  for (const rawTarget of rawTargets) {
    targets.push(await resolveMessageTarget(client, rawTarget));
  }

  if (!targets.length) {
    throw new Error("I could not find a Slack channel or person to send this to.");
  }

  const users = await listWorkspaceUsers(client);
  const channelName = targets.length === 1
    ? targets[0].channelName
    : targets.map(formatMessageTargetLabel).join(", ");
  const text = await composeSlackMessage({
    conversationId,
    channelName,
    instruction: command.message,
    exact: command.exact,
    availableUsers: users
  });

  const primary = targets[0];
  return {
    ...primary,
    text,
    targets
  };
}

async function sendPreparedChannelMessage(
  client: SlackClient,
  prepared: PreparedChannelMessage
) {
  const targets = prepared.targets?.length ? prepared.targets : [prepared];
  for (const target of targets) {
    if (target.isMember === false) {
      if (target.isPrivate) {
        throw new Error(`I cannot join private channel #${target.channelName} myself. Invite Viktor there first.`);
      }

      const joined = await client.conversations.join({ channel: target.channelId });
      if (joined.error && joined.error !== "already_in_channel") {
        throw new Error(`I could not join #${target.channelName}: ${joined.error}`);
      }
    }

    await client.chat.postMessage({
      channel: target.channelId,
      text: prepared.text
    });
  }
}

async function resolveMessageTarget(client: SlackClient, rawTarget: string): Promise<PreparedMessageTarget> {
  const cleaned = rawTarget.trim();
  const channelMention = cleaned.match(/^<#([A-Z0-9]+)(?:\|([a-z0-9_-]+))?>$/i);
  const userMention = cleaned.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);

  if (channelMention?.[1]) {
    const channel = await findChannelByName(client, channelMention[1]);
    if (!channel?.id) throw new Error(`Could not find channel ${cleaned}.`);
    return {
      channelId: channel.id,
      channelName: channel.name ?? channelMention[2] ?? channelMention[1],
      isMember: channel.is_member,
      isPrivate: channel.is_private,
      kind: "channel"
    };
  }

  if (userMention?.[1]) {
    return openDirectMessageTarget(client, userMention[1], cleaned);
  }

  if (cleaned.startsWith("#")) {
    const channelName = cleaned.replace(/^#/, "");
    const channel = await findChannelByName(client, channelName);
    if (!channel?.id) throw new Error(`Could not find channel #${channelName}.`);
    return {
      channelId: channel.id,
      channelName: channel.name ?? channelName,
      isMember: channel.is_member,
      isPrivate: channel.is_private,
      kind: "channel"
    };
  }

  const channel = await findChannelByName(client, cleaned);
  if (channel?.id) {
    return {
      channelId: channel.id,
      channelName: channel.name ?? cleaned,
      isMember: channel.is_member,
      isPrivate: channel.is_private,
      kind: "channel"
    };
  }

  const user = await findWorkspaceUser(client, cleaned);
  if (!user?.id) throw new Error(`Could not find Slack channel or user "${cleaned}".`);
  return openDirectMessageTarget(client, user.id, user.name);
}

async function openDirectMessageTarget(client: SlackClient, userId: string, label: string): Promise<PreparedMessageTarget> {
  const dm = await client.conversations.open({ users: userId });
  if (!dm.channel?.id) throw new Error(`Could not open a DM with ${label}.`);
  return {
    channelId: dm.channel.id,
    channelName: label.startsWith("@") ? label : `@${label}`,
    kind: "dm"
  };
}

async function findWorkspaceUser(client: SlackClient, name: string): Promise<{ id: string; name: string } | undefined> {
  const normalized = normalizeLoose(name.replace(/^@/, ""));
  const users = await listWorkspaceUsers(client);
  return users.find((user) => normalizeLoose(user.name) === normalized)
    ?? users.find((user) => normalizeLoose(user.name).split(/\s+/).includes(normalized))
    ?? users.find((user) => normalizeLoose(user.name).includes(normalized));
}

function formatMessageTargetLabel(target: PreparedMessageTarget): string {
  return target.kind === "dm" ? target.channelName : `#${target.channelName}`;
}

async function postMessageProposal(
  client: SlackClient,
  proposalChannel: string,
  threadTs: string | undefined,
  command: MessageCommand,
  requester: string,
  conversationId: string
) {
  const prepared = await prepareChannelMessage(client, command, conversationId);
  const targetLabel = prepared.targets?.length
    ? prepared.targets.map(formatMessageTargetLabel).join(", ")
    : formatMessageTargetLabel(prepared);

  if (prepared.targets?.length && isTrustedMessageRoute(requester, prepared.targets)) {
    await sendPreparedChannelMessage(client, prepared);
    await client.chat.postMessage({
      channel: proposalChannel,
      thread_ts: threadTs,
      text: `Trusted route matched. Sent to ${targetLabel}.`
    });
    return;
  }

  const message = await client.chat.postMessage({
    channel: proposalChannel,
    thread_ts: threadTs,
    text: `Message proposal for ${targetLabel}`,
    blocks: messageProposalBlocks({
      channelId: prepared.channelId,
      channelName: prepared.channelName,
      isMember: prepared.isMember,
      isPrivate: prepared.isPrivate,
      text: prepared.text,
      targets: prepared.targets
    }, "pending")
  }) as { ts?: string };

  if (!message.ts) {
    throw new Error("Slack did not return a message timestamp.");
  }

  const proposal = createMessageProposal({
    channel: proposalChannel,
    messageTs: message.ts,
    requester,
    message: {
      channelId: prepared.channelId,
      channelName: prepared.channelName,
      isMember: prepared.isMember,
      isPrivate: prepared.isPrivate,
      text: prepared.text,
      targets: prepared.targets
    }
  });

  await client.chat.update({
    channel: proposalChannel,
    ts: message.ts,
    text: `Message proposal for ${targetLabel}`,
    blocks: messageProposalBlocks(proposal.message, proposal.id)
  });
}

type ManualMonitoringRequest = {
  kind: "daily" | "weekly" | "monthly";
  mode: "alerts" | "summary";
  force?: boolean;
  teamName?: WorkflowTeam;
};

function parseMonitoringCommand(text: string): ManualMonitoringRequest | undefined {
  const normalized = text.trim().toLowerCase();
  const force = /\b(?:force|rerun|re-run|resend|again)\b/i.test(normalized);
  const teamName = parseWorkflowTeamTarget(normalized);
  if (teamName && /\bdaily\b/.test(normalized) && /\b(alert|alerts|report|workflow|check|monitoring)\b/.test(normalized)) {
    return { kind: "daily", mode: "alerts", force, teamName };
  }
  if (teamName && /\bweekly\b/.test(normalized) && /\b(report|summary|workflow|monitoring)\b/.test(normalized)) {
    return { kind: "weekly", mode: "summary", teamName };
  }
  if (teamName && /\bmonthly\b/.test(normalized) && /\b(report|summary|workflow|monitoring)\b/.test(normalized)) {
    return { kind: "monthly", mode: "summary", teamName };
  }
  if (/^(?:send\s+me\s+)?daily\s+alerts?\s+(?:for|of)\s+.+$/i.test(normalized)) return undefined;
  if (/^(?:(?:send\s+me|run|start|initiate|force|rerun|re-run|resend)\s+)?daily\s+(?:monitoring\s+)?(?:alerts?|report|workflow|check|monitoring)(?:\s+workflow)?(?:\s+(?:for\s+)?(?:all\s+)?clients?)?(?:\s+in\s+(?:the\s+)?respective\s+channels?)?(?:\s+again)?$/.test(normalized)) {
    return { kind: "daily", mode: "alerts", force };
  }
  if (/^(?:run\s+|send\s+|start\s+)?weekly\s+(?:summary|report|monitoring)(?:\s+(?:for\s+)?(?:all\s+)?clients?)?$/.test(normalized)) {
    return { kind: "weekly", mode: "summary" };
  }
  if (/^(?:run\s+|send\s+|start\s+)?monthly\s+(?:summary|report|monitoring)(?:\s+(?:for\s+)?(?:all\s+)?clients?)?$/.test(normalized)) {
    return { kind: "monthly", mode: "summary" };
  }
  if (/^check\s+(?:all\s+)?clients$/.test(normalized)) {
    return { kind: "daily", mode: "alerts" };
  }
  return undefined;
}

function parseDashboardWorkflowRunCommand(text: string): string | undefined {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!/^(?:run|send|start|trigger)\b/.test(normalized)) return undefined;
  if (parseWorkflowTeamTarget(normalized)) return undefined;
  if (/\bclickup\b/.test(normalized) && /\b(workload|summary|workflow)\b/.test(normalized)) return "global-clickup-workload";
  if (/\bweekly\b/.test(normalized) && /\b(report|summary|workflow)\b/.test(normalized)) return "global-weekly";
  if (/\bdaily\b/.test(normalized) && /\b(alert|alerts|report|workflow|monitoring)\b/.test(normalized)) return "global-daily";
  return undefined;
}

function parseWorkflowTeamTarget(text: string): WorkflowTeam | undefined {
  const match = text.match(/\bteam\s*(ab|cd|[a-d])\b/i) ?? text.match(/\bonly\s+(ab|cd|[a-d])\b/i);
  if (!match?.[1]) return undefined;
  return normalizeWorkflowTeam(`Team ${match[1]}`);
}

async function runManualMonitoringCommand(
  client: SlackClient,
  request: ManualMonitoringRequest,
  replyChannel: string,
  threadTs?: string
) {
  await runWithManualPriority(async () => {
    if (request.kind === "daily" && hasDailyMonitoringRunToday() && !request.force && !request.teamName) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: "Daily monitoring has already been sent today, so I did not post the same alerts again. Say `rerun daily monitoring` if you intentionally want a fresh repost."
      });
      return;
    }
    if (request.kind === "daily" && scheduledMonitoringRunning && !request.teamName && !request.force) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: "Daily monitoring is currently checking clients. Wait a few minutes, then ask me to send the daily alert again."
      });
      return;
    }

    const health = await checkGoogleApiHealth();
    if (!health.ok) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: googleHealthMessage(health.error, health.userAction)
      });
      return;
    }

    const preparedDaily = request.kind === "daily" && !request.teamName && !request.force ? getPreparedDailyReport() : undefined;
    if (request.kind === "daily" && !request.teamName && !request.force && !preparedDaily) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: "Daily monitoring has not finished preparing today's results yet. Wait a few minutes, then ask me to send the daily alert again."
      });
      return;
    }
    const report = request.kind === "daily"
      ? preparedDaily ?? await runDailyMonitoring({ teamName: request.teamName })
      : request.kind === "weekly"
        ? await runWeeklySummary({ teamName: request.teamName })
        : await runMonthlySummary({ teamName: request.teamName });
    await sendMonitoringReport(client, report, request.mode);
    if (request.kind === "daily" && report.alerts.length) {
      await markMonitoringAlertsSent(report.alerts);
      if (preparedDaily) {
        latestDailyPreparedReport = undefined;
        latestDailyPreparedAt = 0;
      }
    }
    if (!request.teamName) {
      await markWorkflowRun(`global-${request.kind}`);
    }
    await client.chat.postMessage({
      channel: replyChannel,
      thread_ts: threadTs,
      text: request.kind === "daily"
        ? `Done. I ran daily monitoring${request.teamName ? ` for ${request.teamName}` : ""} and posted any new anomalies to the mapped team alert channels.`
        : `Done. I sent the ${request.kind} performance summary${request.teamName ? ` for ${request.teamName}` : ""} to the mapped team alert channels.`
    });
  });
}

async function handleScheduledWorkflowCommand(
  client: SlackClient,
  text: string,
  replyChannel: string,
  user?: string,
  threadTs?: string
): Promise<string | undefined> {
  const trimmed = text.trim();
  if (/^(?:list|show)\s+workflows?$/i.test(trimmed)) return formatScheduledWorkflows();

  const pause = trimmed.match(/^(?:pause|disable)\s+workflow\s+([a-z0-9-]+)$/i);
  if (pause?.[1]) {
    const workflow = await setScheduledWorkflowStatus(pause[1], "paused");
    return workflow ? `Paused ${formatScheduledWorkflow(workflow)}.` : `I could not find workflow ${pause[1]}.`;
  }

  const resume = trimmed.match(/^(?:resume|enable)\s+workflow\s+([a-z0-9-]+)$/i);
  if (resume?.[1]) {
    const workflow = await setScheduledWorkflowStatus(resume[1], "active");
    return workflow ? `Resumed ${formatScheduledWorkflow(workflow)}.` : `I could not find workflow ${resume[1]}.`;
  }

  const remove = trimmed.match(/^(?:delete|remove)\s+workflow\s+([a-z0-9-]+)$/i);
  if (remove?.[1]) {
    const workflow = await deleteScheduledWorkflow(remove[1]);
    return workflow ? `Deleted workflow ${workflow.id}.` : `I could not find workflow ${remove[1]}.`;
  }

  const runNow = trimmed.match(/^run\s+workflow\s+([a-z0-9-]+)\s+now$/i);
  if (runNow?.[1]) {
    const workflow = getScheduledWorkflow(runNow[1]);
    if (!workflow) return `I could not find workflow ${runNow[1]}.`;
    const result = await runScheduledWorkflow(client, workflow, true);
    return result || `Ran ${formatScheduledWorkflow(workflow)}.`;
  }

  const create = parseScheduledWorkflowRequest(trimmed, user);
  if (create) {
    const workflow = await createScheduledWorkflow(create);
    return [
      `Created workflow: ${formatScheduledWorkflow(workflow)}.`,
      "This uses Viktor's existing report/follow-up formats; it does not replace the current global monitoring schedule."
    ].join("\n");
  }

  if (/\bworkflows?\b/i.test(trimmed)) {
    return [
      "Workflow commands:",
      "- `enable daily monitoring for Client Name in #channel at 9am`",
      "- `enable weekly summary for Client Name in #channel every Monday at 10am`",
      "- `enable monthly summary for Client Name in #channel on day 1 at 9am`",
      "- `enable followup scan in #channel at 10am`",
      "- `list workflows`, `pause workflow <id>`, `resume workflow <id>`, `delete workflow <id>`, `run workflow <id> now`"
    ].join("\n");
  }

  return undefined;
}

function parseScheduledWorkflowRequest(text: string, user?: string): Parameters<typeof createScheduledWorkflow>[0] | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const type = workflowTypeFromText(normalized);
  if (!type || !/^(?:enable|schedule|create|add|set up)\b/i.test(normalized)) return undefined;

  const channelName = normalized.match(/\bin\s+(?:channel\s+)?#?([a-z0-9_-]+)/i)?.[1];
  const clientName = type === "followup_scan" ? undefined : normalized.match(/\bfor\s+(.+?)(?:\s+in\s+(?:channel\s+)?#?[a-z0-9_-]+|\s+every\s+|\s+on\s+day\s+|\s+at\s+|$)/i)?.[1]?.trim();
  const time = parseWorkflowTime(normalized) ?? { hour: config.MONITORING_DAILY_HOUR, minute: 0 };
  const dayOfWeek = parseWorkflowDay(normalized);
  const dayOfMonth = Number(normalized.match(/\bon\s+day\s+(\d{1,2})\b/i)?.[1] ?? "1");
  const frequency = type === "weekly_performance_summary"
    ? "weekly"
    : type === "monthly_performance_summary"
      ? "monthly"
      : "daily";

  if (type !== "followup_scan" && !clientName) return undefined;

  return {
    type,
    clientName,
    channelName,
    createdBy: user,
    schedule: {
      frequency,
      hour: time.hour,
      minute: time.minute,
      ...(frequency === "weekly" ? { dayOfWeek: dayOfWeek ?? config.MONITORING_WEEKLY_DAY } : {}),
      ...(frequency === "monthly" ? { dayOfMonth: Math.min(28, Math.max(1, dayOfMonth || 1)) } : {})
    }
  };
}

function workflowTypeFromText(text: string): ScheduledWorkflowType | undefined {
  if (/\bfollow-?up\s+scan\b/i.test(text)) return "followup_scan";
  if (/\bmonthly\b/i.test(text)) return "monthly_performance_summary";
  if (/\bweekly\b/i.test(text)) return "weekly_performance_summary";
  if (/\bdaily\b/i.test(text)) return "daily_monitoring_alerts";
  return undefined;
}

function parseWorkflowTime(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match?.[1]) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return { hour, minute };
}

function parseWorkflowDay(text: string): number | undefined {
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const match = text.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  return match?.[1] ? days.indexOf(match[1].toLowerCase()) : undefined;
}

async function runOptInScheduledWorkflows(client: SlackClient, logger: BotLogger) {
  if (hasManualPriority()) return;
  const due = dueScheduledWorkflows().filter((workflow) => workflow.type === "followup_scan");
  for (const workflow of due) {
    try {
      await runScheduledWorkflow(client, workflow, false);
      await markScheduledWorkflowRun(workflow.id);
    } catch (error) {
      logger.error(error);
    }
  }
}

async function runScheduledWorkflow(client: SlackClient, workflow: ScheduledWorkflow, manual: boolean): Promise<string | undefined> {
  const fallbackChannel = getReportChannel();
  const requestedChannel = workflow.channelName || fallbackChannel;
  if (!requestedChannel) return "This workflow needs a channel or fallback report channel.";
  const channel = await findChannelByName(client, requestedChannel)
    ?? (fallbackChannel && fallbackChannel !== requestedChannel ? await findChannelByName(client, fallbackChannel) : undefined);
  if (!channel?.id && !channel?.name) {
    return fallbackChannel && fallbackChannel !== requestedChannel
      ? `I could not find #${requestedChannel} or fallback #${fallbackChannel}.`
      : `I could not find #${requestedChannel}.`;
  }
  const postedChannelName = channel.name ?? requestedChannel;
  const usedFallback = Boolean(workflow.channelName && fallbackChannel && postedChannelName !== workflow.channelName.replace(/^#/, ""));

  if (workflow.type === "followup_scan") {
    const candidates = findFollowUpCandidates({ limit: 10 });
    const text = await formatFollowUpReport(client, candidates, manual);
    if (text) await postToChannel(client, channel, text);
    return candidates.length
      ? `Posted ${candidates.length} follow-up candidate(s) to #${postedChannelName}${usedFallback ? ` because #${workflow.channelName} was not available` : ""}.`
      : "No follow-up candidates found.";
  }

  if (!workflow.clientName) return "This workflow needs a client name.";
  const report = workflow.type === "daily_monitoring_alerts"
    ? await runDailyMonitoring({ clientName: workflow.clientName })
    : workflow.type === "weekly_performance_summary"
      ? await runWeeklySummary({ clientName: workflow.clientName })
      : await runMonthlySummary({ clientName: workflow.clientName });
  const mode = workflow.type === "daily_monitoring_alerts" ? "alerts" : "summary";
  const body = await formatWorkflowReportText(report, workflow.clientName, mode);
  if (workflow.type === "daily_monitoring_alerts" && report.alerts.length) await markMonitoringAlertsSent(report.alerts);
  if (body) {
    if (mode === "alerts") await postThreadedMonitoringSummary(client, channel, body);
    else await postToChannel(client, channel, body);
  }
  return body
    ? `Posted ${workflow.type} for ${workflow.clientName} to #${postedChannelName}${usedFallback ? ` because #${workflow.channelName} was not available` : ""}.`
    : `No new daily anomalies for ${workflow.clientName}.`;
}

async function runDashboardWorkflow(id: string): Promise<string> {
  const client = app.client as SlackClient;
  if (id === "global-daily") {
    return runWithManualPriority(async () => {
      if (scheduledMonitoringRunning) {
        return "Daily monitoring is currently checking clients. Wait a few minutes, then press Send again.";
      }

      const health = await checkGoogleApiHealth();
      if (!health.ok) return googleHealthMessage(health.error, health.userAction);

      const prepared = getPreparedDailyReport();
      const report = prepared ?? await prepareDashboardDailyReport();
      if (report.paused) return "Daily monitoring paused because another manual request started. Press Send again in a moment.";
      if (!report.alerts.length) {
        await markWorkflowRun("global-daily");
        return "No daily GSC/GA4 anomalies are available to send right now.";
      }

      const posted = await sendMonitoringReport(client, report, "alerts");
      if (!posted) {
        return `Daily monitoring found alerts for ${getReportClientsForMode(report, "alerts").length} client(s), but no mapped team alert channels were available to post them.`;
      }

      await markMonitoringAlertsSent(report.alerts);
      await markWorkflowRun("global-daily");
      if (prepared) {
        latestDailyPreparedReport = undefined;
        latestDailyPreparedAt = 0;
      }
      return `Sent daily monitoring alerts to ${posted} team post(s) for ${getReportClientsForMode(report, "alerts").length} client(s).`;
    });
  }

  if (id === "global-weekly") {
    if (dashboardWeeklyRunning) return "Weekly reports are already being prepared. This can take a while for all clients, so I did not start a duplicate send.";
    dashboardWeeklyRunning = true;
    void runDashboardWeeklyWorkflow(client).catch(logError);
    return "Weekly reports are being prepared in the background. Viktor will post them to the mapped team weekly channels when the full weekly report is ready.";
  }

  if (id === "global-clickup-workload") {
    const range = parseClickUpDateRange("current week");
    const matrix = await getAllTeamClickUpTasks(range);
    const posted = await postClickUpWorkloadDigestByTeam(client, matrix, range.label);
    await markAlerted(`clickup-workload:${localDateKey(new Date())}`);
    await markWorkflowRun("global-clickup-workload");
    return posted
      ? `Sent ClickUp workload to ${posted} team channel(s).`
      : "No team ClickUp workload channels were available.";
  }

  const workflow = getScheduledWorkflow(id);
  if (!workflow) return `I could not find workflow ${id}.`;
  const result = await runScheduledWorkflow(client, workflow, true);
  await markScheduledWorkflowRun(workflow.id);
  return result || `Workflow ${id} ran.`;
}

async function prepareDashboardDailyReport() {
  logInfo("Dashboard daily workflow preparing on demand.");
  return runDailyMonitoring({
    skipTechnical: true,
    excludeClientNames: activeWorkflowClientNames("daily_monitoring_alerts")
  });
}

async function runDashboardWeeklyWorkflow(client: SlackClient) {
  try {
    logInfo("Dashboard weekly workflow started.");
    for (const teamName of WORKFLOW_TEAMS) {
      logInfo(`Dashboard weekly workflow preparing ${teamName}.`);
      const report = await runWeeklySummary({ teamName });
      if (report.summary.length || report.alerts.length) {
        await sendMonitoringReport(client, report, "summary");
        logInfo(`Dashboard weekly workflow posted ${teamName}.`);
      } else {
        logInfo(`Dashboard weekly workflow found no content for ${teamName}.`);
      }
    }
    await markWorkflowRun("global-weekly");
    logInfo("Dashboard weekly workflow completed.");
  } catch (error) {
    logError(error);
  } finally {
    dashboardWeeklyRunning = false;
  }
}

async function markWorkflowRun(id: string) {
  await markAlerted(`workflow-run:${id}:${Date.now()}`);
}

async function formatWorkflowReportText(
  report: Awaited<ReturnType<typeof runDailyMonitoring>>,
  clientName: string,
  mode: "alerts" | "summary"
): Promise<string> {
  if (mode === "alerts" && !report.alerts.length) return "";
  return formatReportForClient(report, clientName, mode);
}

async function listWorkspaceUsers(client: SlackClient): Promise<Array<{ id: string; name: string }>> {
  const users: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;

  try {
    do {
      const response = await client.users.list({ cursor, limit: 200 });
      for (const member of response.members ?? []) {
        if (!member.id || member.deleted || member.is_bot) continue;
        users.push({
          id: member.id,
          name: member.real_name || member.name || member.id
        });
      }
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && users.length < 500);
  } catch {
    return [];
  }

  return users;
}

async function runScheduledFollowUpScan(client: SlackClient, logger: BotLogger) {
  await backfillMissedFollowUpMessages(client, logger);
  if (!isFollowUpOfficeHours(new Date())) return;

  try {
    const reminders = findDueThreadReminders(new Date(), 20);
    for (const reminder of reminders) {
      await postThreadReminder(client, reminder);
      await markThreadReminderDelivered(reminder.id);
    }

    const candidates = findFollowUpCandidates({ limit: 10 });
    if (!candidates.length) return;

    for (const candidate of candidates) {
      await postFollowUpInPlace(client, candidate);
      await markFollowUpAlerted(candidate);
    }
  } catch (error) {
    logger.error(error);
  }
}

function isFollowUpOfficeHours(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 8 && hour < 17;
}

async function backfillMissedFollowUpMessages(client: SlackClient, logger: BotLogger) {
  if (followUpBackfillRunning) return;
  followUpBackfillRunning = true;
  try {
    const channels = await followUpBackfillChannels(client);
    for (const channel of channels) {
      await backfillChannelMessages(client, channel);
    }
  } catch (error) {
    logger.error(error);
  } finally {
    followUpBackfillRunning = false;
  }
}

async function followUpBackfillChannels(client: SlackClient): Promise<Array<{ id: string; name?: string; isPrivate?: boolean; isMember?: boolean }>> {
  const clients = await loadClients();
  const workspaceChannels = await listBackfillWorkspaceChannels(client);
  const channels = new Map<string, { id: string; name?: string; isPrivate?: boolean; isMember?: boolean }>();

  for (const clientConfig of clients) {
    if (!clientConfig.slackChannel) continue;
    const target = normalizeSlackChannelName(clientConfig.slackChannel);
    const channel = workspaceChannels.find((item) => item.name && normalizeSlackChannelName(item.name) === target);
    if (!channel?.id) continue;
    channels.set(channel.id, {
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private,
      isMember: channel.is_member
    });
  }

  return [...channels.values()];
}

async function listBackfillWorkspaceChannels(client: SlackClient): Promise<Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }>> {
  const channels: Array<{ id?: string; name?: string; is_private?: boolean; is_member?: boolean }> = [];
  let cursor: string | undefined;

  do {
    const response = await client.conversations.list({
      cursor,
      exclude_archived: true,
      limit: 1000,
      types: "public_channel,private_channel"
    });
    channels.push(...(response.channels ?? []));
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

async function backfillChannelMessages(client: SlackClient, channel: { id: string; name?: string; isPrivate?: boolean; isMember?: boolean }) {
  const fallbackOldest = ((Date.now() - FOLLOWUP_BACKFILL_LOOKBACK_HOURS * 60 * 60 * 1000) / 1000).toFixed(6);

  let history;
  try {
    if (channel.isMember === false && !channel.isPrivate) {
      await client.conversations.join({ channel: channel.id });
    }
    history = await client.conversations.history({
      channel: channel.id,
      oldest: fallbackOldest,
      inclusive: false,
      limit: 100
    });
  } catch (error) {
    if (extractSlackErrorCode(error) === "not_in_channel") return;
    throw error;
  }
  const messages = (history.messages ?? [])
    .filter((message) => message.ts)
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  for (const message of messages) {
    await storeBackfilledSlackMessage(channel, message);
    await scheduleBackfilledThreadReminderIfNeeded(channel, message);
    if ((message.reply_count ?? 0) > 0 && message.ts) {
      await backfillThreadReplies(client, channel, message.ts);
    }
  }
}

async function backfillThreadReplies(client: SlackClient, channel: { id: string; isPrivate?: boolean }, threadTs: string) {
  const replies = await client.conversations.replies({
    channel: channel.id,
    ts: threadTs,
    limit: 50
  });
  const messages = (replies.messages ?? [])
    .filter((message) => message.ts)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const message of messages) {
    if (!message.ts || message.ts === threadTs) continue;
    await storeBackfilledSlackMessage(channel, message, threadTs);
  }
  for (const message of messages) {
    await scheduleBackfilledThreadReminderIfNeeded(channel, message, threadTs, messages);
  }
}

async function storeBackfilledSlackMessage(
  channel: { id: string; isPrivate?: boolean },
  message: { bot_id?: string; user?: string; text?: string; ts?: string; thread_ts?: string; files?: SlackFileRef[] },
  fallbackThreadTs?: string
) {
  if (!message.ts || (!message.text && !message.files?.length)) return;
  await rememberSlackMessage({
    channel: channel.id,
    channelType: channel.isPrivate ? "group" : "channel",
    user: message.user,
    botId: message.bot_id,
    text: [message.text, formatSlackFileMentions(message.files)].filter(Boolean).join(" "),
    ts: message.ts,
    threadTs: message.thread_ts ?? fallbackThreadTs,
    files: message.files,
    storedAt: new Date().toISOString()
  });
}

async function scheduleBackfilledThreadReminderIfNeeded(
  channel: { id: string; isPrivate?: boolean },
  message: { bot_id?: string; user?: string; text?: string; ts?: string; thread_ts?: string },
  fallbackThreadTs?: string,
  threadMessages: Array<{ bot_id?: string; user?: string; text?: string; ts?: string; thread_ts?: string }> = [message]
) {
  if (!message.ts || !message.text || message.bot_id || !message.user) return;
  if (!hasViktorMention(message.text)) return;

  const messageDate = slackTsToDate(message.ts);
  const reminder = parseThreadReminderRequest(message.text, messageDate);
  if (!reminder) return;

  const now = new Date();
  if (reminder.remindAt.getTime() < now.getTime() - FOLLOWUP_BACKFILL_LOOKBACK_HOURS * 60 * 60 * 1000) return;

  const threadTs = message.thread_ts ?? fallbackThreadTs ?? message.ts;
  if (hasLaterThreadReminderResolution(message, threadMessages)) return;

  const input = {
    channel: channel.id,
    threadTs,
    target: reminder.target,
    requester: message.user,
    message: reminder.message,
    remindAt: reminder.remindAt.toISOString()
  };
  if (hasSimilarThreadReminder(input)) return;

  await scheduleThreadReminder(input);
}

function hasLaterThreadReminderResolution(
  source: { ts?: string },
  threadMessages: Array<{ bot_id?: string; user?: string; text?: string; ts?: string }>
): boolean {
  const sourceTs = Number(source.ts);
  return threadMessages.some((message) => {
    if (!message.ts || Number(message.ts) <= sourceTs) return false;
    if (!message.text || message.bot_id || !message.user) return false;
    const mentionText = message.text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return hasThreadResolutionMention(message.text) ||
      isThreadResolutionOnly(mentionText) ||
      isFollowUpCancelRequest(mentionText);
  });
}

function slackTsToDate(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1000);
}

async function postThreadReminder(client: SlackClient, reminder: { channel: string; threadTs: string; target?: "thread" | "channel"; requester?: string; message: string; remindAt?: string }) {
  const who = reminder.requester ? `<@${reminder.requester}>` : "team";
  const lateByMinutes = reminder.remindAt ? Math.floor((Date.now() - Date.parse(reminder.remindAt)) / 60000) : 0;
  const isLateReminder = Number.isFinite(lateByMinutes) && lateByMinutes > Math.max(20, config.FOLLOWUP_SCAN_INTERVAL_MINUTES + 5);
  const post: Parameters<SlackClient["chat"]["postMessage"]>[0] = {
    channel: reminder.channel,
    text: isLateReminder
      ? `Follow-up reminder: ${who}, I was offline or unavailable at the requested time (${formatReminderDate(new Date(reminder.remindAt ?? Date.now()))}), but I’m following up now in case this reminder is still needed. ${reminder.message}\n\nIf this is already resolved, please reply with \`resolved\` or \`stop follow-up\`.`
      : `Follow-up reminder: ${who}, ${reminder.message}`
  };
  if (reminder.target !== "channel") post.thread_ts = reminder.threadTs;
  await client.chat.postMessage(post);
}

async function postFollowUpInPlace(client: SlackClient, candidate: FollowUpCandidate) {
  await client.chat.postMessage({
    channel: candidate.channel,
    thread_ts: candidate.threadTs ?? candidate.ts,
    text: `Follow-up check: this still looks unanswered (${candidate.reason}, ${candidate.ageMinutes}m old).`
  });
}

async function runScheduledMonitoring(client: SlackClient, logger: BotLogger) {
  if (hasManualPriority()) return false;
  if (scheduledMonitoringRunning) return false;

  scheduledMonitoringRunning = true;
  try {
    latestDailyPreparedReport = undefined;
    latestDailyPreparedAt = 0;
    const health = await checkGoogleApiHealth();
    if (!health.ok) {
      await notifyGoogleHealthIssue(client, health.error, health.userAction);
      return false;
    }

    await runDueMonitoring(async (report, mode) => {
      if (mode === "alerts") {
        latestDailyPreparedReport = report;
        latestDailyPreparedAt = Date.now();
      }
    }, {
      dryRun: true,
      skipTechnical: true,
      excludeClientNamesByKind: {
        daily: activeWorkflowClientNames("daily_monitoring_alerts"),
        weekly: activeWorkflowClientNames("weekly_performance_summary"),
        monthly: activeWorkflowClientNames("monthly_performance_summary")
      },
      skipScheduledSummaries: true,
      skipAlertSentMark: true,
      shouldPause: hasManualPriority
    });
    return true;
  } catch (error) {
    logger.error(error);
    return false;
  } finally {
    scheduledMonitoringRunning = false;
  }
}

async function runScheduledMonitoringIfDue(client: SlackClient, logger: BotLogger) {
  const slotKey = currentMonitoringSlotKey(new Date());
  if (!slotKey || hasAlerted(slotKey)) return;

  const completed = await runScheduledMonitoring(client, logger);
  if (completed) await markAlerted(slotKey);
}

function currentMonitoringSlotKey(now: Date): string | undefined {
  const intervalMinutes = config.MONITORING_CHECK_INTERVAL_MINUTES;
  const elapsedMinutes = Math.max(0, Math.floor((Number(now) - monitoringRuntimeStartedAt) / 60000));
  const slotIndex = Math.floor(elapsedMinutes / intervalMinutes);
  const minutesIntoSlot = elapsedMinutes - slotIndex * intervalMinutes;
  if (minutesIntoSlot >= 60) return undefined;

  return `monitoring-runtime-slot:${monitoringRuntimeId}:${String(slotIndex).padStart(3, "0")}`;
}

function getPreparedDailyReport(): Awaited<ReturnType<typeof runDailyMonitoring>> | undefined {
  if (!latestDailyPreparedReport || !latestDailyPreparedAt) return undefined;
  if (localDateKey(new Date(latestDailyPreparedAt)) !== localDateKey(new Date())) return undefined;
  return latestDailyPreparedReport;
}

async function notifyGoogleHealthIssue(client: SlackClient, error?: string, userAction?: string) {
  const key = `google-health:${localDateKey(new Date())}:${error ?? "unknown"}`;
  if (hasAlerted(key)) return;

  const recipient = getMostRecentDmUser();
  const target = recipient || getReportChannel();
  if (!target) return;

  await client.chat.postMessage({
    channel: target,
    text: googleHealthMessage(error, userAction)
  });
  await markAlerted(key);
}

async function runScheduledClickUpWorkload(client: SlackClient, logger: BotLogger) {
  const now = new Date();
  if (now.getHours() !== CLICKUP_WORKLOAD_HOUR) return;
  const key = `clickup-workload:${localDateKey(now)}`;
  if (hasAlerted(key) || scheduledClickUpWorkloadRunning) return;

  scheduledClickUpWorkloadRunning = true;
  try {
    await markAlerted(key);
    const range = parseClickUpDateRange("current week");
    const matrix = await getAllTeamClickUpTasks(range);
    await postClickUpWorkloadDigestByTeam(client, matrix, range.label);
  } catch (error) {
    logger.error(error);
  } finally {
    scheduledClickUpWorkloadRunning = false;
  }
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localWeekKey(date: Date): string {
  const firstDay = new Date(date.getFullYear(), 0, 1);
  const localDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfYear = Math.floor((Number(localDay) - Number(firstDay)) / 86400000);
  const week = Math.ceil((dayOfYear + firstDay.getDay() + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monitoringSummaryPostKey(reportTitle: string, clientName: string): string | undefined {
  const normalizedClient = normalizeLoose(clientName).replace(/\s+/g, "-");
  const title = reportTitle.toLowerCase();
  if (title.includes("weekly")) return `weekly-report-posted:${localWeekKey(new Date())}:${normalizedClient}`;
  if (title.includes("monthly")) return `monthly-report-posted:${localDateKey(new Date()).slice(0, 7)}:${normalizedClient}`;
  return undefined;
}

async function postClickUpWorkloadDigestByTeam(
  client: SlackClient,
  matrix: Array<{ team: string; tasks: ClickUpHealthTask[] }>,
  rangeLabel: string
): Promise<number> {
  let posted = 0;
  for (const entry of matrix) {
    const channelName = teamWorkflowChannelName(entry.team, "clickup");
    if (!channelName) continue;
    const channel = await findChannelByName(client, channelName);
    if (!channel?.id && !channel?.name) continue;
    await postToChannel(client, channel, formatClickUpTeamStatusMatrix(`ClickUp workload - ${entry.team}`, [entry], { rangeLabel }));
    posted += 1;
  }
  return posted;
}

function googleHealthMessage(error?: string, userAction?: string): string {
  return [
    "*Viktor Google API check failed*",
    "I skipped scheduled GSC/GA4 monitoring so I do not send inaccurate or noisy client alerts.",
    `Error: ${error ?? "Unknown Google API error"}`,
    userAction ? `Action needed: ${userAction}` : undefined
  ].filter(Boolean).join("\n");
}

async function sendMonitoringReport(
  client: SlackClient,
  report: Awaited<ReturnType<typeof runDailyMonitoring>>,
  mode: "alerts" | "summary"
): Promise<number> {
  const clients = await loadClients();
  const reportClientNames = getReportClientsForMode(report, mode);
  let posted = 0;

  for (const clientName of reportClientNames) {
    const clientConfig = clients.find((item) => item.client === clientName);
    const channelName = clientConfig ? teamWorkflowChannelName(clientConfig.team, mode === "alerts" ? "daily" : "weekly") : undefined;
    if (!channelName) continue;
    const channel = await findChannelByName(client, channelName);
    if (!channel?.id && !channel?.name) continue;
    const text = await formatReportForClient(report, clientName, mode);
    if (!text.replace(/\*/g, "").trim().replace(`${report.title} - ${clientName}`, "").trim()) continue;
    const summaryPostKey = mode === "summary" ? monitoringSummaryPostKey(report.title, clientName) : undefined;
    if (summaryPostKey && hasAlerted(summaryPostKey)) continue;
    if (summaryPostKey) await markAlerted(summaryPostKey);

    await postThreadedMonitoringSummary(client, channel, text);
    posted += 1;
  }

  return posted;
}

async function postThreadedMonitoringSummary(
  client: SlackClient,
  channel: { id?: string; name?: string; is_member?: boolean; is_private?: boolean },
  text: string
) {
  const split = splitMonitoringSummaryForThread(text);
  const posted = await postToChannel(client, channel, split.main);
  const threadTs = getSlackMessageTs(posted);
  const channelId = posted.id ?? channel.id ?? channel.name ?? "";
  if (threadTs && channelId) {
    for (const reply of split.replies) {
      for (const chunk of chunkSlackText(reply, 35000)) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: chunk });
      }
    }
  }
  return posted;
}

async function handleWorkflowThreadForwardRequest(
  client: SlackClient,
  sourceChannel: string,
  threadTs: string,
  requestTs: string,
  text: string
): Promise<string | undefined> {
  if (!isWorkflowThreadForwardRequest(text)) return undefined;

  const response = await client.conversations.replies({ channel: sourceChannel, ts: threadTs, limit: 50 });
  const messages = response.messages ?? [];
  const parent = messages[0];
  const clientName = parseMonitoringThreadClientName(parent?.text ?? "");
  if (!clientName) return "I could not identify which client this alert belongs to, so I did not forward it.";

  const clients = await loadClients();
  const clientConfig = clients.find((item) => normalizeLoose(item.client) === normalizeLoose(clientName));
  if (!clientConfig) return `I could not find ${clientName} in client mappings, so I did not forward it.`;

  const targetChannel = await findChannelForClient(client, clientConfig);
  if (!targetChannel?.id && !targetChannel?.name) return `I could not find the mapped client channel for ${clientConfig.client}.`;

  const parentText = parent?.text?.trim();
  if (!parentText) return "The alert text was empty, so I did not forward it.";

  const posted = await postToChannel(client, targetChannel, parentText);
  const postedThreadTs = getSlackMessageTs(posted);
  const channelId = posted.id ?? targetChannel.id ?? targetChannel.name ?? "";
  if (postedThreadTs && channelId) {
    const replyMessages = messages.filter((message) =>
      Boolean(message.bot_id && message.text?.trim() && message.ts && Number(message.ts) > Number(threadTs) && Number(message.ts) < Number(requestTs))
    );
    for (const message of replyMessages) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: postedThreadTs,
        text: message.text ?? ""
      });
    }
  }

  return `Sent this alert to #${targetChannel.name ?? clientConfig.slackChannel}.`;
}

function isWorkflowThreadForwardRequest(text: string): boolean {
  return /\b(?:send|post|share|forward)\b[\s\S]{0,80}\b(?:this|it|alert|report)?[\s\S]{0,80}\b(?:to|in)\s+(?:the\s+)?(?:client\s+)?channel\b/i.test(text)
    || /\bsend\s+(?:this|it)\s+to\s+channel\b/i.test(text);
}

function parseMonitoringThreadClientName(text: string): string | undefined {
  const match = text.match(/\*(?:Daily monitoring|Weekly performance summary|Monthly performance summary)\s+-\s+([^*\n]+)\*/i)
    ?? text.match(/(?:Daily monitoring|Weekly performance summary|Monthly performance summary)\s+-\s+([^\n]+)/i);
  return match?.[1]?.trim();
}

function splitMonitoringSummaryForThread(text: string): { main: string; replies: string[] } {
  const lines = text.split(/\r?\n/);
  const gscStart = lines.findIndex((line) => /^\*GSC performance\b/i.test(line));
  const gaStart = lines.findIndex((line) => /^\*GA4 performance\b/i.test(line));
  if (gscStart === -1 && gaStart === -1) return { main: text, replies: [] };

  const starts = [gscStart, gaStart].filter((index) => index >= 0);
  const firstPerformance = Math.min(...starts);
  const preface = lines.slice(0, firstPerformance).join("\n").trim();
  const gscEnd = gscStart >= 0
    ? firstSectionIndex(lines, gscStart + 1, [/^Likely /i, /^Historical context:/i, /^Metric relationship:/i, /^\*Pages - /i, /^\*Queries - /i, /^\*Search appearance/i, /^\*GSC summary/i, /^\*GA4 performance/i])
    : -1;
  const gaEnd = gaStart >= 0
    ? firstSectionIndex(lines, gaStart + 1, [/^Likely /i, /^\*Top channels/i, /^\*Key events/i, /^\*Revenue/i, /^\*GA4 summary/i, /^\*Supporting checks/i])
    : -1;

  const gscMain = gscStart >= 0 ? lines.slice(gscStart, gscEnd).join("\n").trim() : "";
  const gaMain = gaStart >= 0 ? lines.slice(gaStart, gaEnd).join("\n").trim() : "";
  const main = [
    preface,
    gscMain,
    gaMain,
    "_Detailed drivers and supporting checks are in this thread._"
  ].filter(Boolean).join("\n\n").slice(0, 39000);

  const replies: string[] = [];
  if (gscStart >= 0) {
    const gscDetailEnd = gaStart >= 0 ? gaStart : lines.length;
    const detail = lines.slice(gscEnd, gscDetailEnd).join("\n").trim();
    if (detail) replies.push(`*GSC details*\n${detail}`);
  }
  if (gaStart >= 0) {
    const supportingStart = firstSectionIndex(lines, gaStart + 1, [/^\*Supporting checks/i]);
    const detail = lines.slice(gaEnd, supportingStart).join("\n").trim();
    if (detail) replies.push(`*GA4 details*\n${detail}`);
    const supporting = lines.slice(supportingStart).join("\n").trim();
    if (supporting) replies.push(supporting);
  }

  return { main, replies };
}

function firstSectionIndex(lines: string[], start: number, patterns: RegExp[]): number {
  const index = lines.findIndex((line, lineIndex) => lineIndex >= start && patterns.some((pattern) => pattern.test(line)));
  return index === -1 ? lines.length : index;
}

function chunkSlackText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    chunks.push(remaining.slice(0, size));
    remaining = remaining.slice(size);
  }
  if (remaining.trim()) chunks.push(remaining);
  return chunks;
}

async function formatFollowUpReport(
  client: SlackClient,
  candidates: FollowUpCandidate[],
  includeEmptyState: boolean
): Promise<string> {
  if (!candidates.length) {
    return includeEmptyState
      ? "I do not see any obvious missed follow-ups yet. I will get sharper as I collect more workspace history."
      : "";
  }

  const lines = await Promise.all(
    candidates.map(async (candidate, index) => {
      const link = await getMessageLink(client, candidate.channel, candidate.ts);
      const channelInfo = await getChannelInfo(client, candidate.channel);
      const inferredClient = (channelInfo?.name ? await inferClientFromChannelName(channelInfo.name) : undefined)
        ?? await inferClientFromText(candidate.text);
      const preview = candidate.text.replace(/\s+/g, " ").slice(0, 180);
      const ownerMentions = inferredClient?.ownerSlackUserIds?.map((id) => `<@${id}>`).join(" ");
      const ownerNames = [
        ...(inferredClient?.responsiblePeople ?? []),
        inferredClient?.techOwner,
        inferredClient?.devOwner
      ].filter(Boolean).join(", ");
      const teamLead = getTeamLeadLabel(inferredClient?.team);
      const who = ownerMentions || ownerNames || teamLead || (candidate.user ? `<@${candidate.user}>` : "Someone");
      const clientLabel = inferredClient ? ` for ${inferredClient.client}` : "";
      const teamLabel = inferredClient?.team ? ` (${inferredClient.team})` : "";
      return [
        `${index + 1}. ${who} may need follow-up${clientLabel}${teamLabel} (${candidate.reason}, ${candidate.ageMinutes}m old)`,
        `   ${link}`,
        `   "${preview}"`
      ].join("\n");
    })
  );

  return [`Potential missed follow-ups:`, ...lines].join("\n\n");
}

function parseClickUpUpdate(taskId: string, text: string): { taskId: string; status?: string; due?: string; priority?: 1 | 2 | 3 | 4; name?: string; description?: string } {
  const result: { taskId: string; status?: string; due?: string; priority?: 1 | 2 | 3 | 4; name?: string; description?: string } = { taskId };
  const priorityMap: Record<string, 1 | 2 | 3 | 4> = { urgent: 1, high: 2, normal: 3, low: 4 };
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(":").trim();

    if (key === "status") result.status = value;
    if (key === "due" || key === "due date") result.due = value;
    if (key === "priority" && priorityMap[value.toLowerCase()]) result.priority = priorityMap[value.toLowerCase()];
    if (key === "name" || key === "title") result.name = value;
    if (key === "description" || key === "desc") result.description = value;
  }

  return result;
}

function extractClickUpTaskId(text: string): string | undefined {
  const value = text.trim();
  return value.match(/app\.clickup\.com\/t\/(?:[a-z0-9-]+\/)?([a-zA-Z0-9]+)/i)?.[1] ??
    value.match(/\b(?:task\s+)?([a-zA-Z0-9]{6,})\b/)?.[1];
}

function cleanClickUpSearchQuery(value: string): string {
  return value
    .replace(/\b(clickup|tasks?|tickets?|open|closed|done|complete)\b/gi, " ")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getTeamClickUpTasks(teamName: string, range?: ClickUpDateRange, allTasksForRange?: ClickUpHealthTask[]) {
  const team = normalizeWorkflowTeam(teamName);
  const target = normalizeLoose(team ?? teamName);
  const clients = await loadClients();
  const teamClients = clients.filter((client) => normalizeLoose(client.team ?? "") === target);
  const chunks = await Promise.all(teamClients.map((client) => getClickUpWorkload({
    listName: client.clickupListName,
    range,
    includeClosed: false
  })));
  const clientScopedTasks = chunks.flat();
  const teamOnlyMembers = team ? uniqueTeamMembers(team) : [];
  if (!teamOnlyMembers.length) return uniqueClickUpTasks(clientScopedTasks);

  const allTasks = allTasksForRange ?? await getClickUpTasksForScope(undefined, false);
  const memberScopedTasks = allTasks
    .filter((task) => taskInClickUpRange(task, range))
    .filter((task) => task.assignees.some((assignee) => teamOnlyMembers.some((member) => assigneeMatchesTeamMember(assignee, member))));

  return uniqueClickUpTasks([...clientScopedTasks, ...memberScopedTasks]);
}

function uniqueTeamMembers(team: WorkflowTeam): string[] {
  const membershipCounts = new Map<string, number>();
  for (const workflowTeam of WORKFLOW_TEAMS) {
    for (const member of splitTeamMemberNames(workflowTeamMembers(workflowTeam) ?? [])) {
      const key = normalizePersonForWorkload(member);
      membershipCounts.set(key, (membershipCounts.get(key) ?? 0) + 1);
    }
  }

  return splitTeamMemberNames(workflowTeamMembers(team) ?? [])
    .filter((member) => (membershipCounts.get(normalizePersonForWorkload(member)) ?? 0) === 1);
}

function splitTeamMemberNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names
    .flatMap((name) => name.split("+"))
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => {
      if (!name) return false;
      const key = normalizePersonForWorkload(name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function assigneeMatchesTeamMember(assignee: string, member: string): boolean {
  const normalizedAssignee = normalizePersonForWorkload(assignee);
  const normalizedMember = normalizePersonForWorkload(member);
  if (!normalizedAssignee || !normalizedMember) return false;
  return normalizedAssignee === normalizedMember ||
    normalizedAssignee.includes(normalizedMember) ||
    normalizedMember.includes(normalizedAssignee) ||
    normalizedMember.split(/\s+/).every((part) => normalizedAssignee.includes(part));
}

function normalizePersonForWorkload(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function taskInClickUpRange(task: ClickUpHealthTask, range?: ClickUpDateRange): boolean {
  if (!range || (!range.start && !range.end)) return true;
  if (!task.dueDate) return false;
  if (range.start && task.dueDate < range.start) return false;
  if (range.end && task.dueDate > range.end) return false;
  return true;
}

function uniqueClickUpTasks(tasks: ClickUpHealthTask[]): ClickUpHealthTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

async function getAllTeamClickUpTasks(range?: ClickUpDateRange): Promise<Array<{ team: string; tasks: ClickUpHealthTask[]; memberNames?: string[] }>> {
  const clients = await loadClients();
  const teams = ["Team AB", "Team CD"].filter((team) =>
    clients.some((client) => normalizeLoose(client.team ?? "") === normalizeLoose(team))
  );
  const selectedTeams = teams.length ? teams : ["Team AB", "Team CD"];
  const allTasksForRange = (await getClickUpTasksForScope(undefined, false)).filter((task) => taskInClickUpRange(task, range));
  return Promise.all(selectedTeams.map(async (team) => ({
    team,
    tasks: await getTeamClickUpTasks(team, range, allTasksForRange),
    memberNames: workflowTeamMembers(team)
  })));
}

function parseClickUpDateRange(text: string): ClickUpDateRange {
  const custom = parseClickUpCustomRange(text);
  if (custom) return custom;

  const now = new Date();
  if (/\ball\s*time\b|\bany\s*time\b|\bwithout\s+date\s+scope\b/i.test(text)) {
    return { label: "all time" };
  }
  if (/\byesterday\b/i.test(text)) {
    const day = addDays(startOfDay(now), -1);
    return { label: `yesterday (${formatLocalDate(day)})`, start: day.getTime(), end: endOfDay(day).getTime() };
  }
  if (/\btoday\b|\bdaily\b/i.test(text)) {
    return { label: `today (${formatLocalDate(now)})`, start: startOfDay(now).getTime(), end: endOfDay(now).getTime() };
  }
  if (/\b(last|previous)\s+week\b/i.test(text)) {
    const weekStart = addDays(startOfWeek(now), -7);
    const weekEnd = endOfWeek(weekStart);
    return { label: `previous week (${formatLocalDate(weekStart)} to ${formatLocalDate(weekEnd)})`, start: weekStart.getTime(), end: weekEnd.getTime() };
  }
  if (/\b(this\s+)?month\b|\bmonthly\b/i.test(text) && !/\b(last|previous)\s+month\b/i.test(text)) {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    return { label: `this month (${formatLocalDate(monthStart)} to ${formatLocalDate(monthEnd)})`, start: monthStart.getTime(), end: monthEnd.getTime() };
  }
  if (/\b(last|previous)\s+month\b/i.test(text)) {
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthEnd = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
    return { label: `previous month (${formatLocalDate(monthStart)} to ${formatLocalDate(monthEnd)})`, start: monthStart.getTime(), end: monthEnd.getTime() };
  }

  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  return { label: `current week (${formatLocalDate(weekStart)} to ${formatLocalDate(weekEnd)})`, start: weekStart.getTime(), end: weekEnd.getTime() };
}

function hasExplicitClickUpDateScope(text: string): boolean {
  return /\b(today|daily|yesterday|week|weekly|month|monthly|all\s*time|any\s*time|without\s+date\s+scope|\d{4}-\d{2}-\d{2})\b/i.test(text);
}

function parseClickUpCustomRange(text: string): ClickUpDateRange | undefined {
  const match = text.match(/\b(?:from|between)?\s*(\d{4}-\d{2}-\d{2})\s*(?:to|and|-)\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (!match?.[1] || !match[2]) return undefined;
  const start = parseLocalDate(match[1]);
  const end = parseLocalDate(match[2]);
  if (!start || !end) return undefined;
  return {
    label: `${formatLocalDate(start)} to ${formatLocalDate(end)}`,
    start: startOfDay(start).getTime(),
    end: endOfDay(end).getTime()
  };
}

function parseLocalDate(value: string): Date | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const day = start.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(start, offset);
}

function endOfWeek(date: Date): Date {
  return endOfDay(addDays(startOfWeek(date), 6));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function prepareNamedClickUpAction(
  pendingKey: string,
  action: "comment" | "update" | "close",
  taskName: string,
  clientName: string,
  options: { range?: ClickUpDateRange; updateText?: string; commentText?: string }
): Promise<string> {
  const client = await findClientByName(cleanClickUpClientName(clientName));
  const tasks = await searchClickUpTasks(cleanClickUpTaskName(taskName), {
    listName: client?.clickupListName,
    includeClosed: true,
    range: options.range
  });

  if (!tasks.length) {
    return [
      `I could not find a ClickUp task named "${cleanClickUpTaskName(taskName)}"${client ? ` for ${client.client}` : ""}.`,
      "Give me a little more of the task title or the ClickUp link and I will try again."
    ].join("\n");
  }

  if (tasks.length > 1) {
    return formatClickUpTaskList("I found more than one possible task. Which one should I use?", tasks, {
      limit: 5,
      rangeLabel: options.range?.label,
      followUp: "Reply with the ClickUp task link/ID, or include a more exact task name."
    });
  }

  const task = tasks[0];
  pendingClickUpActions.set(pendingKey, {
    action,
    task,
    updateText: options.updateText,
    commentText: options.commentText,
    updatedAt: Date.now()
  });

  return [
    `I found this task: <${task.url ?? `https://app.clickup.com/t/${task.id}`}|${task.name}>`,
    `Status: ${task.status ?? "unknown"}${task.dueDate ? ` | due ${formatLocalDate(new Date(task.dueDate))}` : ""}${task.assignees.length ? ` | ${task.assignees.join(", ")}` : ""}`,
    `Reply \`yes\` to confirm I should ${action === "close" ? "close it" : action === "comment" ? "add the comment" : "update it"}, or \`no\` to cancel.`
  ].join("\n");
}

async function handlePendingClickUpConfirmation(pendingKey: string, text: string): Promise<string | undefined> {
  const pending = pendingClickUpActions.get(pendingKey);
  if (!pending) return undefined;

  if (Date.now() - pending.updatedAt > 10 * 60 * 1000) {
    pendingClickUpActions.delete(pendingKey);
    return undefined;
  }

  if (/^(?:no|nope|cancel|stop|never mind|nevermind)$/i.test(text.trim())) {
    pendingClickUpActions.delete(pendingKey);
    return "Cancelled. I did not change the ClickUp task.";
  }

  if (!/^(?:yes|yep|confirm|confirmed|do it|go ahead|please do)$/i.test(text.trim())) {
    return undefined;
  }

  pendingClickUpActions.delete(pendingKey);
  if (pending.action === "comment") {
    if (!pending.commentText) return "I had the task, but not the comment text. Please send the comment again.";
    await addClickUpComment(pending.task.id, pending.commentText);
    return `Comment added to <${pending.task.url ?? `https://app.clickup.com/t/${pending.task.id}`}|${pending.task.name}>.`;
  }

  if (pending.action === "close") {
    await closeClickUpTask(pending.task.id);
    return `Closed <${pending.task.url ?? `https://app.clickup.com/t/${pending.task.id}`}|${pending.task.name}>.`;
  }

  if (!pending.updateText) return "I had the task, but not the update details. Please send the update again.";
  await updateClickUpTask(parseClickUpUpdate(pending.task.id, pending.updateText));
  return `Updated <${pending.task.url ?? `https://app.clickup.com/t/${pending.task.id}`}|${pending.task.name}>.`;
}

function cleanClickUpTaskName(value: string): string {
  return value.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

function cleanClickUpClientName(value: string): string {
  return value
    .replace(/\b(status|due|due date|priority|name|description)\s*:[\s\S]*$/i, "")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function notifyUnsupportedRequest(client: SlackClient, requestText: string, source = "General request"): Promise<void> {
  try {
    const dm = await client.conversations.open({ users: UNSUPPORTED_REQUEST_NOTIFY_USER_ID });
    const channel = dm.channel?.id;
    if (!channel) return;
    await client.chat.postMessage({
      channel,
      text: [
        `${source} I could not handle yet:`,
        requestText,
        "",
        "Logged so you can decide whether this should become a new Viktor feature."
      ].join("\n")
    });
  } catch (error) {
    logError(error);
  }
}

function cleanClientRequestName(value: string): string {
  return value
    .replace(/\b(can you|could you|please|pls)\b[\s\S]*$/i, "")
    .replace(/\b(send|post)\s+(it|this|that|data)[\s\S]*$/i, "")
    .replace(/\b(daily|weekly|monthly|with comparison|without comparison|comparison)\b/gi, "")
    .replace(/[?.!]+$/g, "")
    .trim();
}

async function handleAdminSettingsCommand(text: string): Promise<string | undefined> {
  if (/^(admin settings|settings|show settings|viktor settings)$/i.test(text)) {
    return formatAdminSettings();
  }

  const reportChannel = text.match(/^set\s+(?:report|fallback|alerts?)\s+channel\s+#?([a-z0-9_-]+)$/i);
  if (reportChannel?.[1]) {
    await setReportChannel(reportChannel[1]);
    return `Done. Fallback monitoring alerts will use #${reportChannel[1]}. Client-specific alerts will still go to client channels when I can map them.`;
  }

  const followup = text.match(/^set\s+follow-?up\s+(?:delay|age|time)\s+(\d+)\s*(?:m|min|minutes)?$/i);
  if (followup?.[1]) {
    await setFollowupMinAgeMinutes(Number(followup[1]));
    return `Done. I’ll wait ${followup[1]} minutes before flagging missed follow-ups.`;
  }

  const clientChannel = text.match(/^map\s+client\s+(.+?)\s+(?:to|=>)\s+#?([a-z0-9_-]+)$/i);
  if (clientChannel?.[1] && clientChannel[2]) {
    await setClientChannel(clientChannel[1].trim(), clientChannel[2]);
    return `Done. ${clientChannel[1].trim()} alerts will go to #${clientChannel[2]}.`;
  }

  if (/^(access settings|bot access|show access)$/i.test(text)) {
    const access = getAccessSettings();
    return [
      `Access mode: ${access.mode}`,
      access.allowedUserIds.length ? `Allowed users: ${access.allowedUserIds.map((id) => `<@${id}>`).join(", ")}` : "Allowed users: none"
    ].join("\n");
  }

  const accessMode = text.match(/^set\s+(?:bot\s+)?access\s+(open|restricted)$/i);
  if (accessMode?.[1]) {
    await setAccessMode(accessMode[1] as "open" | "restricted");
    return `Done. Viktor access is now ${accessMode[1]}.`;
  }

  const allowUser = text.match(/^(?:allow|add)\s+user\s+(<@[A-Z0-9]+>|[A-Z0-9]+)$/i);
  if (allowUser?.[1]) {
    await addAllowedUser(allowUser[1]);
    return `Done. Added ${allowUser[1]} to Viktor access.`;
  }

  const removeUser = text.match(/^(?:remove|deny)\s+user\s+(<@[A-Z0-9]+>|[A-Z0-9]+)$/i);
  if (removeUser?.[1]) {
    await removeAllowedUser(removeUser[1]);
    return `Done. Removed ${removeUser[1]} from Viktor access.`;
  }

  const googleProfile = text.match(/^(?:set|map)\s+(?:client\s+)?(.+?)\s+(?:google\s+profile|google\s+account)\s+(?:to|=>|as)\s+([a-z0-9_-]+)$/i)
    ?? text.match(/^set\s+google\s+profile\s+(.+?)\s+(?:to|=>|as)\s+([a-z0-9_-]+)$/i);
  if (googleProfile?.[1] && googleProfile[2]) {
    const updated = await updateClientGoogleProfile(googleProfile[1].trim(), googleProfile[2].trim());
    return updated
      ? `Done. ${updated.client} will use Google profile ${updated.googleProfile ?? "default"}.`
      : `I could not find ${googleProfile[1].trim()} in the editable client mapping.`;
  }

  const threshold = text.match(/^set\s+threshold\s+(.+?)\s+(\d+(?:\.\d+)?)%?(?:\s+absolute\s+(\d+(?:\.\d+)?))?$/i);
  if (threshold?.[1] && threshold[2]) {
    await setThreshold(threshold[1].trim(), Number(threshold[2]), threshold[3] ? Number(threshold[3]) : undefined);
    return `Done. I set the ${threshold[1].trim()} anomaly threshold to ${threshold[2]}%${threshold[3] ? ` with absolute minimum ${threshold[3]}` : ""}.`;
  }

  const remember = text.match(/^(?:remember|learn)\s+(?:that\s+)?(.+)$/i);
  if (remember?.[1]) {
    await rememberPreference(remember[1]);
    return `Got it. I’ll remember: ${remember[1]}`;
  }

  if (/^(learned rules|show learned rules|learning rules)$/i.test(text)) {
    return formatLearnedRules();
  }

  const removeRule = text.match(/^(?:forget|remove learned rule|delete learned rule)\s+(.+)$/i);
  if (removeRule?.[1]) {
    const removed = await removeLearnedRule(removeRule[1]);
    return removed ? `Done. I removed: ${removed.text}` : `I could not find a learned rule matching "${removeRule[1]}".`;
  }

  return undefined;
}

function parseDataRequest(text: string, defaultClientName?: string): PendingDataRequest | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/\b(data|performance|analytics|gsc|ga4|ga|search console|alert|alerts|report|monitoring)\b/i.test(normalized)) return undefined;
  const clientMatch = normalized.match(/\bfor\s+(.+?)(?:\s+(?:to|in|into|on)\s+#?[a-z0-9_-]+)?[?.!]*$/i)
    ?? normalized.match(/\bof\s+(.+?)(?:\s+(?:to|in|into|on)\s+#?[a-z0-9_-]+)?[?.!]*$/i);
  if (!clientMatch?.[1] && !defaultClientName && !/\b(send|show|get|pull|fetch|give|need|provide)\b/i.test(normalized)) return undefined;

  const focus = parseClientDataFocus(normalized);
  const sources: Array<"gsc" | "ga"> = [];
  if (focus?.source === "gsc") sources.push("gsc");
  if (focus?.source === "ga") sources.push("ga");
  if (/\b(gsc|search console)\b/i.test(normalized) && !sources.includes("gsc")) sources.push("gsc");
  if (/\b(ga4|ga|analytics)\b/i.test(normalized) && !sources.includes("ga")) sources.push("ga");
  if (!sources.length) sources.push("gsc", "ga");
  const learnedDefault = getDataDefault(dataSourceKey(sources));
  const period = parsePeriod(normalized) ?? learnedDefault.period;

  return {
    clientName: clientMatch?.[1] ? cleanClientRequestName(cleanDataClientName(clientMatch[1])) : defaultClientName,
    sources,
    period,
    compare: parseCompare(normalized) ?? (period ? true : (/\b(alert|alerts|report|monitoring)\b/i.test(normalized) ? true : learnedDefault.compare)),
    countryFilter: parseCountryFilter(normalized) ?? true,
    focus,
    destinationChannelName: parseDestinationChannel(normalized),
    requestedAt: Date.now()
  };
}

function parseClientDataFocus(text: string): ClientDataFocus | undefined {
  const quoted = text.match(/["“”']([^"“”']{2,160})["“”']/)?.[1]?.trim();
  if (/\b(query|keyword|keywords?)\b/i.test(text)) {
    const value = quoted ?? text.match(/\b(?:query|keyword|keywords?)\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
    if (value) return { source: "gsc", dimension: "query", value: cleanFocusValue(value) };
    return { source: "gsc", dimension: "query", value: "" };
  }
  if (/\b(gsc|search console)\b/i.test(text) && /\b(page|url|landing page)\b/i.test(text)) {
    const value = quoted ?? parseGscPageFocusValue(text);
    if (value) return { source: "gsc", dimension: "page", value: cleanFocusValue(value) };
  }

  const dimension = parseGaFocusDimension(text);
  const metric = parseGaFocusMetric(text) ?? (dimension && /\b(ga4|ga|analytics)\b/i.test(text) ? "sessions" : undefined);
  if (!metric) return undefined;
  const value = quoted ?? parseGaFocusValue(text, dimension);
  return { source: "ga", metric, dimension, value: value ? cleanFocusValue(value) : undefined };
}

function parseGscPageFocusValue(text: string): string | undefined {
  const slackLink = text.match(/<((?:https?:\/\/)[^>|]+)(?:\|[^>]+)?>/i)?.[1];
  if (slackLink) return cleanTrailingUrlPunctuation(slackLink);
  const url = text.match(/https?:\/\/[^\s>]+/i)?.[0];
  if (url) return cleanTrailingUrlPunctuation(url);
  return text.match(/\b(?:page|url|landing page)\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
}

function cleanTrailingUrlPunctuation(value: string): string {
  return value.replace(/[<>\s]+$/g, "").replace(/[),\].!?]+$/g, "");
}

function parseGaFocusMetric(text: string): Extract<ClientDataFocus, { source: "ga" }>["metric"] | undefined {
  if (/\b(revenue|sales)\b/i.test(text)) return "totalRevenue";
  if (/\b(purchases?|orders?)\b/i.test(text)) return "ecommercePurchases";
  if (/\b(key events?|conversions?)\b/i.test(text)) return "keyEvents";
  if (/\b(active users?|users?)\b/i.test(text)) return "activeUsers";
  if (/\b(sessions?|traffic)\b/i.test(text)) return "sessions";
  return undefined;
}

function parseGaFocusDimension(text: string): Extract<ClientDataFocus, { source: "ga" }>["dimension"] | undefined {
  if (/\b(landing page|page|url)\b/i.test(text)) return "landingPagePlusQueryString";
  if (/\b(source\s*\/\s*medium|source medium)\b/i.test(text)) return "sessionSourceMedium";
  if (/\b(channel)\b/i.test(text)) return "sessionDefaultChannelGroup";
  if (/\b(event|key event)\b/i.test(text)) return "eventName";
  return undefined;
}

function parseGaFocusValue(text: string, dimension?: Extract<ClientDataFocus, { source: "ga" }>["dimension"]): string | undefined {
  if (!dimension) return undefined;
  if (dimension === "landingPagePlusQueryString") return text.match(/\b(?:landing page|page|url)\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
  if (dimension === "sessionDefaultChannelGroup") return text.match(/\bchannel\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
  if (dimension === "sessionSourceMedium") return text.match(/\bsource\s*\/?\s*medium\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
  if (dimension === "eventName") return text.match(/\b(?:event|key event)\s+(?:of|for|is|=|:)?\s*([^?.]+?)(?:\s+for\s+|$)/i)?.[1]?.trim();
  return undefined;
}

function cleanFocusValue(value: string): string {
  return value
    .replace(/^<|>$/g, "")
    .replace(/\b(daily|weekly|monthly|last week|this week|with comparison|without comparison|comparison)\b/gi, " ")
    .replace(/\b(for|of)\s+[a-z0-9 &.'-]+$/i, " ")
    .replace(/[>?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDataRequestFromRecentContext(
  request: PendingDataRequest | undefined,
  text: string,
  previous: ClientDataRequest | undefined
): PendingDataRequest | undefined {
  if (!request || !previous || !isSourceOnlyDataRequest(text)) return request;
  return {
    ...request,
    clientName: request.clientName ?? previous.clientName,
    period: parsePeriod(text) ?? previous.period,
    compare: parseCompare(text) ?? previous.compare,
    countryFilter: parseCountryFilter(text) ?? previous.countryFilter ?? true
  };
}

function rememberRecentClientContext(conversationId: string, clientName?: string) {
  if (!clientName) return;
  recentClientContexts.set(conversationId, {
    clientName,
    updatedAt: Date.now()
  });
}

function getRecentClientContext(conversationId: string): string | undefined {
  const context = recentClientContexts.get(conversationId);
  if (!context) return undefined;
  const maxAgeMs = 6 * 60 * 60 * 1000;
  if (Date.now() - context.updatedAt > maxAgeMs) {
    recentClientContexts.delete(conversationId);
    return undefined;
  }
  return context.clientName;
}

function isSourceOnlyDataRequest(text: string): boolean {
  return /\b(?:only\s+)?(?:gsc|search console|ga4|ga|analytics)\s+data\b/i.test(text) ||
    /\bdata\s+(?:only\s+)?(?:from\s+)?(?:gsc|search console|ga4|ga|analytics)\b/i.test(text);
}

function mergeDataRequest(pending: PendingDataRequest, text: string): PendingDataRequest {
  const normalized = text.replace(/\s+/g, " ").trim();
  const parsedPeriod = parsePeriod(normalized);
  const parsedCompare = parseCompare(normalized);
  const clientMatch = normalized.match(/\bfor\s+(.+?)(?:\s+(?:to|in|into|on)\s+#?[a-z0-9_-]+)?[?.!]*$/i)
    ?? normalized.match(/\bof\s+(.+?)(?:\s+(?:to|in|into|on)\s+#?[a-z0-9_-]+)?[?.!]*$/i);
  return {
    ...pending,
    clientName: clientMatch?.[1] ? cleanClientRequestName(cleanDataClientName(clientMatch[1])) : pending.clientName,
    period: parsedPeriod ?? pending.period,
    compare: parsedCompare ?? inferDefaultComparison(pending, normalized, parsedPeriod),
    countryFilter: parseCountryFilter(normalized) ?? pending.countryFilter ?? true,
    focus: parseClientDataFocus(normalized) ?? pending.focus,
    destinationChannelName: parseDestinationChannel(normalized) ?? pending.destinationChannelName,
    requestedAt: Date.now()
  };
}

function isCompleteDataRequest(request: PendingDataRequest): request is PendingDataRequest & ClientDataRequest {
  if (request.focus?.source === "gsc" && !request.focus.value) return false;
  return Boolean(request.clientName && request.sources?.length && request.period && request.compare !== undefined);
}

function isLikelyDataClarification(text: string): boolean {
  return /\b(daily|weekly|week|monthly|month|compare|comparison|yes|no|dm|here|channel|send|gsc|ga4|ga|vs|may|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(text) ||
    /^\s*(?:for|of)\s+.+/i.test(text);
}

async function handleExportCommand(
  client: SlackClient,
  text: string,
  channel: string,
  threadTs?: string
): Promise<boolean> {
  const request = parseExportRequest(text);
  if (!request) return false;

  if (request.domain !== "clickup") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I can export ClickUp workload/task data right now. Drive/report PDF exports are next, but not wired as a safe Slack action yet."
    });
    return true;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Generating ${request.format.toUpperCase()} export: ${request.title}...`
  });

  const range = parseClickUpDateRange(text);
  const tasks = await resolveClickUpExportTasks(request, range);
  const artifact = await createClickUpExportArtifact({
    title: request.title,
    tasks,
    format: request.format,
    rangeLabel: range.label
  });

  const uploaded = await uploadExportArtifact(client, channel, artifact, {
    threadTs,
    initialComment: `Export ready: ${artifact.title} (${tasks.length} tasks, ${range.label}).`
  });
  if (!uploaded) return true;
  return true;
}

type ExportRequest = {
  domain: "clickup" | "other";
  format: ExportFormat;
  title: string;
  scope?: "all_teams" | "team" | "assignee" | "search" | "overdue";
  target?: string;
};

function parseExportRequest(text: string): ExportRequest | undefined {
  if (!/\b(export|download|generate)\b/i.test(text)) return undefined;
  const format = parseExportFormat(text);
  if (!format) return undefined;

  if (!/\b(clickup|tasks?|workload|overdue)\b/i.test(text)) {
    return { domain: "other", format, title: "Viktor export" };
  }

  if (isAllTeamWorkloadExport(text)) {
    return { domain: "clickup", format, scope: "all_teams", title: "ClickUp workload - all teams" };
  }

  const team = text.match(/\b(team\s+(?:ab|cd|[a-d]))\b/i)?.[1];
  if (team && /\bworkload|tasks?\b/i.test(text)) {
    const label = normalizeWorkflowTeam(team) ?? titleCaseLabel(team);
    return { domain: "clickup", format, scope: "team", target: label, title: `ClickUp workload - ${label}` };
  }

  const overdue = text.match(/\boverdue(?:\s+(?:for|assigned to)\s+([^?.]+))?/i);
  if (overdue) {
    const target = overdue[1]?.trim();
    return {
      domain: "clickup",
      format,
      scope: "overdue",
      target,
      title: `Overdue ClickUp tasks${target ? ` - ${target}` : ""}`
    };
  }

  const search = text.match(/\b(?:tasks?|clickup)\s+(?:about|for|matching|with)\s+(.+?)(?:\s+as\s+(?:xlsx|excel|docx|word|pdf)|$)/i);
  if (search?.[1]) {
    const query = cleanClickUpSearchQuery(search[1]);
    if (query) return { domain: "clickup", format, scope: "search", target: query, title: `ClickUp tasks - ${query}` };
  }

  const assignee = text.match(/\b(?:tasks?|workload)\s+(?:for|assigned to)\s+(.+?)(?:\s+as\s+(?:xlsx|excel|docx|word|pdf)|$)/i)?.[1]?.trim();
  if (assignee) {
    return { domain: "clickup", format, scope: "assignee", target: assignee, title: `ClickUp tasks - ${assignee}` };
  }

  return { domain: "clickup", format, scope: "all_teams", title: "ClickUp workload - all teams" };
}

function isAllTeamWorkloadExport(text: string): boolean {
  return /\ball\s+teams?\b[\s\S]*\bworkload\b/i.test(text) ||
    /\bworkload\b[\s\S]*\ball\s+teams?\b/i.test(text) ||
    /\bteam\s+a\b[\s\S]*\bteam\s+d\b[\s\S]*\bworkload\b/i.test(text) ||
    /\bworkload\b[\s\S]*\bteam\s+a\b[\s\S]*\bteam\s+d\b/i.test(text) ||
    /\bteam\s+a\s*,\s*(?:team\s+)?b\s*,\s*(?:team\s+)?c\s*,\s*(?:team\s+)?d\b[\s\S]*\bworkload\b/i.test(text);
}

function parseExportFormat(text: string): ExportFormat | undefined {
  if (/\b(xlsx|excel|spreadsheet)\b/i.test(text)) return "xlsx";
  if (/\b(docx|word)\b/i.test(text)) return "docx";
  if (/\bpdf\b/i.test(text)) return "pdf";
  return undefined;
}

function titleCaseLabel(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

async function resolveClickUpExportTasks(request: ExportRequest, range: ClickUpDateRange): Promise<ClickUpHealthTask[]> {
  if (request.scope === "team" && request.target) return getTeamClickUpTasks(request.target, range);
  if (request.scope === "assignee" && request.target) return getClickUpWorkload({ assignee: request.target, range, includeClosed: true });
  if (request.scope === "search" && request.target) return searchClickUpTasks(request.target, { includeClosed: true, range });
  if (request.scope === "overdue") return getClickUpOverdueTasks({ assignee: request.target, range });
  const teams = await getAllTeamClickUpTasks(range);
  return teams.flatMap((entry) => entry.tasks);
}

function parsePeriod(text: string): MonitoringDateSelection | undefined {
  const customComparison = parseCustomDateComparison(text);
  if (customComparison) return customComparison;
  if (/\b(daily|today|yesterday|1\s*day)\b/i.test(text)) return "daily";
  const customPeriod = parseCustomPeriod(text);
  if (customPeriod) return customPeriod;
  if (/\b(quarterly)\b/i.test(text)) return "quarterly";
  if (/\b(monthly|month|28\s*days|30\s*days)\b/i.test(text)) return "monthly";
  if (/\b(weekly|week|7\s*days)\b/i.test(text)) return "weekly";
  return undefined;
}

function parseCustomDateComparison(text: string): MonitoringDateSelection | undefined {
  const normalized = text
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1")
    .replace(/\b(\d{1,2})\s+(st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\b(vs|versus|compared with|compare)\b/i.test(normalized)) return undefined;

  const monthNames = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const pattern = new RegExp(`(?:comparison\\s*)?(\\d{1,2})\\s*(?:-|to|and|&)\\s*(\\d{1,2})\\s*${monthNames}?\\s*(?:vs|versus|compared with|compare(?:d)?\\s*(?:to|with)?)\\s*(\\d{1,2})\\s*(?:-|to|and|&)\\s*(\\d{1,2})\\s*${monthNames}?`, "i");
  const match = normalized.match(pattern);
  if (!match) return undefined;

  const currentMonth = monthNumber(match[3] || match[6]);
  const previousMonth = monthNumber(match[6] || match[3]);
  if (!currentMonth || !previousMonth) return undefined;

  const year = new Date().getFullYear();
  const currentStart = dateString(year, currentMonth, Number(match[1]));
  const currentEnd = dateString(year, currentMonth, Number(match[2]));
  const previousStart = dateString(year, previousMonth, Number(match[4]));
  const previousEnd = dateString(year, previousMonth, Number(match[5]));
  if (!currentStart || !currentEnd || !previousStart || !previousEnd) return undefined;

  return {
    kind: "custom",
    current: { startDate: currentStart, endDate: currentEnd },
    previous: { startDate: previousStart, endDate: previousEnd }
  };
}

function monthNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const key = value.toLowerCase().slice(0, 3);
  const months: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12
  };
  return months[key];
}

function dateString(year: number, month: number, day: number): string | undefined {
  if (!day || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseCustomPeriod(text: string): MonitoringPeriod | undefined {
  const numeric = text.match(/\b(\d{1,3})\s*(days?|weeks?|months?)\b/i);
  if (numeric?.[1] && numeric[2]) {
    const value = Number(numeric[1]);
    const unit = numeric[2].toLowerCase();
    if (unit.startsWith("day")) return toCustomPeriod(value);
    if (unit.startsWith("week")) return toCustomPeriod(value * 7);
    if (unit.startsWith("month")) return toCustomPeriod(value * 30);
  }

  if (/\bthree\s*months?\b/i.test(text)) return "90d";
  if (/\btwo\s*months?\b/i.test(text)) return "60d";
  if (/\bsix\s*months?\b/i.test(text)) return "180d";
  if (/\bone\s*month\b/i.test(text)) return "30d";
  return undefined;
}

function toCustomPeriod(days: number): MonitoringPeriod {
  const bounded = Math.max(1, Math.min(548, Math.round(days)));
  return `${bounded}d`;
}

function parseCompare(text: string): boolean | undefined {
  if (/\b(no comparison|without comparison|do not compare|don't compare)\b/i.test(text)) return false;
  if (/\b(compare|comparison|with previous|yes|with comparison)\b/i.test(text)) return true;
  return undefined;
}

function parseCountryFilter(text: string): boolean | undefined {
  if (/\b(?:without|remove|ignore|skip|no)\s+(?:the\s+)?(?:main\s+)?country\s+filter\b/i.test(text)) return false;
  if (/\b(?:without|remove|ignore|skip|no)\s+(?:the\s+)?country\b/i.test(text)) return false;
  if (/\b(?:all countries|global data|globally|worldwide)\b/i.test(text)) return false;
  if (/\b(?:with|use|keep|apply)\s+(?:the\s+)?(?:main\s+)?country\s+filter\b/i.test(text)) return true;
  if (/\b(?:main|target|primary)\s+country\b/i.test(text)) return true;
  return undefined;
}

function inferDefaultComparison(
  pending: PendingDataRequest,
  text: string,
  parsedPeriod: MonitoringDateSelection | undefined
): boolean | undefined {
  if (pending.compare !== undefined) return pending.compare;
  if (!parsedPeriod) return undefined;
  if (/\bdata\b/i.test(text)) return true;
  if (pending.period === parsedPeriod) return true;
  return undefined;
}

function cleanDataClientName(value: string): string {
  return value
    .replace(/\b(?:comparison|compare|compared|vs|versus)\b[\s\S]*$/i, "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\b[\s\S]*$/i, "")
    .trim();
}

function parseDestinationChannel(text: string): string | undefined {
  const explicit = text.match(/\b(?:send|post)?\s*(?:to|in|into|on)\s+(?:channel\s+)?#([a-z0-9_-]+)/i)?.[1];
  if (explicit) return explicit;

  const named = text.match(/\b(?:send|post)\s+(?:to|in|into|on)\s+channel\s+([a-z0-9_-]+)/i)?.[1];
  if (!named || /^(the|respective|client|same|this|that|it|here|dm)$/i.test(named)) return undefined;
  return named;
}

function parseSendLastDataToClientChannel(text: string): boolean {
  return /\b(send|post)\s+(this|that|it|same)\s+(?:data\s+)?(?:in|to|into|on)\s+(?:the\s+)?(?:client\s+)?channel\b/i.test(text) ||
    /\b(send|post)\s+(?:in|to|into|on)\s+(?:the\s+)?(?:client\s+)?channel\s+(?:as\s+well|too)\b/i.test(text);
}

async function handleLastDataExportRequest(client: SlackClient, text: string, channel: string, threadTs?: string): Promise<boolean> {
  if (!/\b(this|that|last|previous)\s+(?:report|data|response)\b/i.test(text) && !/\bdocs?\s+format\b/i.test(text)) return false;
  const format = parseExportFormat(text) ?? (/\bdocs?\s+format\b/i.test(text) ? "docx" : undefined);
  if (!format) return false;
  const previous = getLastDataResponse(channel, threadTs);
  if (!previous) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "I do not have a recent report to export yet. Ask me for the data first, then say `provide this report in docs format`."
    });
    return true;
  }

  const artifact = await createTextExportArtifact({
    title: previous.title,
    text: previous.text,
    format
  });
  await uploadExportArtifact(client, channel, artifact, {
    threadTs,
    initialComment: `Export ready: ${artifact.title}`
  });
  return true;
}

async function uploadExportArtifact(
  client: SlackClient,
  channel: string,
  artifact: Awaited<ReturnType<typeof createTextExportArtifact>> | Awaited<ReturnType<typeof createClickUpExportArtifact>>,
  options: { threadTs?: string; initialComment: string }
): Promise<boolean> {
  try {
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: options.threadTs,
      filename: artifact.filename,
      title: artifact.title,
      initial_comment: options.initialComment,
      file: artifact.buffer
    });
    return true;
  } catch (error) {
    if (extractSlackErrorCode(error) === "missing_scope" && missingSlackScope(error) === "files:write") {
      await client.chat.postMessage({
        channel,
        thread_ts: options.threadTs,
        text: "I created the export, but Slack blocked the upload because Viktor is missing the `files:write` permission. Add `files:write` to the bot token scopes, reinstall the Slack app, then restart Viktor."
      });
      return false;
    }
    throw error;
  }
}

function missingSlackScope(error: unknown): string | undefined {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { needed?: string } }).data;
    return data?.needed;
  }
  return undefined;
}

function rememberLastDataResponse(channel: string, response: LastDataResponse, threadTs?: string) {
  lastDataResponses.set(channel, response);
  if (threadTs) lastDataResponses.set(lastDataThreadKey(channel, threadTs), response);
}

function getLastDataResponse(channel: string, threadTs?: string): LastDataResponse | undefined {
  return threadTs
    ? lastDataResponses.get(lastDataThreadKey(channel, threadTs)) ?? lastDataResponses.get(channel)
    : lastDataResponses.get(channel);
}

function lastDataThreadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function dataClarificationPrompt(request: PendingDataRequest): string {
  const missing = [];
  if (!request.clientName) missing.push("which client");
  if (!request.period) missing.push("daily, weekly, monthly, or a custom date range");
  if (request.compare === undefined) missing.push("with comparison or without comparison");
  if (request.focus?.source === "gsc" && !request.focus.value) missing.push(`which ${request.focus.dimension}`);
  const destination = request.destinationChannelName ? ` I’ll send it to #${request.destinationChannelName}.` : " I’ll send it here unless you say a channel.";
  return `What do you want me to pull${request.clientName ? ` for ${request.clientName}` : ""}: ${missing.join(" and ")}?${destination}`;
}

function dataRequestPeriodLabel(period: MonitoringDateSelection): string {
  if (typeof period === "object") {
    return `${period.current.startDate} to ${period.current.endDate} compared with ${period.previous.startDate} to ${period.previous.endDate}`;
  }
  return period;
}

async function sendDataRequestResponse(
  client: SlackClient,
  dmChannel: string,
  request: ClientDataRequest & { destinationChannelName?: string },
  threadTs?: string
) {
  await runWithManualPriority(async () => {
  const health = await checkGoogleApiHealth();
  if (!health.ok) {
    await client.chat.postMessage({ channel: dmChannel, thread_ts: threadTs, text: googleHealthMessage(health.error, health.userAction) });
    return;
  }

  const text = await formatClientDataRequest(request);
  const title = dataRequestTitle(request);
  if (!request.destinationChannelName) {
    for (const part of splitDataReportText(text)) {
      await client.chat.postMessage({ channel: dmChannel, thread_ts: threadTs, text: part });
    }
    rememberRecentClientContext(dmChannel, request.clientName);
    rememberLastDataResponse(dmChannel, {
      clientName: request.clientName,
      sources: request.sources,
      period: request.period,
      compare: request.compare,
      countryFilter: request.countryFilter ?? true,
      focus: request.focus,
      text,
      title
    }, threadTs);
    await maybeProposeLearning(client, dmChannel, request);
    return;
  }

  const channel = await findChannelByName(client, request.destinationChannelName);
  if (!channel?.id) {
    await client.chat.postMessage({ channel: dmChannel, text: `I could not find #${request.destinationChannelName}, so I’m sending it here instead.\n\n${text}` });
    return;
  }

  for (const part of splitDataReportText(text)) {
    await postToChannel(client, channel, part);
  }
  await client.chat.postMessage({ channel: dmChannel, text: `Done. I sent the ${dataRequestPeriodLabel(request.period)} data to #${channel.name ?? request.destinationChannelName}.` });
  rememberRecentClientContext(dmChannel, request.clientName);
  rememberLastDataResponse(dmChannel, {
    clientName: request.clientName,
    sources: request.sources,
    period: request.period,
    compare: request.compare,
    countryFilter: request.countryFilter ?? true,
    focus: request.focus,
    text,
    title
  }, threadTs);
  await maybeProposeLearning(client, dmChannel, request);
  if (request.clientName && (channel.name ?? request.destinationChannelName)) {
    await maybePostLearningSuggestion(client, dmChannel, await observeClientChannel({
      clientName: request.clientName,
      channel: channel.name ?? request.destinationChannelName
    }));
  }
  });
}

function dataRequestTitle(request: ClientDataRequest): string {
  const source = request.sources.map((item) => item.toUpperCase()).join(" + ");
  const focus = request.focus
    ? request.focus.source === "gsc"
      ? ` - ${request.focus.dimension} ${request.focus.value}`
      : ` - ${request.focus.metric}${request.focus.value ? ` ${request.focus.value}` : ""}`
    : "";
  return `${source} report - ${request.clientName}${focus}`;
}

function splitDataReportText(text: string): string[] {
  const marker = "\n\n*GA4 performance - ";
  const index = text.indexOf(marker);
  if (index === -1) return [text];
  return [text.slice(0, index), text.slice(index + 2)].filter((part) => part.trim());
}

async function answerWithAgentContext(
  client: SlackClient,
  conversationId: string,
  text: string,
  options?: {
    channelName?: string;
    inferredClient?: ClientConfig;
    threadTs?: string;
    files?: SlackFileRef[];
  }
): Promise<string> {
  const inferredClient = options?.inferredClient ?? await inferClientFromText(text);
  const ruleIntent = classifyNaturalIntent(text);
  const intent = ruleIntent.domain === "unknown"
    ? (await classifyStructuredIntent(text, [
      options?.channelName ? `Channel: #${options.channelName}` : "",
      inferredClient ? `Inferred client: ${inferredClient.client}` : ""
    ].filter(Boolean).join("\n"))) ?? ruleIntent
    : ruleIntent;

  const currentUpload = options?.files?.length
    ? await answerSlackFileQuestion(options.files, text, conversationId, config.SLACK_BOT_TOKEN)
    : undefined;
  if (currentUpload) return currentUpload;

  const naturalMemory = intent.domain === "client_memory"
    ? await handleNaturalClientMemoryQuestion(text, inferredClient)
    : undefined;
  if (naturalMemory) return naturalMemory;

  const naturalTaskLocation = intent.domain === "task_location"
    ? await handleNaturalTaskLocationQuestion(text)
    : undefined;
  if (naturalTaskLocation) return naturalTaskLocation;

  const naturalClickUp = intent.domain === "clickup"
    ? await handleNaturalClickUpQuestion(client, text, conversationId, intent)
    : undefined;
  if (naturalClickUp) return naturalClickUp;

  const threadFileReference = options?.threadTs
    ? await handleThreadFileReference(client, conversationId, options.threadTs, text)
    : undefined;
  if (threadFileReference) return threadFileReference;

  const naturalDrive = intent.domain === "drive"
    ? await handleNaturalDriveQuestion(text, inferredClient)
    : undefined;
  if (naturalDrive) return naturalDrive;

  const schemaIgnore = await handleStandaloneSchemaIgnore(text, inferredClient);
  if (schemaIgnore) return schemaIgnore;

  const naturalSettings = intent.domain === "settings"
    ? await handleNaturalSettingsQuestion(text)
    : undefined;
  if (naturalSettings) return naturalSettings;

  const unsupportedAction = unsupportedActionResponse(intent);
  if (unsupportedAction) {
    await notifyUnsupportedRequest(client, text, `${intent.domain} request`);
    return unsupportedAction;
  }

  const contextParts = [
    "*Tool routing available*",
    "- GSC/GA4 data: ask for daily, weekly, monthly, or custom-period data for a mapped client.",
    "- Drive: ask to search Drive/docs for a topic.",
    "- ClickUp: explicitly ask to create, update, comment on, or check task health.",
    "- Slack: ask to send/post a message to a named channel.",
    "- Settings: ask for settings, learned rules, client mappings, thresholds, or report channels.",
    "- Learning: say remember/learn, or approve a learning suggestion.",
    `Structured intent: ${JSON.stringify(intent)}.`,
    options?.channelName ? `Source: current Slack channel #${options.channelName}.` : "",
    inferredClient ? clientSourceContext(inferredClient) : "Source: no client confidently inferred from this message.",
    inferredClient ? formatClientNotes(inferredClient.client) : "",
    options?.threadTs ? `Recent thread context:\n${await getThreadContext(client, conversationId, options.threadTs)}` : "",
    `Recent conversation memory:\n${recentMemoryContext({ channel: conversationId, limit: 10 })}`
  ].filter(Boolean).join("\n\n");

  const answer = await askAssistant(conversationId, text, contextParts);
  if (isUnsupportedBotAnswer(answer)) {
    await notifyUnsupportedRequest(client, text);
  }
  return answer;
}

function unsupportedActionResponse(intent: NaturalIntent): string | undefined {
  const examples = commandExamplesForIntent(intent);
  if (!examples.length) return undefined;

  return [
    "I understand the type of request, but I cannot complete that exact task yet. I have sent it to Kushal so it can be reviewed as a possible Viktor feature.",
    "",
    "Useful formats you can try now:",
    ...examples.map((example) => `- ${example}`)
  ].join("\n");
}

function commandExamplesForIntent(intent: NaturalIntent): string[] {
  if (intent.domain === "unknown") return [];

  if (intent.domain === "clickup") {
    return [
      "`show ClickUp tasks for Kushal this month`",
      "`show Team AB workload this week`",
      "`find ClickUp tasks about homepage title`",
      "`comment on ClickUp task <task id>: <comment>`",
      "`update ClickUp task <task id> due: tomorrow`"
    ];
  }

  if (intent.domain === "data") {
    return [
      "`weekly GSC data for Example Client X with comparison`",
      "`GA4 sessions for Client Name last 28 days with comparison`",
      "`GSC performance of page https://example.com/page/ for Client Name last week`",
      "`GSC query performance for \"keyword\" for Client Name last week`"
    ];
  }

  if (intent.domain === "drive") {
    return [
      "`find Drive topical map for Client Name`",
      "`summarize the doc <Google Doc URL>`",
      "`answer from the sheet <sheet name>: <question>`",
      "`fetch folder URL for bulk blog content for Client Name`"
    ];
  }

  if (intent.domain === "monitoring") {
    return [
      "`send daily monitoring for Client Name`",
      "`rerun daily monitoring`",
      "`run weekly report for all clients`",
      "`run monthly report for all clients`"
    ];
  }

  if (intent.domain === "slack") {
    return [
      "`go to channel #channel-name and message <message>`",
      "`message Kushal that <message>`"
    ];
  }

  if (intent.domain === "task_creation") {
    return [
      "`create task: <title> | Client: <client> | Due: <date> | Priority: <priority>`",
      "`create task for Client Name: <what needs to be done>`"
    ];
  }

  if (intent.domain === "settings") {
    return [
      "`show client mappings`",
      "`set client channel Client Name #channel-name`",
      "`set main country for Client Name to usa`",
      "`show learned rules`"
    ];
  }

  if (intent.domain === "client_memory") {
    return [
      "`show client log for Client Name`",
      "`add client log for Client Name: <note>`",
      "`remember this for Client Name: <note>`"
    ];
  }

  if (intent.domain === "learning") {
    return [
      "`remember this preference: <preference>`",
      "`show learned rules`"
    ];
  }

  if (intent.domain === "task_location") {
    return [
      "`where was the task created?`",
      "`show recent workbook task location`"
    ];
  }

  return [];
}

async function handleStandaloneSchemaIgnore(text: string, inferredClient?: ClientConfig): Promise<string | undefined> {
  if (!/\b(schema|json-ld)\b/i.test(text)) return undefined;
  if (!/\b(remove|stop|ignore|exclude|don't flag|do not flag|no need|not needed|not required)\b/i.test(text)) return undefined;

  const urls = [...extractUrlsFromLines([text]), ...extractPathRefsFromText(text)];
  if (!urls.length) return undefined;

  const explicitClient = text.match(/\b(?:for|client)\s+([a-z0-9][a-z0-9 &.'-]{2,}?)(?=\s+(?:schema|url|page|monitoring|$))/i)?.[1];
  const clientName = cleanClientRequestName(explicitClient || inferredClient?.client || "");
  if (!clientName) return "Which client should I stop schema monitoring for?";

  await ignoreSchemaUrls(clientName, urls);
  return `Got it. I will stop flagging these schema URLs for ${clientName}:\n${urls.map((url) => `- ${url}`).join("\n")}`;
}

function isUnsupportedBotAnswer(answer: string): boolean {
  return /\b(beyond my (?:current )?scope|not able to|cannot currently|can't currently|do not have access|don't have access|not supported|not something I can)\b/i.test(answer);
}

async function handleNaturalTaskLocationQuestion(text: string): Promise<string | undefined> {
  if (!/\b(where|which|what)\b/i.test(text)) return undefined;
  if (!/\b(created|added|wrote|saved)\b/i.test(text)) return undefined;
  if (!/\b(task|workbook|sheet|clickup)\b/i.test(text)) return undefined;
  return formatLastWorkbookTaskLocation();
}

async function handleNaturalClickUpQuestion(client: SlackClient, text: string, conversationId: string, intent = classifyNaturalIntent(text)): Promise<string | undefined> {
  if (intent.domain !== "clickup") return undefined;

  const range = parseClickUpDateRange(text);
  const pendingKey = conversationId;
  const confirmation = await handlePendingClickUpConfirmation(pendingKey, text);
  if (confirmation) return confirmation;

  const comment = text.match(/\bcomment\s+(?:on\s+)?(?:clickup\s+)?task\s+([a-zA-Z0-9]+|https?:\/\/\S+)\s*:\s*([\s\S]+)$/i);
  if (comment?.[1] && comment[2]) {
    const id = extractClickUpTaskId(comment[1]);
    if (!id) return "Which ClickUp task should I comment on?";
    await addClickUpComment(id, comment[2].trim());
    return `Comment added to ClickUp task ${id}.`;
  }

  const namedComment = text.match(/\bcomment\s+(?:on\s+)?(?:clickup\s+)?task\s+"?(.+?)"?\s+(?:for|in|on|client)\s+(.+?)\s*:\s*([\s\S]+)$/i);
  if (namedComment?.[1] && namedComment[2] && namedComment[3]) {
    return prepareNamedClickUpAction(pendingKey, "comment", namedComment[1], namedComment[2], { commentText: namedComment[3].trim(), range });
  }

  const close = text.match(/\b(?:close|complete|mark\s+done|mark\s+complete)\s+(?:clickup\s+)?task\s+([a-zA-Z0-9]+|https?:\/\/\S+)/i);
  if (close?.[1]) {
    const id = extractClickUpTaskId(close[1]);
    if (!id) return "Which ClickUp task should I close?";
    await closeClickUpTask(id);
    return `Closed ClickUp task ${id}.`;
  }

  const namedClose = text.match(/\b(?:close|complete|mark\s+done|mark\s+complete)\s+(?:clickup\s+)?task\s+"?(.+?)"?\s+(?:for|in|on|client)\s+(.+?)$/i);
  if (namedClose?.[1] && namedClose[2]) {
    return prepareNamedClickUpAction(pendingKey, "close", namedClose[1], namedClose[2], { range });
  }

  const update = text.match(/\bupdate\s+(?:clickup\s+)?task\s+([a-zA-Z0-9]+|https?:\/\/\S+)\s+(.+)$/i);
  if (update?.[1] && update[2]) {
    const id = extractClickUpTaskId(update[1]);
    if (!id) return "Which ClickUp task should I update?";
    await updateClickUpTask(parseClickUpUpdate(id, update[2]));
    return `Updated ClickUp task ${id}.`;
  }

  const namedUpdate = text.match(/\bupdate\s+(?:clickup\s+)?task\s+"?(.+?)"?\s+(?:for|in|on|client)\s+(.+?)\s+(status\s*:|due\s*:|due date\s*:|priority\s*:|name\s*:|description\s*:|.+)$/i);
  if (namedUpdate?.[1] && namedUpdate[2] && namedUpdate[3]) {
    return prepareNamedClickUpAction(pendingKey, "update", namedUpdate[1], namedUpdate[2], { updateText: namedUpdate[3].trim(), range });
  }

  if (intent.domain === "clickup" && intent.action === "task_activity") {
    const [task, comments] = await Promise.all([
      getClickUpTaskDetails(intent.taskId),
      getClickUpTaskComments(intent.taskId)
    ]);
    return formatClickUpTaskChange(task, comments);
  }

  if (intent.domain === "clickup" && intent.action === "overdue") {
    const overdueRange = hasExplicitClickUpDateScope(text) ? range : { label: "all overdue tasks" };
    const tasks = await getClickUpOverdueTasks({ assignee: intent.assignee, range: overdueRange });
    return formatClickUpTaskList(`Overdue ClickUp tasks${intent.assignee ? ` for ${intent.assignee}` : ""}`, tasks, {
      rangeLabel: overdueRange.label,
      followUp: "Need this for this month, all time, or a custom date range too?"
    });
  }

  if (intent.domain === "clickup" && intent.action === "workload" && intent.scope === "all_teams") {
    const matrix = await getAllTeamClickUpTasks(range);
    return formatClickUpTeamStatusMatrix("ClickUp workload - all teams", matrix, { rangeLabel: range.label });
  }

  if (intent.domain === "clickup" && intent.action === "workload" && intent.scope === "team" && intent.target) {
    const team = normalizeWorkflowTeam(intent.target) ?? intent.target.replace(/\s+/g, " ").trim();
    const tasks = await getTeamClickUpTasks(team, range);
    return formatClickUpWorkload(`ClickUp workload - ${team}`, tasks, {
      rangeLabel: range.label,
      memberNames: workflowTeamMembers(team)
    });
  }

  if (intent.domain === "clickup" && intent.action === "workload" && intent.scope === "assignee" && intent.target) {
    const tasks = await getClickUpWorkload({ assignee: intent.target, range });
    return formatClickUpTaskList(`ClickUp tasks for ${intent.target}`, tasks, {
      rangeLabel: range.label,
      followUp: "Need this month, all time, or a custom date range as well?"
    });
  }

  if (intent.domain === "clickup" && intent.action === "search_tasks") {
    const tasks = await searchClickUpTasks(intent.query, { includeClosed: /\bclosed|done|complete|all\s*time/i.test(text), range });
    return formatClickUpTaskList(`ClickUp tasks matching "${intent.query}"`, tasks, {
      rangeLabel: range.label,
      followUp: "I fetched all matching client tasks by default. Want me to narrow this to your own tasks, a specific person's tasks, monthly, all time, or a custom date range?"
    });
  }

  if (/\b(make|design|predict|automate|integrate|anything|everything|outside|beyond)\b/i.test(text)) {
    await notifyUnsupportedRequest(client, text, "ClickUp request");
    return "Sorry, I am just a simple bot programmed to be a simple assistant. That is beyond my current scope, but I’ll pass the message to my creator, who is definitely not surviving on caffeine and stubbornness alone. Thank you for your patience.";
  }

  return undefined;
}

async function handleNaturalClientMemoryQuestion(text: string, inferredClient?: ClientConfig): Promise<string | undefined> {
  if (!/\b(what do you know|what do you remember|client memory|client log|notes?|logs?)\b/i.test(text)) return undefined;
  const client = inferredClient ?? await inferClientFromText(text);
  if (!client) return "Which client should I check memory for?";
  return [
    clientSourceContext(client),
    "",
    formatClientNotes(client.client)
  ].join("\n");
}

async function handleNaturalDriveQuestion(text: string, inferredClient?: ClientConfig): Promise<string | undefined> {
  if (!isDriveLikeRequest(text)) return undefined;
  const driveOptions = driveSearchOptions(inferredClient);
  const explicitDriveUrl = extractDriveLinks(text)[0];
  if (explicitDriveUrl) {
    if (isSummarizeInstruction(text)) return summarizeDriveKnowledgeUrl(explicitDriveUrl.url, driveOptions);
    if (isFileQuestionInstruction(text)) return answerDriveKnowledgeUrlQuestion(explicitDriveUrl.url, text, driveOptions);
  }

  const appendDoc = text.match(/\bappend\s+(.+?)\s+(?:to|in)\s+(?:the\s+)?(?:doc|document)\s+(.+)$/i);
  if (appendDoc?.[1] && appendDoc[2]) {
    return appendToGoogleDocument(cleanDriveQuery(appendDoc[2], inferredClient), appendDoc[1].trim(), driveOptions);
  }

  const appendSheet = text.match(/\bappend\s+(.+?)\s+(?:to|in)\s+(?:the\s+)?(?:sheet|spreadsheet|workbook)\s+(.+)$/i);
  if (appendSheet?.[1] && appendSheet[2]) {
    const values = appendSheet[1]
      .split(/\s*\|\s*|\s*,\s*/)
      .map((value) => value.trim())
      .filter(Boolean);
    return appendToGoogleSheet(cleanDriveQuery(appendSheet[2], inferredClient), values.length ? values : [appendSheet[1].trim()], driveOptions);
  }

  const updateDoc = text.match(/\b(?:update|replace)\s+(?:text\s+)?["“](.+?)["”]\s+(?:with|to)\s+["“](.+?)["”]\s+(?:in|on)\s+(?:the\s+)?(?:doc|document)\s+(.+)$/i);
  if (updateDoc?.[1] && updateDoc[2] && updateDoc[3]) {
    return replaceInGoogleDocument(cleanDriveQuery(updateDoc[3], inferredClient), updateDoc[1], updateDoc[2], driveOptions);
  }

  const updateSheet = text.match(/\b(?:update|set)\s+(?:cell\s+)?([A-Z]+[1-9][0-9]*)\s+(?:to|as|=)\s+(.+?)\s+(?:in|on)\s+(?:the\s+)?(?:sheet|spreadsheet|workbook)\s+(.+)$/i);
  if (updateSheet?.[1] && updateSheet[2] && updateSheet[3]) {
    return updateGoogleSheetCell(cleanDriveQuery(updateSheet[3], inferredClient), updateSheet[1], updateSheet[2].trim(), driveOptions);
  }

  if (isDriveFolderLinkRequest(text)) {
    const query = cleanDriveQuery(text, inferredClient);
    if (query.length >= 3) return formatDriveFolderSearch(query, driveOptions);
  }

  const compound = parseCompoundDriveInstruction(text, inferredClient);
  if (compound) {
    if (isSummarizeInstruction(compound.instruction)) {
      return summarizeDriveKnowledgeFile(compound.query, driveOptions);
    }
    return answerDriveKnowledgeQuestion(compound.query, compound.instruction, driveOptions);
  }

  const summarize = text.match(/\b(?:summarize|summary|read)\b(?:\s+(?:me|this|the))?\s+(.+)$/i);
  if (summarize?.[1] && /\b(summarize|summary|read)\b/i.test(text)) {
    const query = cleanDriveQuery(summarize[1], inferredClient);
    if (query.length >= 3) return summarizeDriveKnowledgeFile(query, driveOptions);
  }

  const qa = text.match(/\b(?:answer|question|ask)\b[\s\S]*?\b(?:from|in|using)\s+(?:the\s+)?(.+?)(?:\s*:\s*|\s+question\s+)([\s\S]+)$/i);
  if (qa?.[1] && qa[2]) {
    return answerDriveKnowledgeQuestion(cleanDriveQuery(qa[1], inferredClient), qa[2].trim(), driveOptions);
  }

  const aboutFile = text.match(/\b(?:what|why|how|which|where|when)\b[\s\S]*?\b(?:from|in|using)\s+(?:the\s+)?(?:file|doc|document|sheet|pdf)\s+(.+)$/i);
  if (aboutFile?.[1]) {
    return answerDriveKnowledgeQuestion(cleanDriveQuery(aboutFile[1], inferredClient), text, driveOptions);
  }

  let query = text
    .replace(/\s+(?:and|then)\s+(?:summarize|summary|read)\s+(?:it|this|the\s+(?:file|doc|document|sheet|spreadsheet|workbook))\b/gi, " ")
    .replace(/\b(can you|could you|please|pls|search|find|fetch|get|look for|show|send|me|in|for|from|drive|docs?|documents?|files?|knowledge)\b/gi, " ")
    .replace(/\bthis client\b/gi, " ")
    .replace(/\b(that|this|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (inferredClient?.client) {
    query = stripClientNameFromQuery(query, inferredClient.client);
  }
  if (query.length < 3) return "What should I search for in Drive?";
  return formatDriveKnowledgeSearch(query, driveOptions);
}

function driveSearchOptions(inferredClient?: ClientConfig) {
  return {
    clientName: inferredClient?.client,
    googleProfile: inferredClient?.googleProfile
  };
}

function isDriveLikeRequest(text: string): boolean {
  if (/\b(drive|docs?|documents?|files?|folders?|knowledge|pdf|sheet|spreadsheet|workbook)\b/i.test(text)) return true;
  return /\b(fetch|get|find|search|show|send|pull)\b[\s\S]*\b(topical\s+map|eav|domain\s*wide|domainwide|attribute\s+mapping|content\s+brief|seo\s+brief)\b/i.test(text);
}

function isDriveFolderLinkRequest(text: string): boolean {
  return /\b(folder|folders)\b/i.test(text) &&
    (/\b(url|link|shareable|location)\b/i.test(text) || /\b(fetch|get|find|search|show|send|pull)\b/i.test(text));
}

function parseCompoundDriveInstruction(text: string, inferredClient?: ClientConfig): { query: string; instruction: string } | undefined {
  const match = text.match(/\b(?:fetch|get|find|search|show|send|pull|open|look\s+for)\s+(?:me\s+)?(.+?)\s+(?:and|then|after\s+that|afterwards)\s+([\s\S]+)$/i);
  if (!match?.[1] || !match[2]) return undefined;

  const query = cleanDriveQuery(match[1], inferredClient);
  const instruction = normalizeFileInstruction(match[2]);
  if (query.length < 3 || instruction.length < 3) return undefined;
  return { query, instruction };
}

function normalizeFileInstruction(text: string): string {
  return text
    .replace(/\b(it|this|that|the\s+(?:file|doc|document|sheet|spreadsheet|workbook))\b/gi, "the file")
    .replace(/\s+/g, " ")
    .trim();
}

function isSummarizeInstruction(text: string): boolean {
  return /\b(summarize|summary|summarise|recap|brief|overview|read)\b/i.test(text);
}

function isFileQuestionInstruction(text: string): boolean {
  return isSummarizeInstruction(text) ||
    /\b(what|why|how|which|where|when|who|explain|tell me|list|extract|identify|find|give me|show me|action items?|recommendations?|key points?|takeaways?|clusters?|topics?)\b/i.test(text);
}

function cleanDriveQuery(text: string, inferredClient?: ClientConfig): string {
  let query = text
    .replace(/\b(can you|could you|please|pls|search|find|fetch|get|look for|show|send|me|in|for|from|drive|docs?|documents?|files?|folders?|knowledge|summarize|summary|read|answer|question|ask|using|pdf|sheet|spreadsheet|workbook|url|link|shareable|location)\b/gi, " ")
    .replace(/\bthis client\b/gi, " ")
    .replace(/\b(that|this|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (inferredClient?.client) {
    query = stripClientNameFromQuery(query, inferredClient.client);
  }
  return query;
}

function stripClientNameFromQuery(query: string, clientName: string): string {
  const clientPattern = clientName
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const withoutExact = clientPattern
    ? query.replace(new RegExp(`\\b${clientPattern}\\b`, "ig"), " ")
    : query;
  const clientTerms = clientName
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((term) => term.length >= 2);
  const compactClient = clientTerms.join("");
  return withoutExact
    .split(/\s+/)
    .filter((term) => {
      const normalized = term.toLowerCase().replace(/[^a-z0-9]+/g, "");
      return !clientTerms.includes(normalized) && normalized !== compactClient;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function handleThreadFileReference(
  client: SlackClient,
  channel: string,
  threadTs: string,
  text: string
): Promise<string | undefined> {
  const refersToFile = /\b(that|this|the)\s+(file|workbook|sheet|doc|document)|\b(file|workbook|sheet|doc|document)\s+(url|link)\b/i.test(text);
  if (!refersToFile && !isFileQuestionInstruction(text) && !extractDriveLinks(text).length) {
    return undefined;
  }

  const context = await getThreadContext(client, channel, threadTs);
  const links = extractDriveLinks(context)
    .filter((link) => /docs\.google\.com|drive\.google\.com/i.test(link.url));
  const threadFiles = await getThreadSlackFiles(client, channel, threadTs);
  if (!links.length && threadFiles.length) {
    return answerSlackFileQuestion(threadFiles, text, `${channel}:${threadTs}`, config.SLACK_BOT_TOKEN);
  }
  if (!links.length) return undefined;

  const explicitUrl = extractDriveLinks(text)[0];
  if (explicitUrl) {
    if (isSummarizeInstruction(text)) return summarizeDriveKnowledgeUrl(explicitUrl.url);
    if (isFileQuestionInstruction(text)) return answerDriveKnowledgeUrlQuestion(explicitUrl.url, text);
  }

  const ranked = links
    .map((link, index) => ({
      ...link,
      index,
      score:
        (link.source === "human" ? 80 : 0) +
        (/topical\s+map/i.test(link.label) ? 50 : 0) +
        (/workbook|sheet|spreadsheet/i.test(link.label) || /\/spreadsheets\//i.test(link.url) ? 30 : 0) +
        (/doc|document/i.test(link.label) || /\/document\//i.test(link.url) ? 20 : 0) +
        (index / 100)
    }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked[0];
  if (!selected) return undefined;
  if (isSummarizeInstruction(text)) return summarizeDriveKnowledgeUrl(selected.url);
  if (isFileQuestionInstruction(text)) return answerDriveKnowledgeUrlQuestion(selected.url, text);

  return [
    "Here is the file from this thread:",
    `- <${selected.url}|${selected.label}>`,
    `URL: ${selected.url}`
  ].join("\n");
}

async function getThreadSlackFiles(client: SlackClient, channel: string, threadTs: string): Promise<SlackFileRef[]> {
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20
    });
    return (response.messages ?? [])
      .flatMap((message) => message.files ?? [])
      .filter((file) => hasReadableSlackFiles([file]));
  } catch {
    return [];
  }
}

async function handleNaturalSettingsQuestion(text: string): Promise<string | undefined> {
  if (/\b(settings|thresholds?|report channel|fallback channel|learned rules|rules|client mappings|mapped clients)\b/i.test(text)) {
    if (/\b(client mappings|mapped clients|clients)\b/i.test(text)) return formatClientMappings();
    if (/\b(learned rules|rules)\b/i.test(text)) return formatLearnedRules();
    return formatAdminSettings();
  }
  return undefined;
}

function clientSourceContext(client: ClientConfig): string {
  const teamLead = getTeamLeadLabel(client.team);
  return [
    `*Client mapping source - ${client.client}*`,
    `Website/GSC: ${client.gscSite ?? "not set"}`,
    `GA4 property: ${client.ga4PropertyId ?? "not set"}`,
    `Main country: ${client.mainCountry || "global"}`,
    `Slack channel: ${client.slackChannel ? `#${client.slackChannel}` : "not set"}`,
    `Team: ${client.team ?? "not set"}`,
    `Team lead: ${teamLead ?? "not set"}`
  ].join("\n");
}

function getTeamLeadLabel(team?: string): string | undefined {
  const normalized = team?.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.includes("team a")) return "Teammate AB 1";
  if (normalized.includes("team b")) return "Teammate AB 2";
  if (normalized.includes("team c")) return "Teammate CD 1";
  if (normalized.includes("team d")) return "Teammate CD 2";
  return undefined;
}

async function maybeProposeLearning(
  client: SlackClient,
  dmChannel: string,
  request: ClientDataRequest
) {
  if (typeof request.period === "object") return;

  const suggestion = await observeDataDefault({
    sourceKey: dataSourceKey(request.sources),
    period: request.period,
    compare: request.compare
  });

  if (!suggestion) return;

  await maybePostLearningSuggestion(client, dmChannel, suggestion);
}

async function maybePostLearningSuggestion(
  client: SlackClient,
  dmChannel: string,
  suggestion: Awaited<ReturnType<typeof observeDataDefault>>,
  threadTs?: string
) {
  if (!suggestion) return;

  await client.chat.postMessage({
    channel: dmChannel,
    thread_ts: threadTs,
    text: `Should I remember this? ${suggestion.text}`,
    blocks: learningBlocks(suggestion)
  });
}

function parseLearningButtonRequest(text: string): string | undefined {
  if (!/\b(should i remember|remember this.*button|learning button|ask me should i remember|ask.*remember.*button)\b/i.test(text)) return undefined;
  return "Remember this preference for future interactions only if I approve it.";
}

function dataSourceKey(sources: Array<"gsc" | "ga">): string {
  return [...sources].sort().join("+");
}

async function getMessageLink(client: SlackClient, channel: string, ts: string): Promise<string> {
  try {
    const result = await client.chat.getPermalink({ channel, message_ts: ts });
    return result.permalink ?? `<#${channel}>`;
  } catch {
    return `<#${channel}>`;
  }
}

async function getChannelInfo(client: SlackClient, channel: string): Promise<{ id?: string; name?: string } | undefined> {
  try {
    return (await client.conversations.info({ channel })).channel;
  } catch {
    return undefined;
  }
}

function looksLikeQuestionForViktor(text: string): boolean {
  return text.trim().length > 2;
}

async function answerThreadQuestion(
  client: SlackClient,
  channel: string,
  threadTs: string,
  text: string,
  requester?: string
) {
  const context = await getThreadContext(client, channel, threadTs);
  if (!context.trim()) return;

  const routed = await routeAlertThreadTool(client, channel, threadTs, text, context, requester);
  if (routed) return;

  const directSchemaAnswer = answerSchemaQuestionFromContext(text, context);
  if (directSchemaAnswer) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: directSchemaAnswer
    });
    return;
  }

  const channelInfo = await getChannelInfo(client, channel);
  const inferredClient = channelInfo?.name ? await inferClientFromChannelName(channelInfo.name) : undefined;
  const enrichedContext = [
    inferredClient ? `Inferred client from channel #${channelInfo?.name}: ${inferredClient.client}` : "",
    `Thread context:\n${context}`,
    "If the user asks about a monitoring alert, answer from the alert details. Be direct and practical. If a URL is present, name it."
  ].filter(Boolean).join("\n");
  const answer = await askAssistant(`${channel}:${threadTs}`, text, enrichedContext);

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: answer
  });
}

async function routeAlertThreadTool(
  client: SlackClient,
  channel: string,
  threadTs: string,
  text: string,
  context: string,
  requester?: string
): Promise<boolean> {
  const alert = parseAlertContext(context);
  if (!alert.alertLines.length) return false;

  if (isLearningCorrection(text)) {
    const ignored = parseSchemaIgnoreRequest(text, alert);
    if (ignored.clientName && ignored.urls.length) {
      await ignoreSchemaUrls(ignored.clientName, ignored.urls);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Got it. I will stop flagging these schema URLs for ${ignored.clientName}:\n${ignored.urls.map((url) => `- ${url}`).join("\n")}`
      });
      return true;
    }

    const preference = normalizeLearningCorrection(text);
    await rememberPreference(preference);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Got it. I remembered this rule: ${preference}`
    });
    return true;
  }

  const intent = await classifyAlertThreadIntent(text, context);

  if (intent === "create_task") {
    await createAlertTaskProposal(client, channel, threadTs, alert, requester);
    return true;
  }

  if (intent === "affected_urls") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: formatAffectedUrlsAnswer(alert, text)
    });
    return true;
  }

  if (intent === "urgency") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: formatUrgencyAnswer(alert)
    });
    return true;
  }

  if (intent === "explain") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: formatWhyAnswer(alert)
    });
    return true;
  }

  if (intent === "summarize") {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: formatAlertSummary(alert)
    });
    return true;
  }

  return false;
}

async function handleClientMemoryCommand(text: string, inferredClientName?: string, author?: string): Promise<string | undefined> {
  const priorityRestoreClientName = cleanClientRequestName(inferredClientName || "");
  const priorityRestore = priorityRestoreClientName
    ? parseRestoreRecentPriorityRemoval(text, priorityRestoreClientName)
    : undefined;
  if (priorityRestore) {
    if (priorityRestore.queries.length) await addPriorityQueries(priorityRestoreClientName, priorityRestore.queries);
    if (priorityRestore.urls.length) await addPriorityUrls(priorityRestoreClientName, priorityRestore.urls);

    const lines = [
      `Added back the recently removed priority item${priorityRestore.queries.length + priorityRestore.urls.length === 1 ? "" : "s"} for ${priorityRestoreClientName}.`,
      priorityRestore.queries.length ? `Restored queries:\n${priorityRestore.queries.map((item) => `- ${item}`).join("\n")}` : "",
      priorityRestore.urls.length ? `Restored URLs:\n${priorityRestore.urls.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean);

    if (/\b(?:updated|current|new)\s+list\b|\bprovide\s+me\s+the\s+updated\s+list\b|\blist\s+again\b/i.test(text)) {
      lines.push("", formatPriorityQueries(priorityRestoreClientName), "", formatPriorityUrls(priorityRestoreClientName));
    }

    return lines.join("\n");
  }

  const priorityListRemovalClientName = cleanClientRequestName(inferredClientName || "");
  const priorityListRemoval = priorityListRemovalClientName
    ? parsePriorityListRemoval(text, priorityListRemovalClientName)
    : undefined;
  if (priorityListRemoval) {
    const removedQueries = priorityListRemoval.queries.length
      ? await removePriorityQueries(priorityListRemovalClientName, priorityListRemoval.queries)
      : [];
    const removedUrls = priorityListRemoval.urls.length
      ? await removePriorityUrls(priorityListRemovalClientName, priorityListRemoval.urls)
      : [];
    if (!removedQueries.length && !removedUrls.length) {
      return `I could not find those priority items for ${priorityListRemovalClientName}.`;
    }
    rememberPriorityRemoval(priorityListRemovalClientName, removedQueries, removedUrls);

    const lines = [
      `Updated priority list for ${priorityListRemovalClientName}.`,
      removedQueries.length ? `Removed queries:\n${removedQueries.map((item) => `- ${item}`).join("\n")}` : "",
      removedUrls.length ? `Removed URLs:\n${removedUrls.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean);

    if (/\b(?:updated|current|new)\s+list\b|\bprovide\s+me\s+the\s+updated\s+list\b/i.test(text)) {
      lines.push("", formatPriorityQueries(priorityListRemovalClientName), "", formatPriorityUrls(priorityListRemovalClientName));
    }

    return lines.join("\n");
  }

  const priorityMutation = parsePriorityMutation(text);
  if (priorityMutation) {
    const clientName = cleanClientRequestName(priorityMutation.clientName || inferredClientName || "");
    if (!clientName) return "Which client should I update the priority list for?";
    if (priorityMutation.type === "query") {
      if (priorityMutation.action === "remove") {
        const removed = await removePriorityQueries(clientName, priorityMutation.values);
        rememberPriorityRemoval(clientName, removed, []);
        return removed.length
          ? `Removed ${removed.length} priority quer${removed.length === 1 ? "y" : "ies"} for ${clientName}:\n${removed.map((item) => `- ${item}`).join("\n")}`
          : `I could not find those priority queries for ${clientName}.`;
      }
      if (priorityMutation.action === "replace") {
        await replacePriorityQueries(clientName, priorityMutation.values);
        return `Replaced the priority query list for ${clientName} with ${priorityMutation.values.length} item${priorityMutation.values.length === 1 ? "" : "s"}.`;
      }
      await addPriorityQueries(clientName, priorityMutation.values);
      return `Added ${priorityMutation.values.length} priority quer${priorityMutation.values.length === 1 ? "y" : "ies"} for ${clientName}.`;
    }

    if (priorityMutation.action === "remove") {
      const removed = await removePriorityUrls(clientName, priorityMutation.values);
      rememberPriorityRemoval(clientName, [], removed);
      return removed.length
        ? `Removed ${removed.length} priority URL${removed.length === 1 ? "" : "s"} for ${clientName}:\n${removed.map((item) => `- ${item}`).join("\n")}`
        : `I could not find those priority URLs for ${clientName}.`;
    }
    if (priorityMutation.action === "replace") {
      await replacePriorityUrls(clientName, priorityMutation.values);
      return `Replaced the priority URL list for ${clientName} with ${priorityMutation.values.length} item${priorityMutation.values.length === 1 ? "" : "s"}.`;
    }
    await addPriorityUrls(clientName, priorityMutation.values);
    return `Added ${priorityMutation.values.length} priority URL${priorityMutation.values.length === 1 ? "" : "s"} for ${clientName}.`;
  }

  if (isPriorityListStatusRequest(text)) {
    const clientName = cleanClientRequestName(inferredClientName || "");
    if (!clientName) return "Which client's priority queries and URLs should I check?";
    return [
      formatPriorityQueries(clientName),
      "",
      formatPriorityUrls(clientName)
    ].join("\n");
  }

  const naturalPriority = parseNaturalPriorityList(text);
  if (naturalPriority) {
    const clientName = cleanClientRequestName(naturalPriority.clientName || inferredClientName || "");
    if (!clientName) return "Which client should I save these priority queries and URLs under?";
    if (naturalPriority.queries.length) await addPriorityQueries(clientName, naturalPriority.queries);
    if (naturalPriority.urls.length) await addPriorityUrls(clientName, naturalPriority.urls);
    return [
      `Saved priority monitoring list for ${clientName}:`,
      naturalPriority.queries.length ? `- ${naturalPriority.queries.length} quer${naturalPriority.queries.length === 1 ? "y" : "ies"}` : "",
      naturalPriority.urls.length ? `- ${naturalPriority.urls.length} URL${naturalPriority.urls.length === 1 ? "" : "s"}` : "",
      "I will highlight these first when daily anomalies or weekly/monthly reports touch them."
    ].filter(Boolean).join("\n");
  }

  const addPriorityQuery = text.match(/^(?:add|save|remember)\s+priority\s+(?:queries|query|keywords?|keyword)\s*(?:for\s+(.+?))?\s*:\s*([\s\S]+)$/i);
  if (addPriorityQuery?.[2]) {
    const clientName = cleanClientRequestName(addPriorityQuery[1] || inferredClientName || "");
    if (!clientName) return "Which client should I save these priority queries under?";
    const queries = splitMemoryList(addPriorityQuery[2]);
    if (!queries.length) return "Send the priority queries after the colon, separated by commas or new lines.";
    await addPriorityQueries(clientName, queries);
    return `Saved ${queries.length} priority quer${queries.length === 1 ? "y" : "ies"} for ${clientName}.`;
  }

  const addPriorityUrl = text.match(/^(?:add|save|remember)\s+priority\s+(?:urls?|pages?|url|page)\s*(?:for\s+(.+?))?\s*:\s*([\s\S]+)$/i);
  if (addPriorityUrl?.[2]) {
    const clientName = cleanClientRequestName(addPriorityUrl[1] || inferredClientName || "");
    if (!clientName) return "Which client should I save these priority URLs under?";
    const urls = splitMemoryList(addPriorityUrl[2]);
    if (!urls.length) return "Send the priority URLs after the colon, separated by commas or new lines.";
    await addPriorityUrls(clientName, urls);
    return `Saved ${urls.length} priority URL${urls.length === 1 ? "" : "s"} for ${clientName}.`;
  }

  const showPriorityQueries = text.match(/^(?:show|display|list)?\s*(?:priority\s+)?(?:queries|query|keywords?|keyword)\s+(?:priority\s+)?list(?:\s+for\s+(.+))?$|^(?:show|display|list)\s+priority\s+(?:queries|query|keywords?|keyword)(?:\s+for\s+(.+))?$/i);
  if (showPriorityQueries) {
    const clientName = cleanClientRequestName(showPriorityQueries[1] || showPriorityQueries[2] || inferredClientName || "");
    if (!clientName) return "Which client’s priority queries should I show?";
    return formatPriorityQueries(clientName);
  }

  const showPriorityUrls = text.match(/^(?:show|display|list)?\s*(?:priority\s+)?(?:urls?|pages?|url|page)\s+(?:priority\s+)?list(?:\s+for\s+(.+))?$|^(?:show|display|list)\s+priority\s+(?:urls?|pages?|url|page)(?:\s+for\s+(.+))?$/i);
  if (showPriorityUrls) {
    const clientName = cleanClientRequestName(showPriorityUrls[1] || showPriorityUrls[2] || inferredClientName || "");
    if (!clientName) return "Which client’s priority URLs should I show?";
    return formatPriorityUrls(clientName);
  }

  const aiPriority = await maybeExtractPriorityListUpdate(text, inferredClientName);
  if (aiPriority) return applyPriorityListExtraction(aiPriority, inferredClientName);

  const genericRemoveMatch = text.match(/^(?:remove|delete)\s+(?:the\s+)?(?:client\s+)?(?:log|record|note|memory|log item)\s+([\s\S]+)$/i)
    ?? text.match(/^(?:remove|delete)\s+(?:the\s+)?(?:recently\s+added|latest|last|newest)\s+(?:client\s+)?(?:log|record|note|memory|log item)\s+([\s\S]+)$/i);
  const removeMatch = text.match(/^(?:remove|delete)\s+(?:client\s+)?(?:log|memory|notes?)\s*(?:for\s+(.+?))?\s*(?:#|number\s+)?(\d+)$/i)
    ?? text.match(/^(?:remove|delete)\s+(?:from\s+)?(?:client\s+)?(?:log|memory|notes?)\s*(?:for\s+(.+?))?\s*:\s*([\s\S]+)$/i)
    ?? text.match(/^(?:remove|delete)\s+(?:(?:the\s+)?(?:record|note|memory|log item)\s+)?(?:that\s+was\s+)?(?:just\s+)?(?:added|saved|recorded)(?:\s+(?:from|in)\s+(?:the\s+)?(?:client\s+)?log)?(?:\s+for\s+(.+))?$/i)
    ?? text.match(/^(?:remove|delete)\s+(?:this|this\s+record|the\s+record|latest|last|newest|recent)(?:\s+(?:record|note|memory|log item))?(?:\s+(?:from|in)\s+(?:the\s+)?(?:client\s+)?log)?(?:\s+for\s+(.+))?$/i);
  if (removeMatch || genericRemoveMatch) {
    const target = removeMatch?.[2] || genericRemoveMatch?.[1] || "latest";
    const clientName = cleanClientRequestName(removeMatch?.[1] || inferredClientName || "");
    if (!clientName) return "Which client should I remove this memory from?";
    const removed = await removeClientNote(clientName, target);
    if (!removed) return `I could not find that memory item for ${clientName}. Try \`client log\` to see the saved item numbers.`;
    return [`Removed this from ${clientName} memory:`, summarizeSavedNote(removed.text)].join("\n");
  }

  const updateMatch = text.match(/^(?:update|edit|replace)\s+(?:client\s+)?(?:log|memory|notes?)\s*(?:for\s+(.+?))?\s*(?:#|number\s+)?(\d+)\s*(?:to|with|:)\s*([\s\S]+)$/i)
    ?? text.match(/^(?:update|edit|replace)\s+(?:from\s+)?(?:client\s+)?(?:log|memory|notes?)\s*(?:for\s+(.+?))?\s*:\s*([^:]+?)\s*(?:=>|->|to|with)\s*([\s\S]+)$/i);
  if (updateMatch?.[2] && updateMatch?.[3]) {
    const clientName = cleanClientRequestName(updateMatch[1] || inferredClientName || "");
    if (!clientName) return "Which client should I update this memory for?";
    const updated = await updateClientNote(clientName, updateMatch[2], updateMatch[3], author);
    if (!updated) return `I could not find that memory item for ${clientName}. Try \`client log\` to see the saved item numbers.`;
    return [`*Updated ${clientName} memory:*`, formatClientNotePreview(updated)].join("\n");
  }

  const addMatch = text.match(/^(?:add|save|remember|log)\s+(?:this\s+)?(?:to|in|into|as)?\s*(?:the\s+)?(?:client\s+)?(?:log|log\s+file|memory|notes?)\s*(?:for\s+(.+?))?\s*:\s*([\s\S]+)$/i);
  if (addMatch?.[2]) {
    const clientName = cleanClientRequestName(addMatch[1] || inferredClientName || "");
    if (!clientName) return "Which client should I save this under?";
    const saved = await saveClientLogNote(clientName, addMatch[2], author);
    return [`*Client log update for ${clientName}:*`, formatClientNotePreview(saved ?? addMatch[2])].join("\n");
  }

  const showMatch = text.match(/^(?:(?:show|display|list|send|get|fetch|provide)\s+(?:me\s+)?(?:the\s+)?)?(?:client\s+)?(?:log|logs|log\s+file|memory|notes?)(?:\s+(?:of|for)\s+(?:this\s+client|(.+)))?$/i);
  const shorthandLog = /^(?:client\s+)?(?:log|logs|log\s+file|memory|notes?)$/i.test(text);
  if (showMatch || shorthandLog) {
    const clientName = cleanClientRequestName(showMatch?.[1] || inferredClientName || "");
    if (!clientName) return "Which client memory should I show?";
    return formatClientMemoryWithSource(clientName);
  }

  return undefined;
}

type PriorityMutation = {
  action: "add" | "remove" | "replace";
  type: "query" | "url";
  values: string[];
  clientName?: string;
};

function rememberPriorityRemoval(clientName: string, queries: string[], urls: string[]) {
  if (!queries.length && !urls.length) return;
  recentPriorityRemovals.set(priorityRemovalContextKey(clientName), {
    queries,
    urls,
    updatedAt: Date.now()
  });
}

function parseRestoreRecentPriorityRemoval(text: string, clientName: string): { queries: string[]; urls: string[] } | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/\b(?:add\s+back|restore|re-?add|put\s+back)\b/i.test(normalized)) return undefined;
  if (!/\b(?:removed|those|them|last|previous)\b/i.test(normalized)) return undefined;
  if (!/\b(?:priority|queries?|keywords?|urls?|pages?|list)\b/i.test(normalized)) return undefined;

  const remembered = recentPriorityRemovals.get(priorityRemovalContextKey(clientName));
  const maxAgeMs = 30 * 60 * 1000;
  if (!remembered || Date.now() - remembered.updatedAt > maxAgeMs) return undefined;

  const onlyQuery = /\bonly\s+(?:queries?|keywords?)\b/i.test(normalized);
  const onlyUrl = /\bonly\s+(?:urls?|pages?)\b/i.test(normalized);
  return {
    queries: onlyUrl ? [] : remembered.queries,
    urls: onlyQuery ? [] : remembered.urls
  };
}

function priorityRemovalContextKey(clientName: string): string {
  return normalizeLoose(clientName);
}

function parsePriorityListRemoval(text: string, clientName: string): { queries: string[]; urls: string[] } | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/\b(?:remove|delete|drop|stop\s+(?:tracking|monitoring))\b/i.test(normalized)) return undefined;
  if (!/\bpriority\s+(?:list|keywords?|queries?|urls?|pages?)\b/i.test(normalized)) return undefined;

  const queryList = getPriorityQueries(clientName);
  const urlList = getPriorityUrls(clientName);
  const wantsQuery = /\bpriority\s+(?:keywords?|queries?)\b/i.test(normalized);
  const wantsUrl = /\bpriority\s+(?:urls?|pages?)\b/i.test(normalized);
  const queries = new Set<string>();
  const urls = new Set<string>();

  const numberedItemPattern = /(?:^|\s)(\d+)\.\s*([\s\S]*?)(?=(?:\s+and\s+\d+\.)|\s+from\s+(?:the\s+)?priority\b|\s+@|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = numberedItemPattern.exec(normalized))) {
    const index = Number(match[1]) - 1;
    const value = cleanPriorityRemovalValue(match[2]);
    const looksUrl = /^https?:\/\//i.test(value) || /\.[a-z]{2,}(?:\/|$)/i.test(value);

    if ((wantsUrl || looksUrl) && urlList[index]) urls.add(urlList[index]);
    else if ((wantsQuery || !looksUrl) && queryList[index]) queries.add(queryList[index]);

    if (looksUrl) urls.add(value);
    else if (value) queries.add(value);
  }

  for (const url of normalized.match(/https?:\/\/[^\s,)>]+|[a-z0-9.-]+\.[a-z]{2,}\/[^\s,)>]+/gi) ?? []) {
    urls.add(cleanPriorityRemovalValue(url));
  }

  const namedValue = normalized.match(/\b(?:remove|delete|drop)\s+(.+?)\s+from\s+(?:the\s+)?priority\s+(?:list|keywords?|queries?|urls?|pages?)\b/i)?.[1];
  if (namedValue && !numberedItemPattern.test(normalized)) {
    for (const item of splitPriorityList(namedValue.replace(/\band\b/gi, ","))) {
      const cleaned = cleanPriorityRemovalValue(item);
      if (!cleaned) continue;
      if (/^https?:\/\//i.test(cleaned) || /\.[a-z]{2,}(?:\/|$)/i.test(cleaned) || wantsUrl) urls.add(cleaned);
      else queries.add(cleaned);
    }
  }

  const queryValues = [...queries].filter(Boolean);
  const urlValues = [...urls].filter(Boolean);
  if (!queryValues.length && !urlValues.length) return undefined;
  return { queries: queryValues, urls: urlValues };
}

function cleanPriorityRemovalValue(value: string): string {
  return value
    .replace(/\b(?:and|from|the|priority|list|keywords?|queries?|urls?|pages?|provide|me|updated|current|new)\b.*$/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’,.;:]+$/g, "")
    .trim();
}

function parsePriorityMutation(text: string): PriorityMutation | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\b/i.test(normalized)) return undefined;

  const action = /\b(?:remove|delete|drop|stop\s+(?:tracking|monitoring))\b/i.test(normalized)
    ? "remove"
    : /\b(?:replace|set|overwrite|use\s+only|change)\b/i.test(normalized)
      ? "replace"
      : /\b(?:add|save|remember|store|track|monitor|include)\b/i.test(normalized)
        ? "add"
        : undefined;
  if (!action) return undefined;

  const type: "query" | "url" | undefined = /\bpriority\s+(?:urls?|pages?)\b/i.test(normalized)
    ? "url"
    : /\bpriority\s+(?:keywords?|queries?)\b/i.test(normalized)
      ? "query"
      : undefined;
  if (!type) return undefined;

  const clientName = normalized.match(/\bfor\s+([a-z0-9][a-z0-9 &.'-]{2,}?)(?=\s+(?:from|to|with|as|in|on|priority|$))/i)?.[1];
  const valuesText =
    normalized.match(/\b(?:to|with|as)\s*:?\s*([\s\S]+)$/i)?.[1] ??
    normalized.match(/\b(?:from|remove|delete|drop|add|save|remember|store|track|monitor|include)\s+(?:these\s+|this\s+|the\s+)?(?:priority\s+)?(?:keywords?|queries?|urls?|pages?)\s*:?\s*([\s\S]+)$/i)?.[1] ??
    normalized.match(/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\s*:?\s*([\s\S]+)$/i)?.[1];
  if (!valuesText) return undefined;

  const cleanedValuesText = valuesText
    .replace(/\bfor\s+[a-z0-9][a-z0-9 &.'-]{2,}$/i, "")
    .replace(/\b(?:please|pls)\b/gi, " ")
    .trim();
  const values = splitPriorityList(cleanedValuesText).filter((item) =>
    type === "url" ? /^https?:\/\//i.test(item) || /\.[a-z]{2,}(?:\/|$)/i.test(item) : !/^https?:\/\//i.test(item)
  );
  if (!values.length) return undefined;

  return { action, type, values, clientName };
}

function isPriorityListStatusRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\b/i.test(normalized)) return false;
  if (/\b(?:add|save|remember|store|monitor|look\s+out)\b/i.test(normalized)) return false;
  return /\b(?:do you have|have you got|show|list|send|get|fetch|display|what(?:'s| is))\b/i.test(normalized) ||
    /\b(?:list|saved)\b/i.test(normalized);
}

function parseNaturalPriorityList(text: string): { clientName?: string; queries: string[]; urls: string[] } | undefined {
  if (!/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\b/i.test(text)) return undefined;
  const queriesSegment = text.match(/\bpriority\s+(?:keywords?|queries?)\s*(?:are|is|:|-)\s*:?\s*([\s\S]*?)(?=\b(?:the\s+)?priority\s+(?:urls?|pages?)\s*(?:are|is|:|-)|\b(?:store|save|remember|monitor|look\s+out)\b|$)/i)?.[1];
  const urlsSegment = text.match(/\bpriority\s+(?:urls?|pages?)\s*(?:are|is|:|-)\s*:?\s*([\s\S]*?)(?=\b(?:store|save|remember|monitor|look\s+out)\b|$)/i)?.[1];
  const queries = queriesSegment ? splitPriorityList(queriesSegment).filter((item) => !/^https?:\/\//i.test(item)) : [];
  const urls = urlsSegment ? splitPriorityList(urlsSegment).filter((item) => /^https?:\/\//i.test(item) || /\.[a-z]{2,}\//i.test(item)) : [];
  if (!queries.length && !urls.length) return undefined;

  const clientName = text.match(/\b(?:for|of)\s+(?:this\s+client|client\s+)?([a-z0-9][a-z0-9 &.'-]{2,}?)(?=\s+(?:the\s+)?priority\b|$)/i)?.[1];
  return { clientName, queries, urls };
}

function splitPriorityList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^[-*]\s*/, "").replace(/[.;]+$/g, "").trim())
    .filter(Boolean)
    .slice(0, 100);
}

async function saveClientLogNote(clientName: string, noteText: string, author?: string): Promise<string | undefined> {
  const cleanedSource = sanitizeSlackText(noteText);
  const facts = shouldUseAiClientLogExtraction(cleanedSource)
    ? (await extractClientLogFacts(cleanedSource, clientName))?.facts
    : undefined;
  const summary = facts?.length ? facts.join("\n") : cleanedSource;
  return addClientNote(clientName, summary, author, undefined, cleanedSource);
}

function shouldUseAiClientLogExtraction(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (normalized.length > 300) return true;
  if (normalized.split(/(?<=[.!?])\s+/).filter(Boolean).length >= 3) return true;
  return /\b(client message|client response|business context|problem|issue|concern|strategy|seo|google|search engines?|traffic|ranking|conversion|available|sold out|custom orders?)\b/i.test(normalized);
}

async function maybeExtractPriorityListUpdate(text: string, inferredClientName?: string): Promise<PriorityListExtraction | undefined> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!shouldUseAiPriorityExtraction(normalized)) return undefined;
  return extractPriorityListUpdate(normalized, inferredClientName ? `Inferred client: ${inferredClientName}` : undefined);
}

function shouldUseAiPriorityExtraction(text: string): boolean {
  if (!text) return false;
  if (isPriorityListStatusRequest(text)) return false;
  const hasPrioritySignal = /\b(priority|important|focus|track|monitor|watch|keep an eye|look out|keywords?|queries?|search terms?|urls?|pages?)\b/i.test(text);
  const hasMutationSignal = /\b(add|save|remember|store|include|track|monitor|watch|keep an eye|focus|important|remove|delete|drop|stop tracking|exclude|replace|overwrite|set|use only|new list)\b/i.test(text);
  const hasValueSignal = /https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)|["“][^"”]{3,}["”]|[:,\n]/i.test(text);
  return hasPrioritySignal && hasMutationSignal && hasValueSignal;
}

async function applyPriorityListExtraction(extraction: PriorityListExtraction, inferredClientName?: string): Promise<string> {
  const clientName = cleanClientRequestName(extraction.clientName || inferredClientName || "");
  if (!clientName) return "Which client should I update the priority list for?";

  const queries = extraction.queries;
  const urls = extraction.urls;
  if (!queries.length && !urls.length) return "I could not find priority keywords or URLs to update.";

  if (extraction.action === "replace") {
    if (queries.length) await replacePriorityQueries(clientName, queries);
    if (urls.length) await replacePriorityUrls(clientName, urls);
    return [
      `Replaced priority monitoring items for ${clientName}:`,
      queries.length ? `- ${queries.length} quer${queries.length === 1 ? "y" : "ies"}` : "",
      urls.length ? `- ${urls.length} URL${urls.length === 1 ? "" : "s"}` : ""
    ].filter(Boolean).join("\n");
  }

  if (extraction.action === "remove") {
    const removedQueries = queries.length ? await removePriorityQueries(clientName, queries) : [];
    const removedUrls = urls.length ? await removePriorityUrls(clientName, urls) : [];
    rememberPriorityRemoval(clientName, removedQueries, removedUrls);
    if (!removedQueries.length && !removedUrls.length) return `I could not find those priority items for ${clientName}.`;
    return [
      `Updated priority list for ${clientName}.`,
      removedQueries.length ? `Removed queries:\n${removedQueries.map((item) => `- ${item}`).join("\n")}` : "",
      removedUrls.length ? `Removed URLs:\n${removedUrls.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean).join("\n");
  }

  if (queries.length) await addPriorityQueries(clientName, queries);
  if (urls.length) await addPriorityUrls(clientName, urls);
  return [
    `Saved priority monitoring list for ${clientName}:`,
    queries.length ? `- ${queries.length} quer${queries.length === 1 ? "y" : "ies"}` : "",
    urls.length ? `- ${urls.length} URL${urls.length === 1 ? "" : "s"}` : "",
    "I will highlight these first when daily anomalies or weekly/monthly reports touch them."
  ].filter(Boolean).join("\n");
}

async function formatClientMemoryWithSource(clientName: string): Promise<string> {
  const exact = (await loadClients()).find((client) => normalizeLoose(client.client) === normalizeLoose(clientName));
  const inferred = exact ?? await inferClientFromText(clientName);
  if (!inferred) return formatClientNotes(clientName);
  return [
    clientSourceContext(inferred),
    "",
    formatClientNotes(inferred.client)
  ].join("\n");
}

async function handleClientCountryCommand(text: string, inferredClientName?: string): Promise<string | undefined> {
  const match = text.match(/\b(?:main\s+country|country)\s+(?:is|to|as)\s+([a-zA-Z ]+)\b/i)
    ?? text.match(/\bmap\s+(?:with|to)\s+([a-zA-Z ]+)\s+instead\s+of\s+[a-zA-Z ]+\b/i)
    ?? text.match(/\bset\s+(?:the\s+)?(?:main\s+)?country\s+(?:to|as)\s+([a-zA-Z ]+)\b/i);
  if (!match?.[1]) return undefined;

  const clientName = cleanClientRequestName(inferredClientName || "");
  if (!clientName) return "Which client should I update the main country for?";

  const country = match[1].replace(/\b(by the way|btw|instead|please|pls)\b/gi, " ").replace(/\s+/g, " ").trim();
  const updated = await updateClientMainCountry(clientName, country);
  if (!updated) return `I could not find ${clientName} in the editable client mapping.`;
  return `Updated ${updated.client}'s main country to ${updated.mainCountry}.`;
}

async function handleSaveThisToClientLogCommand(
  client: SlackClient,
  channel: string,
  threadTs: string,
  currentTs: string,
  text: string,
  inferredClientName?: string,
  author?: string
): Promise<string | undefined> {
  if (!isSaveThisToClientLogText(text)) return undefined;

  const clientName = cleanClientRequestName(inferredClientName || "");
  if (!clientName) return "Which client should I save this under?";

  const note = await getThreadRootHumanMessage(client, channel, threadTs, currentTs);
  const fallbackNote = note ?? await getPreviousHumanChannelMessage(client, channel, currentTs);
  if (!fallbackNote) return "I could not find a previous human message to save. Reply with `add client log: <note>` and I will store it.";

  const saved = await saveClientLogNote(clientName, fallbackNote, author);
  return [`*Client log update for ${clientName}:*`, formatClientNotePreview(saved ?? fallbackNote)].join("\n");
}

async function getThreadRootHumanMessage(client: SlackClient, channel: string, threadTs: string, currentTs: string): Promise<string | undefined> {
  if (threadTs === currentTs) return undefined;

  const storedRoot = getStoredSlackMessage(channel, threadTs);
  const storedRootText = storedRoot ? sanitizeSlackText(storedRoot.text) : "";
  if (storedRoot && isStoredHumanMemorySourceMessage(storedRoot) && isPotentialClientMemorySource(storedRootText)) {
    return storedRootText;
  }

  try {
    const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 25 });
    const messages = replies.messages ?? [];
    const current = Number.parseFloat(currentTs);
    const root = messages.find((message) => message.ts === threadTs);
    const rootText = root ? sanitizeSlackText(root.text ?? "") : "";
    if (root && isHumanMemorySourceMessage(root) && isPotentialClientMemorySource(rootText)) {
      return rootText;
    }

    const candidates = messages
      .filter((message) => isHumanMemorySourceMessage(message))
      .filter((message) => Number.parseFloat(String(message.ts)) < current)
      .map((message) => ({
        text: sanitizeSlackText(message.text ?? ""),
        ts: Number.parseFloat(String(message.ts))
      }))
      .filter((message) => isPotentialClientMemorySource(message.text))
      .sort((a, b) => b.ts - a.ts);
    return candidates[0]?.text;
  } catch {
    return undefined;
  }
}

async function getPreviousHumanChannelMessage(client: SlackClient, channel: string, currentTs: string): Promise<string | undefined> {
  try {
    const history = await client.conversations.history({
      channel,
      latest: currentTs,
      inclusive: false,
      limit: 30
    });
    const candidates = (history.messages ?? [])
      .filter((message) => isHumanMemorySourceMessage(message))
      .map((message) => ({
        text: sanitizeSlackText(message.text ?? ""),
        ts: Number.parseFloat(String(message.ts))
      }))
      .filter((message) => isPotentialClientMemorySource(message.text))
      .sort((a, b) => b.ts - a.ts);
    return candidates[0]?.text;
  } catch {
    return undefined;
  }
}

function isSaveThisToClientLogText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/^(?:show|display|list|send|get|fetch|provide)\b/i.test(normalized)) return false;
  if (/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\b/i.test(normalized)) return false;
  const hasSaveVerb = /\b(add|save|remember|store|keep|record)\b/i.test(normalized);
  const hasLogTarget = /\b(?:client\s+)?(?:log|logs|log\s+file|memory|notes?)\b/i.test(normalized)
    || /\b(?:to|in|into)\s+(?:the\s+)?(?:client\s+)?log\b/i.test(normalized);
  const referencesExisting =
    /\b(this|above|previous|thread|message|channel message|client message|client business|business understanding|business|understanding|details|context)\b/i.test(normalized);
  return hasSaveVerb && hasLogTarget && referencesExisting;
}

function isClientLogIntent(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/\bpriority\s+(?:keywords?|queries?|urls?|pages?)\b/i.test(normalized)) return false;
  const hasLogTarget = /\b(?:client\s+)?(?:log|logs|log\s+file|memory|notes?)\b/i.test(normalized)
    || /\b(?:to|in|into)\s+(?:the\s+)?(?:client\s+)?log\b/i.test(normalized);
  return hasLogTarget
    && /\b(add|save|remember|log|store|keep|record|show|display|list|send|get|fetch|provide|remove|delete|update|edit|replace|this|business|message|understanding)\b/i.test(normalized);
}

function isHumanMemorySourceMessage(message: { bot_id?: string; user?: string; text?: string; ts?: string; subtype?: string }): boolean {
  if (message.bot_id || !message.user || !message.text || !message.ts) return false;
  if (message.subtype && message.subtype !== "thread_broadcast") return false;
  return !isSlackSystemText(message.text);
}

function isStoredHumanMemorySourceMessage(message: { botId?: string; user?: string; text?: string; ts?: string }): boolean {
  return Boolean(!message.botId && message.user && message.text && message.ts && !isSlackSystemText(message.text));
}

function isPotentialClientMemorySource(text: string): boolean {
  if (!text) return false;
  if (isSaveThisToClientLogText(text) || isClientLogIntent(text)) return false;
  if (isSlackSystemText(text)) return false;
  return clientMemorySourceScore(text) > 0;
}

function isSlackSystemText(text: string): boolean {
  return /\b(has joined|joined)\s+(?:the\s+)?channel\b/i.test(text)
    || /\b(left|archived|renamed)\s+(?:the\s+)?channel\b/i.test(text);
}

function clientMemorySourceScore(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  let score = normalized.length > 120 ? 2 : normalized.length > 40 ? 1 : 0;
  if (/\bclient\s+(?:business|message|response|understanding)\b/i.test(normalized)) score += 5;
  if (/\bWebsite\s*:/i.test(text)) score += 4;
  if (/\bStatus\s*:/i.test(text)) score += 3;
  if (/\bCompetitor URLs?\s*:/i.test(text)) score += 3;
  if (/\bBackground\s*:/i.test(text)) score += 3;
  if (/\b(staging|sandbox|Big\s*Commerce|access provided|traffic drop|founded|launched|years)\b/i.test(normalized)) score += 2;
  return score;
}

function sanitizeSlackText(text: string): string {
  return text
    .replace(/<@[^>]+>/g, "")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function summarizeSavedNote(note: string): string {
  const clean = note.replace(/\s+/g, " ").trim();
  return clean.length <= 240 ? clean : `${clean.slice(0, 237)}...`;
}

function splitMemoryList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 100);
}

function parseSchemaIgnoreRequest(text: string, alert: AlertContext): { clientName?: string; urls: string[] } {
  if (!/\b(schema|json-ld)\b/i.test(text)) return { clientName: alert.clientName, urls: [] };
  if (!/\b(not needed|not required|ignore|exclude|don't flag|do not flag|no need)\b/i.test(text)) return { clientName: alert.clientName, urls: [] };

  const explicitUrls = [...extractUrlsFromLines([text]), ...extractPathRefsFromText(text)];
  const urls = explicitUrls.length ? explicitUrls : extractUrlsFromLines(alert.schemaLines);
  return {
    clientName: alert.clientName,
    urls
  };
}

type AlertContext = {
  clientName?: string;
  title?: string;
  alertLines: string[];
  gscLines: string[];
  gaLines: string[];
  schemaLines: string[];
  urls: string[];
};

function parseAlertContext(context: string): AlertContext {
  const lines = context
    .split(/\r?\n/)
    .map((line) => line.replace(/^Viktor:\s*/i, "").trim())
    .filter(Boolean);
  const title = lines.find((line) => /Daily monitoring|Weekly performance|Monthly performance/i.test(line));
  const alertLines = lines.filter((line) => /^-\s+\*?[^:]+:\*?\s+/.test(line) || /^\[[^\]]+\]\s+[^:]+:/.test(line));
  const allRelevant = alertLines.length ? alertLines : lines.filter((line) => /\b(GSC|GA4|Schema|PageSpeed|dropped|spiked|removed|No JSON-LD|parse errors)\b/i.test(line));
  const clientName = extractClientName(title, allRelevant[0]);
  const urls = extractUrlsFromLines(allRelevant);

  return {
    clientName,
    title,
    alertLines: allRelevant,
    gscLines: allRelevant.filter((line) => /\bGSC\b|clicks|impressions|query|position/i.test(line)),
    gaLines: allRelevant.filter((line) => /\bGA4?\b|users|sessions|revenue|events/i.test(line)),
    schemaLines: allRelevant.filter((line) => /\bschema\b|JSON-LD|Previously saw|parse errors/i.test(line)),
    urls
  };
}

function extractClientName(title?: string, firstAlert?: string): string | undefined {
  const titleMatch = title?.match(/-\s+(.+)$/);
  if (titleMatch?.[1]) return titleMatch[1].replace(/\*/g, "").trim();
  const alertMatch = firstAlert?.match(/(?:-\s+)?\*?([^:*]+):\*?\s+/);
  return alertMatch?.[1]?.replace(/\*/g, "").trim();
}

function formatAffectedUrlsAnswer(alert: AlertContext, question = ""): string {
  const schemaFocused = /\bschema\b|removed/i.test(question);
  const schemaUrls = extractUrlsFromLines(alert.schemaLines);

  if (schemaFocused && !schemaUrls.length) {
    return [
      "I do not see a schema-specific checked URL in this older alert.",
      alert.urls.length
        ? `The other URL visible in the thread is from the GSC section, not necessarily the schema check: ${alert.urls.slice(0, 3).join(", ")}`
        : "I do not see any usable URL in the alert text.",
      "Going forward, schema alerts should include the exact checked URL and should not treat redirected URLs as schema-removal issues."
    ].join("\n");
  }

  const urls = schemaFocused ? schemaUrls : alert.urls;
  if (!urls.length) {
    return "I do not see a specific URL in this alert thread. New schema alerts will include the checked URL, so future alerts should be clearer.";
  }

  return [
    "Affected URL(s) I can see in this alert:",
    ...urls.slice(0, 10).map((url) => `- ${url}`)
  ].join("\n");
}

function extractUrlsFromLines(lines: string[]): string[] {
  const raw = lines.flatMap((line) =>
    [...line.matchAll(/https?:\/\/[^\s>)]+|[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s>)]+)?/gi)]
      .map((match) => match[0])
  );

  return [...new Set(raw.flatMap(cleanExtractedUrl).filter(Boolean))];
}

function extractDriveLinks(text: string): Array<{ url: string; label: string; source: "human" | "bot" }> {
  const links: Array<{ url: string; label: string; source: "human" | "bot"; position: number }> = [];

  for (const line of text.split(/\r?\n/)) {
    const source = /^Viktor:/i.test(line) ? "bot" : "human";

    for (const match of line.matchAll(/<([^|>]+)\|([^>]+)>/g)) {
      const url = match[1]?.trim() ?? "";
      const label = match[2]?.trim() ?? "file";
      if (/^https?:\/\//i.test(url)) links.push({ url, label, source, position: match.index ?? 0 });
    }

    for (const match of line.matchAll(/<((?:https?:\/\/)?(?:docs|drive)\.google\.com[^>]+)>/gi)) {
      const url = match[1]?.trim() ?? "";
      if (/^https?:\/\//i.test(url) && !links.some((link) => link.url === url)) {
        links.push({ url, label: "Drive file", source, position: match.index ?? 0 });
      }
    }

    for (const match of line.matchAll(/https?:\/\/(?:docs|drive)\.google\.com\/[^\s>)]+/gi)) {
      const url = match[0]?.replace(/[.,;]+$/g, "") ?? "";
      if (/^https?:\/\//i.test(url) && !links.some((link) => link.url === url)) {
        links.push({ url, label: "Drive file", source, position: match.index ?? 0 });
      }
    }

    for (const match of line.matchAll(/https?:\/\/[^\s>)]+\.pdf(?:[?#][^\s>)]+)?/gi)) {
      const url = match[0]?.replace(/[.,;]+$/g, "") ?? "";
      if (/^https?:\/\//i.test(url) && !links.some((link) => link.url === url)) {
        links.push({ url, label: "PDF file", source, position: match.index ?? 0 });
      }
    }
  }

  return links.map(({ position: _position, ...link }) => link);
}

function extractPathRefsFromText(text: string): string[] {
  return [...text.matchAll(/\/[a-z0-9][a-z0-9/_?=&%.-]*\/?/gi)]
    .map((match) => match[0].replace(/[.,;]+$/g, "").replace(/\/$/, ""))
    .filter((path) => path.length > 1);
}

function cleanExtractedUrl(value: string): string[] {
  const decoded = safeDecode(value).replace(/[.,;]+$/g, "");
  const pieces = decoded.split(/\||%7C/i).map((piece) => piece.trim()).filter(Boolean);
  return pieces
    .map((piece) => piece.replace(/[.,;]+$/g, ""))
    .filter((piece) => /^[a-z0-9.-]+\.[a-z]{2,}|^https?:\/\//i.test(piece));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isLearningCorrection(text: string): boolean {
  return /\b(remember|learn|understand|going forward|next time|for future|should|shouldn't|need to|not needed|not required|ignore|exclude|don't flag|do not flag|no need)\b/i.test(text) &&
    /\b(schema|redirect|301|302|404|status|alert)\b/i.test(text);
}

function normalizeLearningCorrection(text: string): string {
  if (/\bschema\b/i.test(text) && /\b(redirect|301|302|404|status)\b/i.test(text)) {
    return "For schema alerts, check the URL status and final redirected URL first. If the checked URL redirects or returns 404, do not label it as schema removed for that original URL; report the status/redirect and only evaluate schema on the final live page.";
  }

  return text.replace(/\s+/g, " ").trim();
}

function formatUrgencyAnswer(alert: AlertContext): string {
  const highSignals = [
    alert.schemaLines.some((line) => /removed|parse errors/i.test(line)) ? "schema was removed or is failing to parse" : "",
    alert.gaLines.some((line) => /dropped/i.test(line)) ? "GA traffic or conversions dropped" : "",
    alert.gscLines.some((line) => /dropped|avg position worsened/i.test(line)) ? "GSC performance dropped" : ""
  ].filter(Boolean);

  if (highSignals.length) {
    return [
      "*Priority: High*",
      `Reason: ${highSignals.join("; ")}.`,
      "I’d check the affected URL(s), confirm whether this is a real site change, and create a ClickUp task if it is not intentional."
    ].join("\n");
  }

  if (alert.gscLines.some((line) => /spiked/i.test(line))) {
    return "*Priority: Low/monitoring*\nThis looks like a positive or unusual GSC spike rather than an immediate problem. I’d monitor it unless other metrics dropped.";
  }

  return "*Priority: Medium*\nI don’t see a severe drop signal in this thread, but it is worth checking because it triggered monitoring.";
}

function formatWhyAnswer(alert: AlertContext): string {
  const parts = [];
  if (alert.gscLines.length) parts.push(`*GSC:* ${alert.gscLines.slice(0, 3).join(" ")}`);
  if (alert.gaLines.length) parts.push(`*GA4:* ${alert.gaLines.slice(0, 3).join(" ")}`);
  if (alert.schemaLines.length) parts.push(`*Schema:* ${alert.schemaLines.slice(0, 3).join(" ")}`);

  if (!parts.length) {
    return "This alert was generated from the monitoring text in the thread, but I do not see enough structured detail to explain it confidently.";
  }

  return [
    "Here’s why this alert happened:",
    ...parts,
    alert.urls.length ? `Affected URL(s): ${alert.urls.slice(0, 5).join(", ")}` : ""
  ].filter(Boolean).join("\n");
}

function formatAlertSummary(alert: AlertContext): string {
  const lines = [
    alert.gscLines.length ? `*GSC:* ${alert.gscLines.slice(0, 4).join(" ")}` : "",
    alert.gaLines.length ? `*GA4:* ${alert.gaLines.slice(0, 4).join(" ")}` : "",
    alert.schemaLines.length ? `*Schema:* ${alert.schemaLines.slice(0, 4).join(" ")}` : "",
    alert.urls.length ? `*URLs:* ${alert.urls.slice(0, 8).join(", ")}` : ""
  ].filter(Boolean);

  return lines.length ? lines.join("\n") : "I do not see enough structured alert detail in this thread to summarize it confidently.";
}

async function createAlertTaskProposal(
  client: SlackClient,
  channel: string,
  threadTs: string,
  alert: AlertContext,
  requester?: string
) {
  const priority: DraftTask["priority"] = alert.schemaLines.some((line) => /removed|parse errors/i.test(line)) ? 2 : 3;
  const title = `${alert.clientName ?? "Client"} - investigate monitoring alert`;
  const description = [
    `Monitoring alert from Slack thread ${channel}/${threadTs}`,
    "",
    "Alert details:",
    ...alert.alertLines.slice(0, 12),
    alert.urls.length ? `\nAffected URLs:\n${alert.urls.slice(0, 10).map((url) => `- ${url}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");
  const draft: DraftTask = {
    title,
    description,
    assigneeNames: [],
    priority,
    targetListName: alert.clientName
  };

  const message = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Task proposal: ${draft.title}`,
    blocks: proposalBlocks(draft, "pending")
  }) as { ts?: string };

  if (!message.ts) return;

  const proposal = createProposal({
    channel,
    messageTs: message.ts,
    requester: requester ?? "unknown",
    draft
  });

  await client.chat.update({
    channel,
    ts: message.ts,
    text: `Task proposal: ${draft.title}`,
    blocks: proposalBlocks(draft, proposal.id)
  });
}

async function getThreadContext(client: SlackClient, channel: string, threadTs: string): Promise<string> {
  try {
    const response = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20
    });

    return (response.messages ?? [])
      .map((message) => {
        const speaker = message.bot_id ? "Viktor" : message.user ? `<@${message.user}>` : "unknown";
        return `${speaker}: ${message.text ?? ""}`;
      })
      .join("\n")
      .slice(-5000);
  } catch {
    return "";
  }
}

function answerSchemaQuestionFromContext(question: string, context: string): string | undefined {
  if (!/\bschema\b/i.test(question) && !/\bremoved\b/i.test(question)) return undefined;

  const schemaLines = context
    .split(/\r?\n/)
    .filter((line) => /\bschema\b/i.test(line) || /No JSON-LD|Previously saw/i.test(line));

  if (!schemaLines.length) return undefined;

  const urls = schemaLines.flatMap((line) => [...line.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0]));
  const removed = schemaLines.find((line) => /Schema removed|Previously saw/i.test(line));

  if (urls.length) {
    return [
      removed ? "The schema alert is tied to this URL:" : "The schema-related alert is tied to:",
      ...urls.map((url) => `- ${url}`),
      removed ? "It means Viktor had previously seen JSON-LD schema there, but the latest check did not find it." : ""
    ].filter(Boolean).join("\n");
  }

  if (removed) {
    return "That alert came from the homepage schema check for this client. The older alert did not include the exact URL, but new schema alerts will include the checked URL so this is clearer going forward.";
  }

  return undefined;
}

async function getRecentChannelContext(client: SlackClient, channel: string, latest: string): Promise<string> {
  try {
    const response = await client.conversations.history({
      channel,
      latest,
      limit: 12,
      inclusive: true
    });

    return (response.messages ?? [])
      .reverse()
      .map((message) => {
        const speaker = message.bot_id ? "bot" : message.user ? `<@${message.user}>` : "unknown";
        return `${speaker}: ${message.text ?? ""}`;
      })
      .join("\n")
      .slice(-3000);
  } catch {
    return "";
  }
}

async function findChannelByName(client: SlackClient, channelName: string) {
  const cleaned = channelName.trim().replace(/^#/, "");
  if (/^[CG][A-Z0-9]{8,}$/.test(cleaned)) {
    return { id: cleaned, name: cleaned };
  }

  let cursor: string | undefined;
  const target = normalizeSlackChannelName(cleaned);
  const looseTarget = normalizeLoose(cleaned);
  let looseMatch: { id?: string; name?: string; is_member?: boolean; is_private?: boolean } | undefined;

  do {
    const response = await client.conversations.list({
      cursor,
      exclude_archived: true,
      limit: 1000,
      types: "public_channel,private_channel"
    });

    const match = response.channels?.find((channel) => channel.name && normalizeSlackChannelName(channel.name) === target);
    if (match) return match;
    looseMatch ??= response.channels?.find((channel) => {
      if (!channel.name) return false;
      const looseName = normalizeLoose(channel.name);
      return looseName === looseTarget || looseName.includes(looseTarget) || looseTarget.includes(looseName);
    });

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return looseMatch;
}

async function postToChannel(
  client: SlackClient,
  channel: { id?: string; name?: string; is_member?: boolean; is_private?: boolean },
  text: string
) {
  try {
    if (channel.id && channel.is_member === false && !channel.is_private) {
      await client.conversations.join({ channel: channel.id });
    }
    const posted = await client.chat.postMessage({ channel: channel.id ?? channel.name ?? "", text });
    return { ...channel, ts: getSlackMessageTs(posted) };
  } catch (error) {
    const code = extractSlackErrorCode(error);
    if (code === "channel_not_found" && channel.name) {
      const refreshed = await findChannelByName(client, channel.name);
      if (refreshed?.id) {
        if (refreshed.is_member === false && !refreshed.is_private) {
          await client.conversations.join({ channel: refreshed.id });
        }
        const posted = await client.chat.postMessage({ channel: refreshed.id, text });
        return { ...refreshed, ts: getSlackMessageTs(posted) };
      }
    }
    throw error;
  }
}

function getSlackMessageTs(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const ts = (response as { ts?: unknown }).ts;
  return typeof ts === "string" ? ts : undefined;
}

function extractSlackErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\b(channel_not_found|not_in_channel|is_archived)\b/)?.[1];
}

function normalizeSlackChannelName(value: string): string {
  return value
    .trim()
    .replace(/^#/, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function normalizeLoose(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeWorkflowTeam(team?: string): WorkflowTeam | undefined {
  const normalized = normalizeLoose(team ?? "");
  if (/^(team )?ab$/i.test(normalized)) return "Team AB";
  if (/^(team )?cd$/i.test(normalized)) return "Team CD";
  const letter = normalized.match(/^team ([a-d])$/i)?.[1] ?? normalized.match(/^[a-d]$/i)?.[0];
  if (letter) return ["a", "b"].includes(letter.toLowerCase()) ? "Team AB" : "Team CD";
  return WORKFLOW_TEAMS.find((candidate) => normalizeLoose(candidate) === normalized);
}

function teamWorkflowChannelName(team: string | undefined, kind: "daily" | "weekly" | "clickup"): string | undefined {
  const normalizedTeam = normalizeWorkflowTeam(team);
  if (!normalizedTeam) return undefined;
  if (kind === "daily") return DAILY_ALERT_TEAM_CHANNELS[normalizedTeam];
  if (kind === "weekly") return WEEKLY_ALERT_TEAM_CHANNELS[normalizedTeam];
  return CLICKUP_WORKLOAD_TEAM_CHANNELS[normalizedTeam];
}

function workflowTeamMembers(team: string | undefined): string[] | undefined {
  const normalizedTeam = normalizeWorkflowTeam(team);
  return normalizedTeam ? getTeamMembers(normalizedTeam, WORKFLOW_TEAM_MEMBERS[normalizedTeam]) : undefined;
}

async function findChannelForClient(client: SlackClient, targetClient: ClientConfig) {
  if (targetClient.slackChannel) {
    const explicit = await findChannelByName(client, targetClient.slackChannel.replace(/^#/, ""));
    if (explicit) return explicit;
  }

  let cursor: string | undefined;

  do {
    const response = await client.conversations.list({
      cursor,
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel"
    });

    for (const channel of response.channels ?? []) {
      if (!channel.name) continue;
      const inferred = await inferClientFromChannelName(channel.name);
      if (inferred?.client === targetClient.client) return channel;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return undefined;
}

app.action("approve_task", async ({ ack, body, client, logger }) => {
  await ack();

  if (!canUseBot((body as BlockAction).user?.id)) return;
  const action = (body as BlockAction<ButtonAction>).actions[0];
  if (!action || !("value" in action) || !action.value) return;

  await approveProposal(action.value, client as SlackClient, logger);
});

app.action("reject_task", async ({ ack, body, client }) => {
  await ack();

  if (!canUseBot((body as BlockAction).user?.id)) return;
  const action = (body as BlockAction<ButtonAction>).actions[0];
  if (!action || !("value" in action) || !action.value) return;

  const proposal = updateProposalStatus(action.value, "rejected");
  if (!proposal) return;

  try {
    await client.chat.delete({
      channel: proposal.channel,
      ts: proposal.messageTs
    });
  } catch {
    await client.chat.update({
      channel: proposal.channel,
      ts: proposal.messageTs,
      text: proposal.kind === "message" ? "Rejected. I will not send that Slack message." : "Rejected. I will not create this ClickUp task.",
      blocks: []
    });
  }
});

app.action("edit_message_proposal", async ({ ack, body, client }) => {
  await ack();

  const user = (body as BlockAction).user?.id;
  if (!canUseBot(user)) return;
  const action = (body as BlockAction<ButtonAction>).actions[0];
  if (!action || !("value" in action) || !action.value || !user) return;

  const proposal = getProposal(action.value);
  const target = getActionMessageTarget(body as BlockAction);
  if (!proposal || proposal.kind !== "message" || !target) return;

  await client.chat.postEphemeral({
    channel: target.channel,
    user,
    thread_ts: target.ts,
    text: `To edit this safely, reply in this thread with: edit message: <new message>. I will prepare a fresh approval draft instead of sending the current one.`
  });
});

app.action("trust_message_proposal", async ({ ack, body, client, logger }) => {
  await ack();

  if (!canUseBot((body as BlockAction).user?.id)) return;
  const action = (body as BlockAction<ButtonAction>).actions[0];
  if (!action || !("value" in action) || !action.value) return;

  const proposal = getProposal(action.value);
  if (proposal?.kind === "message") {
    rememberTrustedMessageRoute(proposal.requester, proposal.message.targets?.length ? proposal.message.targets : [proposal.message]);
  }
  await approveProposal(action.value, client as SlackClient, logger);
});

app.action("approve_learning", async ({ ack, body, client }) => {
  await ack();

  if (!canUseBot((body as BlockAction).user?.id)) return;
  const action = (body as BlockAction<ButtonAction>).actions?.[0];
  if (!action || !("value" in action) || !action.value) return;

  const rule = await approveLearningSuggestion(action.value);
  const target = getActionMessageTarget(body as BlockAction);
  if (!target) return;

  await client.chat.update({
    channel: target.channel,
    ts: target.ts,
    text: rule ? `Remembered: ${rule.text}` : "I could not find that pending learning suggestion anymore, so I did not save anything.",
    blocks: []
  });
});

app.action("reject_learning", async ({ ack, body, client, respond }) => {
  await ack();

  if (!canUseBot((body as BlockAction).user?.id)) return;
  const action = (body as BlockAction<ButtonAction>).actions?.[0];
  const suggestion = action && "value" in action && action.value
    ? await rejectLearningSuggestion(action.value)
    : undefined;
  const target = getActionMessageTarget(body as BlockAction);
  const text = suggestion ? `Okay, I will not remember this: ${suggestion.text}` : "Okay, I will not remember this.";

  try {
    await respond({
      replace_original: true,
      text,
      blocks: []
    });
    return;
  } catch {
    // Fall back to chat.update below for clients where response_url is unavailable.
  }

  if (target) {
    try {
      await client.chat.update({
        channel: target.channel,
        ts: target.ts,
        text,
        blocks: []
      });
      return;
    } catch {
      try {
        await client.chat.delete({
          channel: target.channel,
          ts: target.ts
        });
        return;
      } catch {
        // Fall through to the response_url path below.
      }
    }
  }

  try {
    await respond({
      delete_original: true,
      text: ""
    });
  } catch {
    // Nothing else to do; the suggestion is already rejected in local memory.
  }
});

function getActionMessageTarget(body: BlockAction): { channel: string; ts: string } | undefined {
  const raw = body as unknown as {
    message?: { ts?: string; channel?: string | { id?: string } };
    channel?: { id?: string };
    container?: { channel_id?: string; message_ts?: string };
  };
  const channel = typeof raw.message?.channel === "string"
    ? raw.message.channel
    : raw.message?.channel?.id
      ?? raw.channel?.id
      ?? raw.container?.channel_id;
  const ts = raw.message?.ts ?? raw.container?.message_ts;
  return channel && ts ? { channel, ts } : undefined;
}

app.event("reaction_added", async (args) => {
  const { client, logger } = args;
  const event = args.event as {
    reaction?: string;
    user?: string;
    item?: {
      type?: string;
      channel?: string;
      ts?: string;
    };
  } | undefined;

  if (event?.reaction !== config.APPROVAL_EMOJI) return;
  if (!canUseBot(event.user)) return;
  if (event.item?.type !== "message" || !event.item.channel || !event.item.ts) return;

  const proposal = getProposalByMessage(event.item.channel, event.item.ts);
  if (!proposal || proposal.status !== "pending") return;

  await approveProposal(proposal.id, client as SlackClient, logger);
});

async function approveProposal(
  proposalId: string,
  client: SlackClient,
  logger: BotLogger
) {
  const proposal = beginProposalApproval(proposalId);
  if (!proposal) return;

  try {
    if (proposal.kind === "message") {
      await client.chat.update({
        channel: proposal.channel,
        ts: proposal.messageTs,
        text: "Approval received. Sending the Slack message now...",
        blocks: []
      });

      await sendPreparedChannelMessage(client, {
        channelId: proposal.message.channelId,
        channelName: proposal.message.channelName,
        isMember: proposal.message.isMember,
        isPrivate: proposal.message.isPrivate,
        text: proposal.message.text,
        targets: proposal.message.targets
      });
      updateProposalStatus(proposal.id, "approved");

      const targets = proposal.message.targets?.length
        ? proposal.message.targets.map((target) => target.kind === "dm" ? target.channelName : `#${target.channelName}`).join(", ")
        : `#${proposal.message.channelName}`;
      await client.chat.update({
        channel: proposal.channel,
        ts: proposal.messageTs,
        text: `Approved and sent to ${targets}.`,
        blocks: []
      });
      return;
    }

    await client.chat.update({
      channel: proposal.channel,
      ts: proposal.messageTs,
      text: "Approval received. Creating the task now...",
      blocks: []
    });

    const workbookTask = await appendTaskToSeoWorkbook(proposal.draft);
    if (workbookTask) {
      const sheetTarget = `<${workbookTask.spreadsheetUrl}|${workbookTask.spreadsheetName ?? "SEO workbook"}>`;
      const rowNote = workbookTask.rowRange ? ` (${workbookTask.rowRange})` : "";
      const text = `Approved and added to ${sheetTarget} -> ${workbookTask.sheetName}${rowNote}. ClickUp sync should create the task from the sheet.`;
      updateProposalStatus(proposal.id, "approved");

      await client.chat.update({
        channel: proposal.channel,
        ts: proposal.messageTs,
        text,
        blocks: []
      });
      return;
    }

    const task = await createClickUpTask(proposal.draft);
    updateProposalStatus(proposal.id, "approved");

    await client.chat.update({
      channel: proposal.channel,
      ts: proposal.messageTs,
      text: `Approved and created in ClickUp: ${task.url}`,
      blocks: []
    });
  } catch (error) {
    logger.error(error);
    updateProposalStatus(proposal.id, "pending");
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";

    await client.chat.postMessage({
      channel: proposal.channel,
      thread_ts: proposal.messageTs,
      text: `Approval received, but task creation failed.${detail} If this was a workbook task, reconnect Google once so Viktor can write to Sheets; otherwise check the ClickUp token/list settings.`
    });
  }
}

try {
  await app.start();
  setInterval(() => undefined, 60 * 60 * 1000);
  logInfo(`${config.BOT_NAME} is running.`);
  logInfo(`Admin dashboard: http://127.0.0.1:${config.ADMIN_DASHBOARD_PORT}`);
  logInfo(`Monitoring enabled. Report channel: ${config.SLACK_REPORT_CHANNEL || "not set"}. Daily hour: ${config.MONITORING_DAILY_HOUR}. Weekly day: ${config.MONITORING_WEEKLY_DAY}. Monthly day: ${config.MONITORING_MONTHLY_DAY}.`);
  console.log(`${config.BOT_NAME} is running.`);
} catch (error) {
  logError(error);
  await releaseSingleInstance();
  throw error;
}

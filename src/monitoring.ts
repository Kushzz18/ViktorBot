import { loadClients, type ClientConfig } from "./clients.js";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { getThreshold } from "./adminSettings.js";
import { fetchGaMonitoring, fetchGscMonitoring, monitoringDateRanges, type GaMonitoringResult, type MetricComparison } from "./monitoringGoogle.js";
import type { StoredTechnicalSnapshot } from "./monitoringStore.js";
import {
  getMonitoringState,
  getTechnicalSnapshot,
  hasAlerted,
  loadMonitoringState,
  markAlerted,
  setLastDailyRun,
  setLastMonthlyRun,
  setLastWeeklyRun,
  setTechnicalSnapshot
} from "./monitoringStore.js";
import { checkIndexableNotIndexed } from "./indexing.js";
import { checkPageSpeed, type PageSpeedHistoryEntry, type PageSpeedStrategyResult } from "./pageSpeed.js";
import { checkSchemaCoverage } from "./schemaCoverage.js";
import { checkClientSite, checkUrl, snapshotFromSiteCheck } from "./siteChecks.js";
import { formatClientKnowledgeForReport, isIgnoredSchemaUrl, isPriorityQuery, isPriorityUrl } from "./clientMemory.js";
import { formatClientDataRequest } from "./clientData.js";
import { formatMetricDelta, formatMetricRows, formatPageLabel } from "./reportFormatting.js";

const DAILY_CLIENT_TIMEOUT_MS = 60_000;
const WEEKLY_SUPPORT_TIMEOUT_MS = 90_000;

export type MonitoringReport = {
  title: string;
  alerts: string[];
  summary: string[];
  paused?: boolean;
};

type MonitoringRunOptions = {
  shouldPause?: () => boolean;
  clientName?: string;
  teamName?: string;
  excludeClientNames?: string[];
  dryRun?: boolean;
  skipTechnical?: boolean;
};

type DueMonitoringOptions = MonitoringRunOptions & {
  excludeClientNamesByKind?: Partial<Record<"daily" | "weekly" | "monthly", string[]>>;
  skipScheduledSummaries?: boolean;
  skipAlertSentMark?: boolean;
};

export async function initializeMonitoring() {
  await loadMonitoringState();
}

export async function runDailyMonitoring(options: MonitoringRunOptions = {}): Promise<MonitoringReport> {
  const allClients = await loadClients();
  const excluded = new Set((options.excludeClientNames ?? []).map((name) => name.toLowerCase()));
  const clients = options.clientName
    ? allClients.filter((client) => client.client.toLowerCase() === options.clientName?.toLowerCase())
    : allClients.filter((client) => !excluded.has(client.client.toLowerCase()) && matchesTeam(client, options.teamName));
  const alerts: string[] = [];
  const summary: string[] = [];

  for (const client of clients) {
    if (options.shouldPause?.()) {
      return {
        title: "Daily monitoring",
        alerts: dedupe(alerts),
        summary,
        paused: true
      };
    }

    const result = await withTimeout(
      monitorClientDaily(client, { dryRun: options.dryRun, skipTechnical: options.skipTechnical }),
      DAILY_CLIENT_TIMEOUT_MS
    );
    if (!result) {
      summary.push(tag(
        "Daily monitoring",
        client.client,
        `Client checks timed out after ${Math.round(DAILY_CLIENT_TIMEOUT_MS / 1000)}s. Skipping this client for this run.`
      ));
      continue;
    }
    alerts.push(...result.alerts);
    summary.push(result.summary);
  }

  return {
    title: "Daily monitoring",
    alerts: dedupe(alerts),
    summary
  };
}

export async function formatDailyGscPreview(clientName: string): Promise<string> {
  const client = (await loadClients()).find((item) => item.client.toLowerCase() === clientName.toLowerCase());
  if (!client) return `I could not find client "${clientName}".`;
  const gsc = await fetchGscMonitoring(client, "daily");
  if (gsc.error) return `GSC preview failed for ${client.client}: ${gsc.error}`;
  if (!gsc.metrics) return `No GSC metrics available for ${client.client}.`;

  return [
    `*Updated test daily GSC alert format - ${client.client}*`,
    "_Manual preview using the current daily comparison. This does not mark any alert as sent._",
    "",
    `*GSC performance - ${client.client}*`,
    `Clicks: ${gsc.metrics.clicks.previous.toFixed(0)} -> ${gsc.metrics.clicks.current.toFixed(0)} (${formatDelta(gsc.metrics.clicks.delta)}, ${formatPct(gsc.metrics.clicks.pctChange)})`,
    `Impressions: ${gsc.metrics.impressions.previous.toFixed(0)} -> ${gsc.metrics.impressions.current.toFixed(0)} (${formatDelta(gsc.metrics.impressions.delta)}, ${formatPct(gsc.metrics.impressions.pctChange)})`,
    `Avg position: ${gsc.metrics.position.previous.toFixed(1)} -> ${gsc.metrics.position.current.toFixed(1)} (${formatDelta(gsc.metrics.position.delta, 1)})`,
    "",
    explainGsc(gsc, client)
  ].filter(Boolean).join("\n");
}

export async function runWeeklySummary(options: MonitoringRunOptions = {}): Promise<MonitoringReport> {
  const daily = await runDailyMonitoring({ ...options, skipTechnical: true });
  if (daily.paused) {
    return {
      title: "Weekly performance summary",
      alerts: daily.alerts,
      summary: daily.summary,
      paused: true
    };
  }

  const allClients = await loadClients();
  const excluded = new Set((options.excludeClientNames ?? []).map((name) => name.toLowerCase()));
  const clients = options.clientName
    ? allClients.filter((client) => client.client.toLowerCase() === options.clientName?.toLowerCase())
    : allClients.filter((client) => !excluded.has(client.client.toLowerCase()) && matchesTeam(client, options.teamName));
  const pageSpeedLines: string[] = [];
  const pageSpeedAlerts: string[] = [];
  const indexingLines: string[] = [];
  const indexingAlerts: string[] = [];

  if (options.shouldPause?.()) {
    return {
      title: "Weekly performance summary",
      alerts: daily.alerts,
      summary: daily.summary,
      paused: true
    };
  }

  const supportResults = await Promise.all(clients.map(async (client) => {
    const lines: string[] = [];
    const alerts: string[] = [];
    const indexLines: string[] = [];
    const indexAlerts: string[] = [];
    const [result, indexing] = await Promise.all([
      withTimeout(checkPageSpeed(client), WEEKLY_SUPPORT_TIMEOUT_MS),
      withTimeout(checkIndexableNotIndexed(client), WEEKLY_SUPPORT_TIMEOUT_MS)
    ]);

    if (!result || result.disabled) {
      // Exclude timed-out or disabled PageSpeed checks instead of posting partial placeholders.
    } else if (result.error) {
      if (!isPageSpeedQuotaOrConfigError(result.error)) alerts.push(tag("PageSpeed", client.client, `PageSpeed failed - ${result.error}`));
    } else if (!result.error) {
      const mobile = result.mobile;
      const desktop = result.desktop;
      lines.push(tag("PageSpeed", client.client, formatPageSpeedComparison(result.previous, mobile, desktop)));

      if (mobile?.status === "poor" || desktop?.status === "poor") {
        const alert = tag("PageSpeed", client.client, `PageSpeed poor - mobile ${mobile?.performanceScore}, desktop ${desktop?.performanceScore}`);
        alerts.push(alert);
        lines.push(alert);
      }

      for (const trendAlert of result.trendAlerts ?? []) {
        const alert = tag("PageSpeed", client.client, trendAlert);
        alerts.push(alert);
        lines.push(alert);
      }
    }

    if (!indexing) return { lines, alerts, indexLines, indexAlerts };

    if (indexing.error && !isTransientNetworkError(indexing.error)) {
      indexAlerts.push(tag("GSC indexing", client.client, `URL inspection failed - ${shorten(indexing.error)}`));
      return { lines, alerts, indexLines, indexAlerts };
    }

    if (indexing.issues.length) {
      indexLines.push(
        ...indexing.issues.slice(0, 10).map((issue) => tag(
          "GSC indexing",
          client.client,
          `${issue.url} - ${issue.coverageState}${issue.indexingState ? ` (${issue.indexingState})` : ""}`
        ))
      );
    }
    return { lines, alerts, indexLines, indexAlerts };
  }));

  for (const result of supportResults) {
    pageSpeedLines.push(...result.lines);
    pageSpeedAlerts.push(...result.alerts);
    indexingLines.push(...result.indexLines);
    indexingAlerts.push(...result.indexAlerts);
  }

  return {
    title: "Weekly performance summary",
    alerts: dedupe([...daily.alerts, ...pageSpeedAlerts, ...indexingAlerts]),
    summary: [...daily.summary, ...pageSpeedLines, ...indexingLines]
  };
}

function formatPageSpeedComparison(
  previous: PageSpeedHistoryEntry | undefined,
  mobile: PageSpeedStrategyResult | undefined,
  desktop: PageSpeedStrategyResult | undefined
): string {
  const previousLabel = previous ? `Previous (${formatShortDate(previous.checkedAt)})` : "Previous";
  const rows = [
    ["Metric", previousLabel, "Current", "Change"],
    ["Mobile score", formatScore(previous?.mobile), formatScore(mobile), formatMetricDeltaValue(previous?.mobile?.performanceScore, mobile?.performanceScore)],
    ["Mobile LCP", formatMs(previous?.mobile?.lcpMs), formatMs(mobile?.lcpMs), formatMetricDeltaValue(previous?.mobile?.lcpMs, mobile?.lcpMs, "ms")],
    ["Mobile INP", formatMs(previous?.mobile?.inpMs), formatMs(mobile?.inpMs), formatMetricDeltaValue(previous?.mobile?.inpMs, mobile?.inpMs, "ms")],
    ["Mobile CLS", formatCls(previous?.mobile?.cls), formatCls(mobile?.cls), formatMetricDeltaValue(previous?.mobile?.cls, mobile?.cls, "cls")],
    ["Desktop score", formatScore(previous?.desktop), formatScore(desktop), formatMetricDeltaValue(previous?.desktop?.performanceScore, desktop?.performanceScore)],
    ["Desktop LCP", formatMs(previous?.desktop?.lcpMs), formatMs(desktop?.lcpMs), formatMetricDeltaValue(previous?.desktop?.lcpMs, desktop?.lcpMs, "ms")],
    ["Desktop INP", formatMs(previous?.desktop?.inpMs), formatMs(desktop?.inpMs), formatMetricDeltaValue(previous?.desktop?.inpMs, desktop?.inpMs, "ms")],
    ["Desktop CLS", formatCls(previous?.desktop?.cls), formatCls(desktop?.cls), formatMetricDeltaValue(previous?.desktop?.cls, desktop?.cls, "cls")]
  ];

  return `PSI comparison\n${formatInlineTable(rows)}`;
}

function formatInlineTable(rows: string[][]): string {
  const widths = rows[0]?.map((_, columnIndex) =>
    Math.max(...rows.map((row) => (row[columnIndex] ?? "").length))
  ) ?? [];
  const formatted = rows.map((row, rowIndex) => {
    const line = row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join(" | ");
    if (rowIndex === 0) {
      const divider = widths.map((width) => "-".repeat(width)).join("-+-");
      return `${line}\n${divider}`;
    }
    return line;
  });
  return `\`\`\`\n${formatted.join("\n")}\n\`\`\``;
}

function formatScore(value?: PageSpeedStrategyResult): string {
  return value?.performanceScore === undefined ? "-" : `${value.performanceScore} (${value.status})`;
}

function formatMs(value?: number): string {
  return value === undefined ? "-" : `${Math.round(value)}ms`;
}

function formatCls(value?: number): string {
  return value === undefined ? "-" : value.toFixed(3);
}

function formatMetricDeltaValue(previous?: number, current?: number, unit?: "ms" | "cls"): string {
  if (previous === undefined || current === undefined) return "-";
  const delta = current - previous;
  const sign = delta > 0 ? "+" : "";
  if (unit === "ms") return `${sign}${Math.round(delta)}ms`;
  if (unit === "cls") return `${sign}${delta.toFixed(3)}`;
  return `${sign}${Math.round(delta)}`;
}

function formatShortDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "previous";
  return parsed.toISOString().slice(0, 10);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch(() => resolve(undefined))
      .finally(() => clearTimeout(timer));
  });
}

function isPageSpeedQuotaOrConfigError(error: string): boolean {
  return /\b(api key is not configured|quota exceeded|rate limit|queries per day)\b/i.test(error);
}

export async function runMonthlySummary(options: MonitoringRunOptions = {}): Promise<MonitoringReport> {
  const weekly = await runWeeklySummary(options);
  if (weekly.paused) {
    return {
      title: "Monthly performance summary",
      alerts: weekly.alerts,
      summary: weekly.summary,
      paused: true
    };
  }

  return {
    title: "Monthly performance summary",
    alerts: weekly.alerts,
    summary: [
      ...weekly.summary,
      "Monthly and 3-month comparison baselines will become richer as Viktor accumulates daily snapshots."
    ]
  };
}

export async function runDueMonitoring(
  send: (report: MonitoringReport, mode: "alerts" | "summary") => Promise<void>,
  options: DueMonitoringOptions = {}
) {
  const state = getMonitoringState();
  const now = new Date();

  const weeklyKey = weeklyReportKey(now);
  if (!options.skipScheduledSummaries && isWeeklyReportWindow(now) && state.lastWeeklyRun !== weeklyKey) {
    if (!options.dryRun && !options.clientName && !options.teamName) await setLastWeeklyRun(weeklyKey);
    const report = await runWeeklySummary({
      ...options,
      excludeClientNames: options.excludeClientNamesByKind?.weekly ?? options.excludeClientNames
    });
    if (report.paused) return;
    if (report.summary.length || report.alerts.length) await send(report, "summary");
  }

  if (!options.skipScheduledSummaries && isMonthlyReportWindow(now) && state.lastMonthlyRun !== monthKey(now)) {
    if (!options.dryRun && !options.clientName && !options.teamName) await setLastMonthlyRun(monthKey(now));
    const report = await runMonthlySummary({
      ...options,
      excludeClientNames: options.excludeClientNamesByKind?.monthly ?? options.excludeClientNames
    });
    if (report.paused) return;
    if (report.summary.length || report.alerts.length) await send(report, "summary");
  }

  const dailyReport = await runDailyMonitoring({
    ...options,
    excludeClientNames: options.excludeClientNamesByKind?.daily ?? options.excludeClientNames
  });
  if (dailyReport.paused) return;
  if (!options.dryRun && !options.clientName && !options.teamName) await setLastDailyRun(todayKey(now));
  if (dailyReport.alerts.length && !options.skipAlertSentMark) await markMonitoringAlertsSent(dailyReport.alerts);
  await send(dailyReport, "alerts");
}

export function hasDailyMonitoringRunToday(): boolean {
  return getMonitoringState().lastDailyRun === todayKey();
}

function matchesTeam(client: ClientConfig, teamName?: string): boolean {
  if (!teamName) return true;
  return normalizeTeamName(client.team) === normalizeTeamName(teamName);
}

function normalizeTeamName(value?: string): string {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const letter = normalized.match(/^team ([a-d])$/)?.[1] ?? normalized.match(/^[a-d]$/)?.[0];
  return letter ? `team ${letter}` : normalized;
}

export async function markMonitoringAlertsSent(alerts: string[]) {
  for (const alert of dedupe(alerts)) {
    await markAlerted(alertDedupeKey(alert));
  }
}

export function formatReport(report: MonitoringReport, mode: "alerts" | "summary" = "summary"): string {
  const lines = mode === "alerts" ? report.alerts : report.summary;
  const fallback = mode === "alerts" ? ["No urgent anomalies detected."] : report.summary;
  const displayLines = lines.length ? lines : fallback;
  const subtitle = reportSubtitle(displayLines, mode);

  return [`*${report.title}*`, subtitle, ...formatGroupedLines(displayLines)]
    .join("\n")
    .slice(0, 39000);
}

export function getReportClients(report: MonitoringReport): string[] {
  return dedupe([...report.alerts, ...report.summary].map((line) => parseTaggedLine(line).client).filter((client): client is string => Boolean(client)));
}

export function getReportClientsForMode(report: MonitoringReport, mode: "alerts" | "summary"): string[] {
  const source = mode === "alerts" ? report.alerts : report.summary;
  return dedupe(source.map((line) => parseTaggedLine(line).client).filter((client): client is string => Boolean(client)));
}

export async function formatReportForClient(report: MonitoringReport, clientName: string, mode: "alerts" | "summary" = "summary"): Promise<string> {
  const source = mode === "alerts" ? report.alerts : report.summary;
  const lines = source.filter((line) => parseTaggedLine(line).client === clientName);
  const clientConfig = mode === "alerts"
    ? (await loadClients()).find((client) => client.client === clientName)
    : undefined;

  if (mode === "summary") {
    const clientKnowledge = formatClientKnowledgeForReport(clientName);
    const period = report.title.toLowerCase().includes("monthly") ? "monthly" : "weekly";
    const detailed = await formatClientDataRequest({
      clientName,
      sources: ["gsc", "ga"],
      period,
      compare: true
    });
    const supportingLines = lines.filter((line) => {
      const sourceName = parseTaggedLine(line).source;
      return sourceName !== "GSC" && sourceName !== "GA4";
    });
    const supporting = supportingLines.length
      ? ["", "*Supporting checks*", ...formatGroupedLines(supportingLines, clientName)].join("\n")
      : "";

    return [`*${report.title} - ${clientName}*`, detailed, clientKnowledge, supporting]
      .filter(Boolean)
      .join("\n")
      .slice(0, 39000);
  }

  const subtitle = reportSubtitle(lines, mode);
  const country = clientConfig ? `Country: ${countryLabel(clientConfig.mainCountry)}` : "";
  return [`*${report.title} - ${clientName}*`, subtitle, country, ...formatGroupedLines(lines, clientName)]
    .filter(Boolean)
    .join("\n")
    .slice(0, 39000);
}

async function monitorClientDaily(client: ClientConfig, options: { dryRun?: boolean; skipTechnical?: boolean } = {}): Promise<{ alerts: string[]; summary: string }> {
  const now = new Date();
  const gaDate = monitoringDateRanges("ga4", "daily").current.endDate;
  const gaProcessedKey = dailyGaProcessedKey(client.client, gaDate);
  const technicalProcessedKey = dailyTechnicalProcessedKey(client.client, todayKey(now));
  const gaAlreadyProcessed = !options.dryRun && hasAlerted(gaProcessedKey);
  const technicalAlreadyProcessed = !options.dryRun && hasAlerted(technicalProcessedKey);
  const shouldRunGa = options.dryRun || (!gaAlreadyProcessed && now.getHours() >= config.MONITORING_DAILY_HOUR);
  const shouldRunTechnical = !options.skipTechnical && (options.dryRun || (!technicalAlreadyProcessed && now.getHours() >= config.MONITORING_DAILY_HOUR));
  const [gsc, ga, site] = await Promise.all([
    fetchGscMonitoring(client, "daily"),
    shouldRunGa ? fetchGaMonitoring(client, "daily") : Promise.resolve(emptyGaResult()),
    shouldRunTechnical ? checkClientSite(client, getTechnicalSnapshot(client.client)) : Promise.resolve(emptySiteResult(client))
  ]);
  const gscDate = gsc.freshness?.current.endDate ?? monitoringDateRanges("gsc", "daily").current.endDate;
  const gscProcessedKey = dailyGscProcessedKey(client.client, gscDate);
  const gscAlreadyProcessed = !options.dryRun && hasAlerted(gscProcessedKey);
  const alerts: string[] = [];

  if (!gscAlreadyProcessed && gsc.error && !isTransientNetworkError(gsc.error) && !isMissingPropertyConfigError(gsc.error)) alerts.push(tag("Data access", client.client, `GSC error - ${shorten(gsc.error)}`));
  if (shouldRunGa && ga.error && !isTransientNetworkError(ga.error) && !isMissingPropertyConfigError(ga.error)) alerts.push(tag("Data access", client.client, `GA4 error - ${shorten(ga.error)}`));

  if (!gscAlreadyProcessed && gsc.metrics && isMonitoringDataFresh(gsc.freshness)) {
    const clickDescription = metricAlertDescription("clicks", gsc.metrics.clicks, "drop-or-spike", 30, 20);
    const impressionDescription = metricAlertDescription("impressions", gsc.metrics.impressions, "drop-or-spike", 35, 100);
    const gscMovements = [
      { metric: "clicks" as const, comparison: gsc.metrics.clicks, description: clickDescription },
      { metric: "impressions" as const, comparison: gsc.metrics.impressions, description: impressionDescription }
    ];
    const historicalContext = assessGscHistoricalContext(gsc, gscMovements);
    if (!historicalContext.suppress) {
      const gscExplanation = [
        gscDateWindowLine(gsc.freshness),
        historicalContext.note,
        explainGscMetricRelationship(gsc.metrics, gscMovements),
        explainGsc(gsc, client, gscFocusFromDescriptions(gscMovements))
      ].filter(Boolean).join("\n\n");
      addCombinedGscAlert(alerts, client, [
        clickDescription,
        impressionDescription
      ], gscExplanation);
    }

    if (!options.dryRun) {
      await markAlerted(gscProcessedKey);
    }
  }

  if (ga.metrics && isMonitoringDataFresh(ga.freshness)) {
    addMetricAlert(alerts, client, "GA4", "active users", ga.metrics.activeUsers, "drop-or-spike", 35, 20, explainTraffic(ga, "activeUsers"));
    addMetricAlert(alerts, client, "GA4", "sessions", ga.metrics.sessions, "drop-or-spike", 35, 20, explainTraffic(ga, "sessions"));
    addMetricAlert(alerts, client, "GA4", "key events", ga.metrics.keyEvents, "drop", 35, 3, explainKeyEvents(ga));
    addRevenueAlert(alerts, client, ga);
    if (!options.dryRun) {
      await markAlerted(gaProcessedKey);
    }
  }

  for (const alert of site.alerts) {
    if (isAccessBlockedAlert(alert)) {
      continue;
    } else if (isSchemaAlert(alert)) {
      alerts.push(tag("Schema", client.client, `homepage schema issue - ${alert} - ${site.url}`));
    } else if (isRobotsAlert(alert)) {
      alerts.push(tag("Technical", client.client, `homepage robots issue - ${alert} - ${site.url}`));
    }
  }

  if (shouldRunTechnical && shouldStoreTechnicalSnapshot(site)) {
    await setTechnicalSnapshot(client.client, snapshotFromSiteCheck(site));
  }
  const robotsTxtAlert = shouldRunTechnical ? await checkRobotsTxtChange(client) : undefined;
  if (robotsTxtAlert) alerts.push(robotsTxtAlert);

  const moneyPageSchemaAlerts = shouldRunTechnical ? await checkMoneyPageSchemas(client) : [];
  const schemaCoverageAlerts = shouldRunTechnical ? await checkSchemaCoverage(client) : [];
  alerts.push(...moneyPageSchemaAlerts, ...schemaCoverageAlerts);
  if (shouldRunTechnical && !options.dryRun) {
    await markAlerted(technicalProcessedKey);
  }

  const summary = [
    gscAlreadyProcessed ? tag("GSC", client.client, `already processed daily data for ${gscDate}`) : gsc.metrics ? tag("GSC", client.client, isMonitoringDataFresh(gsc.freshness) ? `${gscDateWindowLine(gsc.freshness)} clicks ${formatChange(gsc.metrics.clicks)}, impressions ${formatChange(gsc.metrics.impressions)}, avg position ${gsc.metrics.position.current.toFixed(1)} (${formatDelta(gsc.metrics.position.delta, 1)})` : `waiting for latest daily data (${gsc.freshness?.current.endDate ?? "latest target day"})`) : tag("GSC", client.client, "unavailable"),
    gsc.topPages.length ? tag("GSC", client.client, `top page: ${shortUrl(gsc.topPages[0]?.page)} (${gsc.topPages[0]?.clicks.current ?? 0} clicks, ${formatDelta(gsc.topPages[0]?.clicks.delta ?? 0)} vs previous)`) : "",
    gsc.topQueries.length ? tag("GSC", client.client, `top query: "${gsc.topQueries[0]?.query}" (${gsc.topQueries[0]?.clicks.current ?? 0} clicks, ${formatDelta(gsc.topQueries[0]?.clicks.delta ?? 0)} vs previous)`) : "",
    gaAlreadyProcessed ? tag("GA4", client.client, `already processed daily data for ${gaDate}`) : !shouldRunGa ? tag("GA4", client.client, `waiting for ${config.MONITORING_DAILY_HOUR}:00 local daily check`) : ga.metrics ? tag("GA4", client.client, isMonitoringDataFresh(ga.freshness) ? `users ${formatChange(ga.metrics.activeUsers)}, sessions ${formatChange(ga.metrics.sessions)}, key events ${formatChange(ga.metrics.keyEvents)}` : `waiting for latest daily data (${ga.freshness?.current.endDate ?? "latest target day"})`) : tag("GA4", client.client, "unavailable"),
    ga.metrics?.totalRevenue && ga.metrics.totalRevenue.current > 0 ? tag("GA4", client.client, `revenue ${formatChange(ga.metrics.totalRevenue)}`) : "",
    ga.metrics?.ecommercePurchases && ga.metrics.ecommercePurchases.current > 0 ? tag("GA4", client.client, `purchases ${formatChange(ga.metrics.ecommercePurchases)}`) : "",
    ga.topChannels.length ? tag("GA4", client.client, `top channel: ${ga.topChannels[0]?.channel} (${ga.topChannels[0]?.sessions ?? 0} sessions, ${ga.topChannels[0]?.activeUsers ?? 0} users)`) : "",
    technicalAlreadyProcessed ? tag("Technical", client.client, `already processed daily site checks for ${todayKey(now)}`) : tag("Schema", client.client, `homepage schema ${site.schemaTypes.length ? site.schemaTypes.slice(0, 5).join(", ") : "none"}`)
  ].filter(Boolean).join("\n");

  const uniqueAlerts = [];
  for (const alert of alerts) {
    if (options.dryRun) {
      if (parseTaggedLine(alert).source === "Schema" && hasAlertedForAlert(alert)) {
        continue;
      }
    } else if (hasAlertedForAlert(alert)) {
      continue;
    }
    if (!hasAlertedForAlert(alert)) uniqueAlerts.push(alert);
  }

  const hasGscOrGaAnomaly = uniqueAlerts.some((alert) => {
    const source = parseTaggedLine(alert).source;
    return source === "GSC" || source === "GA4";
  });
  const publishableAlerts = hasGscOrGaAnomaly
    ? uniqueAlerts
    : uniqueAlerts.filter((alert) => parseTaggedLine(alert).source !== "Schema");

  return { alerts: publishableAlerts, summary };
}

function alertDedupeKey(alert: string): string {
  const schemaKey = schemaAlertIdentity(alert);
  const metricKey = metricAlertIdentity(alert);
  if (metricKey) return metricKey;
  return schemaKey ? `${weekKey()}:schema:${schemaKey}` : `${dailyAlertDataKey(alert)}:${alert}`;
}

function dailyGscProcessedKey(clientName: string, date: string): string {
  return `gsc-processed:${date}:${normalizeIdentityPart(clientName)}`;
}

function dailyGaProcessedKey(clientName: string, date: string): string {
  return `ga4-processed:${date}:${normalizeIdentityPart(clientName)}`;
}

function dailyTechnicalProcessedKey(clientName: string, date: string): string {
  return `technical-processed:${date}:${normalizeIdentityPart(clientName)}`;
}

function emptyGscResult(): Awaited<ReturnType<typeof fetchGscMonitoring>> {
  return {
    dailyHistory: [],
    topPages: [],
    topQueries: [],
    topPageQueries: [],
    pageMovers: [],
    queryMovers: [],
    priorityPages: [],
    priorityQueries: [],
    searchAppearances: []
  };
}

function emptyGaResult(): Awaited<ReturnType<typeof fetchGaMonitoring>> {
  return {
    topChannels: [],
    trafficBreakdown: [],
    keyEventBreakdown: [],
    revenueBreakdown: []
  };
}

function emptySiteResult(client: ClientConfig): Awaited<ReturnType<typeof checkClientSite>> {
  return {
    url: client.gscSite?.startsWith("http") ? client.gscSite : "",
    ok: true,
    dnsOk: true,
    noindex: false,
    alerts: [],
    schemaTypes: [],
    schemaErrors: []
  };
}

function hasAlertedForAlert(alert: string): boolean {
  const key = alertDedupeKey(alert);
  if (hasAlerted(key)) return true;

  const metricLegacyPrefix = legacyMetricAlertPrefix(alert);
  if (metricLegacyPrefix) {
    const state = getMonitoringState();
    if (Object.keys(state.alertedKeys).some((storedKey) => storedKey.startsWith(metricLegacyPrefix))) return true;
  }

  const schemaKey = schemaAlertIdentity(alert);
  if (!schemaKey) return false;
  if (schemaAlertDedupeKeys(schemaKey).some((schemaDedupeKey) => hasAlerted(schemaDedupeKey))) return true;

  const state = getMonitoringState();
  const legacyPrefixes = schemaFollowUpWeekKeys().map((keyPart) => `${keyPart}:[Schema] `);
  const [, client = "", issue = "", url = ""] = schemaKey.match(/^([^:]+):([^:]+):(.+)$/) ?? [];
  return Object.keys(state.alertedKeys).some((storedKey) => {
    const storedUrl = extractLastUrl(storedKey);
    return legacyPrefixes.some((prefix) => storedKey.startsWith(prefix)) &&
      storedKey.includes(`${client}:`) &&
      Boolean(storedUrl && normalizeAlertUrl(storedUrl) === url) &&
      schemaAlertIssue(storedKey) === issue;
  });
}

function schemaAlertDedupeKeys(schemaKey: string): string[] {
  return schemaFollowUpWeekKeys().map((keyPart) => `${keyPart}:schema:${schemaKey}`);
}

function schemaFollowUpWeekKeys(date = new Date()): string[] {
  return [weekKey(date), weekKey(addDays(date, -7))];
}

function metricAlertIdentity(alert: string): string | undefined {
  const parsed = parseTaggedLine(alert);
  if (!parsed.client || (parsed.source !== "GA4" && parsed.source !== "GSC")) return undefined;
  const parts = metricAlertParts(parsed.source, parsed.message);
  if (!parts.length) return undefined;
  const date = parsed.source === "GSC" ? gscCurrentDateFromMessage(parsed.message) : monitoringDateRanges("ga4", "daily").current.endDate;
  return [
    parsed.source.toLowerCase(),
    date,
    normalizeIdentityPart(parsed.client),
    ...parts
  ].join(":");
}

function legacyMetricAlertPrefix(alert: string): string | undefined {
  const parsed = parseTaggedLine(alert);
  if (!parsed.client || (parsed.source !== "GA4" && parsed.source !== "GSC")) return undefined;
  const parts = metricAlertParts(parsed.source, parsed.message);
  if (!parts.length) return undefined;
  const [firstPart] = parts;
  const [metric, direction] = firstPart.split("-");
  if (!metric || !direction) return undefined;
  const dataKey = dailyAlertDataKey(alert);
  return `${dataKey}:[${parsed.source}] ${parsed.client}: ${metric.replace(/-/g, " ")} ${direction}`;
}

function metricAlertParts(source: string, message: string): string[] {
  const lower = message.toLowerCase();
  const labels = source === "GA4"
    ? ["active users", "sessions", "key events", "revenue"]
    : ["clicks", "impressions"];

  return labels.flatMap((label) => {
    const safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = lower.match(new RegExp(`\\b${safeLabel}\\s+(dropped|spiked)\\b`));
    return match?.[1] ? [`${label.replace(/\s+/g, "-")}-${match[1]}`] : [];
  });
}

function normalizeIdentityPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function schemaAlertIdentity(alert: string): string | undefined {
  if (!alert.includes("[Schema]")) return undefined;
  const parsed = parseTaggedLine(alert);
  if (!parsed.client) return undefined;
  const url = extractLastUrl(parsed.message);
  if (!url) return undefined;
  return `${parsed.client}:${schemaAlertIssue(alert)}:${normalizeAlertUrl(url)}`;
}

function schemaAlertIssue(alert: string): string {
  if (/No JSON-LD schema/i.test(alert)) return "no-jsonld";
  if (/Schema removed/i.test(alert)) return "schema-removed";
  if (/Schema JSON parse errors/i.test(alert)) return "schema-parse";
  if (/missing expected schema/i.test(alert)) return "missing-expected";
  return "schema";
}

function isAccessBlockedAlert(alert: string): boolean {
  return /\b(bot|site access) blocked\b|captcha|SiteGround verification/i.test(alert);
}

function detectRobotsAccessBlock(text: string, finalUrl?: string): string | undefined {
  const haystack = `${finalUrl ?? ""}\n${text}`.toLowerCase();
  if (haystack.includes("/.well-known/sgcaptcha") || haystack.includes("sgcaptcha") || haystack.includes("siteground")) {
    return "SiteGround verification/captcha page";
  }
  if (/\b(cloudflare|cf-chl|turnstile|checking your browser|verify you are human|captcha|recaptcha|access denied|blocked by)\b/i.test(haystack)) {
    return "anti-bot/captcha page";
  }
  return undefined;
}

function extractLastUrl(value: string): string | undefined {
  return [...value.matchAll(/https?:\/\/[^\s>)]+/gi)].at(-1)?.[0]?.replace(/[.,;]+$/g, "");
}

function normalizeAlertUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

async function checkMoneyPageSchemas(client: ClientConfig): Promise<string[]> {
  if (!client.moneyPages?.length) return [];

  const alerts: string[] = [];

  for (const page of client.moneyPages) {
    const snapshotKey = `${client.client}:${page.url}`;
    const result = await checkUrl(page.url, getTechnicalSnapshot(snapshotKey), { alertWhenNoSchema: true });
    const missing = shouldStoreTechnicalSnapshot(result)
      ? (page.expectedSchemaTypes ?? []).filter((type) => !result.schemaTypes.includes(type))
      : [];

    if (missing.length) {
        alerts.push(tag("Schema", client.client, `money page missing expected schema (${missing.join(", ")}) - ${page.url}`));
    }

    for (const alert of result.alerts) {
      if (isAccessBlockedAlert(alert)) {
        continue;
      } else if (alert.includes("Schema removed") || alert.includes("Schema JSON parse errors") || alert.includes("No JSON-LD schema")) {
        if (!isIgnoredSchemaUrl(client.client, page.url)) {
          alerts.push(tag("Schema", client.client, `money page schema issue - ${alert} - ${page.url}`));
        }
      } else if (isRobotsAlert(alert)) {
        alerts.push(tag("Technical", client.client, `money page robots issue - ${alert} - ${page.url}`));
      }
    }

    if (shouldStoreTechnicalSnapshot(result)) {
      await setTechnicalSnapshot(snapshotKey, snapshotFromSiteCheck(result));
    }
  }

  return alerts;
}

async function checkRobotsTxtChange(client: ClientConfig): Promise<string | undefined> {
  try {
    const robotsUrl = new URL("/robots.txt", homepageFromClient(client)).toString();
    const response = await fetch(robotsUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ViktorBot/0.1; +https://rankmetop.com/seo-monitoring)"
      }
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    const accessBlockReason = detectRobotsAccessBlock(text, response.url);
    if (accessBlockReason) {
      return undefined;
    }
    const normalized = normalizeRobotsTxt(text);
    const hash = createHash("sha256").update(normalized).digest("hex");
    const key = `${client.client}:robots.txt`;
    const previous = getTechnicalSnapshot(key);
    const snapshot: StoredTechnicalSnapshot = {
      schemaTypes: [],
      robotsTxtHash: hash,
      robotsTxtPreview: previewRobotsTxt(normalized)
    };

    await setTechnicalSnapshot(key, snapshot);

    if (previous?.robotsTxtHash && previous.robotsTxtHash !== hash) {
      return tag("Technical", client.client, [
        "robots.txt changed.",
        "Previous robots.txt:",
        "```",
        compactRobotsPreview(previous.robotsTxtPreview),
        "```",
        "Current robots.txt:",
        "```",
        compactRobotsPreview(snapshot.robotsTxtPreview),
        "```"
      ].join("\n"));
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function addMetricAlert(
  alerts: string[],
  client: ClientConfig,
  source: string,
  label: string,
  comparison: MetricComparison | undefined,
  mode: "drop" | "drop-or-spike",
  pctThreshold: number,
  absoluteThreshold: number,
  explanation?: string
) {
  if (!comparison || comparison.pctChange === null) return;
  const pct = comparison.pctChange;
  const absolute = Math.abs(comparison.delta);
  const threshold = getThreshold(`${source} ${label}`, pctThreshold, absoluteThreshold);
  if (absolute < threshold.absolute) return;

  if (pct <= -threshold.pct) {
    alerts.push(tag(source, client.client, `${label} dropped ${Math.abs(pct).toFixed(0)}% (${comparison.previous.toFixed(0)} -> ${comparison.current.toFixed(0)}).${explanation ? `\n${explanation}` : ""}`.trim()));
  }

  if (mode === "drop-or-spike" && pct >= threshold.pct) {
    alerts.push(tag(source, client.client, `${label} spiked ${pct.toFixed(0)}% (${comparison.previous.toFixed(0)} -> ${comparison.current.toFixed(0)}).${explanation ? `\n${explanation}` : ""}`.trim()));
  }
}

function addRevenueAlert(alerts: string[], client: ClientConfig, ga: GaMonitoringResult) {
  const revenue = ga.metrics?.totalRevenue;
  const purchases = ga.metrics?.ecommercePurchases;
  if (!revenue || revenue.pctChange === null) return;
  const threshold = getThreshold("GA4 revenue", 35, 50);
  if (Math.abs(revenue.delta) < threshold.absolute || revenue.pctChange > -threshold.pct) return;

  const purchasePct = purchases?.pctChange;
  const purchaseDelta = purchases?.delta ?? 0;
  const purchasesAlsoDropped = purchasePct !== null && purchasePct !== undefined
    ? purchasePct <= -30
    : purchaseDelta <= -3;
  if (!purchasesAlsoDropped) return;

  const explanation = explainRevenue(ga);
  alerts.push(tag("GA4", client.client, `revenue dropped ${Math.abs(revenue.pctChange).toFixed(0)}% (${revenue.previous.toFixed(0)} -> ${revenue.current.toFixed(0)}).${explanation ? `\n${explanation}` : ""}`.trim()));
}

function addCombinedGscAlert(
  alerts: string[],
  client: ClientConfig,
  descriptions: Array<string | undefined>,
  explanation?: string
) {
  const matched = descriptions.filter((description): description is string => Boolean(description));
  if (!matched.length) return;
  alerts.push(tag("GSC", client.client, `${matched.join(", ")}.${explanation ? `\n${explanation}` : ""}`.trim()));
}

function metricAlertDescription(
  label: string,
  comparison: MetricComparison | undefined,
  mode: "drop" | "drop-or-spike",
  pctThreshold: number,
  absoluteThreshold: number
): string | undefined {
  if (!comparison || comparison.pctChange === null) return undefined;
  const pct = comparison.pctChange;
  const absolute = Math.abs(comparison.delta);
  const threshold = getThreshold(`GSC ${label}`, pctThreshold, absoluteThreshold);
  if (absolute < threshold.absolute) return undefined;

  if (pct <= -threshold.pct) {
    return `${label} dropped ${Math.abs(pct).toFixed(0)}% (${comparison.previous.toFixed(0)} -> ${comparison.current.toFixed(0)})`;
  }

  if (mode === "drop-or-spike" && pct >= threshold.pct) {
    return `${label} spiked ${pct.toFixed(0)}% (${comparison.previous.toFixed(0)} -> ${comparison.current.toFixed(0)})`;
  }

  return undefined;
}

type GscMovementCandidate = {
  metric: "clicks" | "impressions";
  comparison: MetricComparison;
  description?: string;
};

function assessGscHistoricalContext(
  gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>,
  movements: GscMovementCandidate[]
): { suppress: boolean; note?: string } {
  const active = movements.filter((item) => Boolean(item.description));
  if (!active.length || gsc.dailyHistory.length < 21) return { suppress: false };

  const seasonal = active.filter((item) => looksLikeNormalDailyCycle(gsc.dailyHistory, item.metric, item.comparison));
  if (seasonal.length !== active.length) {
    return seasonal.length
      ? { suppress: false, note: "Historical context: part of this movement matches the recent daily cycle, so review the driver rows before treating it as urgent." }
      : { suppress: false };
  }

  const labels = seasonal.map((item) => item.metric === "clicks" ? "clicks" : "impressions").join(" and ");
  return {
    suppress: true,
    note: `Historical context: ${labels} are moving inside the recent daily cycle, so Viktor is holding this as normal fluctuation instead of posting a daily anomaly.`
  };
}

function looksLikeNormalDailyCycle(
  history: Array<{ date: string; clicks: number; impressions: number }>,
  metric: "clicks" | "impressions",
  comparison: MetricComparison
): boolean {
  const points = history
    .map((point) => ({ ...point, value: point[metric] }))
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length < 21 || comparison.current <= 0 || comparison.previous <= 0) return false;

  const latest = points[points.length - 1];
  if (!latest) return false;
  const previousPoints = points.slice(0, -1);
  const weekday = new Date(`${latest.date}T00:00:00.000Z`).getUTCDay();
  const sameWeekday = previousPoints
    .filter((point) => new Date(`${point.date}T00:00:00.000Z`).getUTCDay() === weekday)
    .map((point) => point.value);
  const baseline = sameWeekday.length >= 4 ? sameWeekday : previousPoints.slice(-28).map((point) => point.value);
  if (baseline.length < 7 && sameWeekday.length < 4) return false;

  const range = robustRange(baseline);
  const withinRange = comparison.current >= range.low && comparison.current <= range.high;
  const recentValues = previousPoints.slice(-14).map((point) => point.value);
  const recentSpread = coefficientOfVariation(recentValues);
  const recoveredRecently = recentlyRecoveredFromSimilarMovement(points, metric, comparison.delta);

  return withinRange && (recentSpread >= 0.35 || recoveredRecently);
}

function robustRange(values: number[]): { low: number; high: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  const medianValue = median(sorted);
  const deviations = sorted.map((value) => Math.abs(value - medianValue)).sort((a, b) => a - b);
  const mad = median(deviations) || Math.max(1, medianValue * 0.15);
  const low = Math.max(0, Math.min(medianValue - (mad * 3), p10 * 0.7));
  const high = Math.max(medianValue + (mad * 3), p90 * 1.3);
  return { low, high };
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * percentileValue)));
  return values[index] ?? 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] ?? 0 : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 7) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (avg <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance) / avg;
}

function recentlyRecoveredFromSimilarMovement(
  points: Array<{ date: string; clicks: number; impressions: number; value: number }>,
  metric: "clicks" | "impressions",
  currentDelta: number
): boolean {
  const recent = points.slice(-15);
  if (recent.length < 8) return false;
  const direction = currentDelta >= 0 ? 1 : -1;
  const deltas = recent.slice(1).map((point, index) => point[metric] - (recent[index]?.[metric] ?? 0));
  return deltas.some((delta, index) => {
    const nextDelta = deltas[index + 1];
    return Math.sign(delta) === direction && nextDelta !== undefined && Math.sign(nextDelta) === -direction && Math.abs(nextDelta) >= Math.abs(delta) * 0.5;
  });
}

function explainGscMetricRelationship(
  metrics: NonNullable<Awaited<ReturnType<typeof fetchGscMonitoring>>["metrics"]>,
  movements: GscMovementCandidate[]
): string {
  const active = movements.filter((item) => Boolean(item.description));
  if (!active.length) return "";

  const clickDirection = Math.sign(metrics.clicks.delta);
  const impressionDirection = Math.sign(metrics.impressions.delta);
  if (clickDirection === 0 || impressionDirection === 0) return "";

  if (clickDirection === impressionDirection) {
    const direction = clickDirection > 0 ? "increased" : "dropped";
    return `Metric relationship: clicks and impressions both ${direction}, so the driver rows below show the wider visibility + traffic picture instead of treating one metric in isolation.`;
  }

  if (metrics.impressions.delta < 0 && metrics.clicks.delta > 0) {
    return "Metric relationship: impressions dropped while clicks rose, so this looks more like visibility mix/CTR movement than a traffic loss.";
  }

  if (metrics.impressions.delta > 0 && metrics.clicks.delta < 0) {
    return "Metric relationship: impressions rose while clicks dropped, so check query/page relevance, CTR, and ranking/snippet changes.";
  }

  return "";
}

function formatChange(comparison: MetricComparison): string {
  const pct = comparison.pctChange === null ? "new" : `${comparison.pctChange >= 0 ? "+" : ""}${comparison.pctChange.toFixed(0)}%`;
  return `${comparison.current.toFixed(0)} (${pct})`;
}

function formatDelta(value: number, digits = 0): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

type GscFocus = Array<{ metric: "clicks" | "impressions"; direction: "up" | "down" }>;

function gscFocusFromDescriptions(items: Array<{ metric: "clicks" | "impressions"; comparison: MetricComparison; description?: string }>): GscFocus {
  return items
    .filter((item) => Boolean(item.description))
    .map((item) => ({
      metric: item.metric,
      direction: item.comparison.delta >= 0 ? "up" as const : "down" as const
    }));
}

function explainGsc(gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>, client: ClientConfig, focus: GscFocus = []): string {
  const focused = focus.length ? focus : [
    { metric: "clicks" as const, direction: "down" as const },
    { metric: "impressions" as const, direction: "down" as const }
  ];
  const sections: string[] = [];
  const seen = new Set<string>();
  const pageRows = gsc.pageMovers.map((page) => ({
    item: formatPageLabel(page.page),
    clicks: page.clicks,
    impressions: page.impressions
  }));
  const queryRows = gsc.queryMovers.map((query) => ({
    item: query.query,
    clicks: query.clicks,
    impressions: query.impressions
  }));

  const addSection = (title: string, body: string) => {
    if (!body || seen.has(title)) return;
    seen.add(title);
    sections.push(body);
  };

  for (const item of focused) {
    const metricLabel = item.metric === "clicks" ? "clicks" : "impression";
    const movementLabel = item.direction === "up" ? "gains" : "drops";

    addSection(
      `Pages - top 5 ${metricLabel} ${movementLabel}`,
      formatGscDriverSection(`Pages - top 5 ${metricLabel} ${movementLabel}`, gscDirectionalRows(pageRows, item.metric, item.direction))
    );
    addSection(
      `Queries - top 5 ${metricLabel} ${movementLabel}`,
      formatGscDriverSection(`Queries - top 5 ${metricLabel} ${movementLabel}`, gscDirectionalRows(queryRows, item.metric, item.direction))
    );
    addSection(
      `Page + query - top 5 ${metricLabel} ${movementLabel}`,
      formatGscPageQueryDriverList(
        `Page + query - top 5 ${metricLabel} ${movementLabel}`,
        gscDirectionalRows(gsc.topPageQueries, item.metric, item.direction),
        client,
        false
      )
    );
    addSection(
      `Search appearance ${metricLabel} ${movementLabel}`,
      formatGscDriverSection(
        `Search appearance ${metricLabel} ${movementLabel}`,
        gscDirectionalRows(gsc.searchAppearances.map((row) => ({
          item: row.item,
          clicks: row.clicks,
          impressions: row.impressions
        })), item.metric, item.direction)
      )
    );
  }

  addSection(
    "Priority page + query spike/drop analysis",
    formatGscPageQueryDriverList("Priority page + query spike/drop analysis", priorityMonitoringPageQueryRows(gsc, client), client, true)
  );

  return sections.join("\n\n");
}

function gscDirectionalRows(
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>,
  metric: "clicks" | "impressions",
  direction: "up" | "down"
): Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }> {
  return rows
    .filter((row) => direction === "up" ? row[metric].delta > 0 : row[metric].delta < 0)
    .sort((a, b) => Math.abs(b[metric].delta) - Math.abs(a[metric].delta))
    .slice(0, 5);
}

function priorityMonitoringPageQueryRows(gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>, client: ClientConfig): Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }> {
  return gsc.topPageQueries
    .filter((row) => {
      const [page, query] = row.item.split(" | ");
      return isPriorityUrl(client.client, page ?? "") || isPriorityQuery(client.client, query ?? "");
    })
    .filter((row) =>
      Math.abs(row.clicks.delta) >= 1 ||
      Math.abs(row.impressions.delta) >= 25 ||
      Math.abs(row.clicks.pctChange ?? 0) >= 50 ||
      Math.abs(row.impressions.pctChange ?? 0) >= 50
    )
    .sort((a, b) => Math.abs(b.clicks.delta) * 100 + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) * 100 + Math.abs(a.impressions.delta)))
    .slice(0, 5);
}

function isMeaningfulGscDriver(comparison: MetricComparison): boolean {
  return Math.abs(comparison.delta) >= 5 || Math.abs(comparison.pctChange ?? 0) >= 25;
}

function explainTraffic(ga: Awaited<ReturnType<typeof fetchGaMonitoring>>, metric: "sessions" | "activeUsers"): string {
  const metricDelta = metric === "sessions" ? ga.metrics?.sessions?.delta : ga.metrics?.activeUsers?.delta;
  const direction = (metricDelta ?? 0) >= 0 ? "up" : "down";
  const rows = ga.trafficBreakdown
    .filter((row) => row.sessions.current > 0 || row.sessions.previous > 0 || (row.activeUsers?.current ?? 0) > 0 || (row.activeUsers?.previous ?? 0) > 0)
    .map((row) => {
      const main = metric === "sessions" ? row.sessions : row.activeUsers ?? row.sessions;
      return {
        item: humanGaLabel(row.label),
        main,
        sessions: `${row.sessions.previous.toFixed(0)} -> ${row.sessions.current.toFixed(0)}`,
        users: row.activeUsers ? `${row.activeUsers.previous.toFixed(0)} -> ${row.activeUsers.current.toFixed(0)}` : "-"
      };
    })
    .filter((row) => direction === "up" ? row.main.delta > 0 : row.main.delta < 0)
    .sort((a, b) => Math.abs(b.main.delta) - Math.abs(a.main.delta))
    .slice(0, 6);

  return rows.length ? `Likely traffic drivers:\n${formatGaDriverList(rows, metric === "sessions" ? "Sessions" : "Users")}` : "";
}

function explainKeyEvents(ga: Awaited<ReturnType<typeof fetchGaMonitoring>>): string {
  const sections = [
    formatMetricDriverSection("Key events by event", ga.keyEventBreakdown, "eventName", "Event", "Key events"),
    formatMetricDriverSection("Key events by source / medium", ga.keyEventBreakdown, "sessionSourceMedium", "Source / medium", "Key events"),
    formatMetricDriverList("Key events by landing page", ga.keyEventBreakdown, "landingPagePlusQueryString", "Key events")
  ].filter(Boolean);

  return sections.length ? `Likely key-event drivers:\n${sections.join("\n\n")}` : "";
}

function explainRevenue(ga: Awaited<ReturnType<typeof fetchGaMonitoring>>): string {
  const sections = [
    formatRevenueDriverSection("Revenue by channel", ga.revenueBreakdown, "sessionDefaultChannelGroup"),
    formatRevenueDriverSection("Revenue by source / medium", ga.revenueBreakdown, "sessionSourceMedium"),
    formatRevenueDriverList("Revenue by landing page", ga.revenueBreakdown, "landingPagePlusQueryString"),
    formatRevenueDriverList("Revenue by item", ga.revenueBreakdown, "itemName")
  ].filter(Boolean);

  return sections.length ? `Likely revenue drivers:\n${sections.join("\n\n")}` : "";
}

function formatGscDriverSection(
  title: string,
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>
): string {
  if (!rows.length) return "";
  return [`*${title}*`, ...formatGscMonitoringRows(rows)].join("\n");
}

function formatGscMonitoringRows(rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>): string[] {
  return formatMetricRows(rows.map((row) => ({
    label: row.item,
    clicks: row.clicks,
    impressions: row.impressions
  })), true);
}

function formatGscDriverList(
  title: string,
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison; priority?: boolean }>
): string {
  if (!rows.length) return "";

  return [
    `*${title}*`,
    ...rows.map((row, index) => [
      `${index + 1}. ${row.item}${row.priority ? " â€” *priority item*" : ""}`,
      `   Clicks: ${row.clicks.previous.toFixed(0)} -> ${row.clicks.current.toFixed(0)} (${formatDelta(row.clicks.delta)}, ${formatPct(row.clicks.pctChange)})`,
      `   Impressions: ${row.impressions.previous.toFixed(0)} -> ${row.impressions.current.toFixed(0)} (${formatDelta(row.impressions.delta)}, ${formatPct(row.impressions.pctChange)})`,
      row.priority ? "   Priority note: this matches the saved priority list, so review it before lower-priority movement." : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

function formatGscPageQueryDriverList(
  title: string,
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>,
  client: ClientConfig,
  includePriorityNotes = true
): string {
  if (!rows.length) return "";

  return [
    `*${title}*`,
    ...rows.map((row, index) => {
      const [page, query] = row.item.split(" | ");
      const priorityUrl = isPriorityUrl(client.client, page || "");
      const priorityQuery = isPriorityQuery(client.client, query || "");
      const priorityText = includePriorityNotes && (priorityUrl || priorityQuery) ? "\n   Priority note: saved priority page/query match. Treat this as higher urgency." : "";
      return `${index + 1}. ${formatPageLabel(page || "(not set)")}${includePriorityNotes && priorityUrl ? " - *priority URL*" : ""}\n   Query: "${query || "(not set)"}"${includePriorityNotes && priorityQuery ? " - *priority query*" : ""}\n   Clicks: ${row.clicks.previous.toFixed(0)} -> ${row.clicks.current.toFixed(0)} (${formatMetricDelta(row.clicks)})\n   Impressions: ${row.impressions.previous.toFixed(0)} -> ${row.impressions.current.toFixed(0)} (${formatMetricDelta(row.impressions)})${priorityText}`;
    })
  ].join("\n");
}

function formatPct(value: number | null): string {
  if (value === null) return "new";
  return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`;
}

function formatGaDriverTable(rows: Array<{ item: string; metric: string; delta: string; sessions: string; users: string }>, metricLabel: string): string {
  return codeTable(
    ["Driver", metricLabel, "+/-", "Sessions", "Users"],
    rows.map((row) => [row.item, row.metric, row.delta, row.sessions, row.users])
  );
}

function formatGaDriverList(rows: Array<{ item: string; main: MetricComparison; sessions: string; users: string }>, metricLabel: string): string {
  const header = "Item                                         | Metric       | Change        | Sessions | Users";
  const divider = "---------------------------------------------+--------------+---------------+----------+------";
  const body = rows.map((row, index) => {
    const label = (shortTableValue(row.item) || "(not set)").replace(/[`|]/g, " ").slice(0, 41).padEnd(44, " ");
    const metricValue = `${row.main.previous.toFixed(0)} -> ${row.main.current.toFixed(0)}`.padEnd(12, " ");
    return `${index + 1}. ${label} | ${metricValue} | ${formatMetricDelta(row.main).padEnd(13, " ")} | ${row.sessions.padEnd(8, " ")} | ${row.users}`;
  });
  return [header, divider, ...body].map((line) => `\`${line}\``).join("\n");
}

function formatSimpleDriverTable(rows: Array<{ item: string; current: string; previous: string; delta: string }>, metricLabel: string): string {
  return codeTable(
    ["Driver", "Previous", "Current", "+/-"],
    rows.map((row) => [row.item, row.previous, row.current, row.delta]),
    metricLabel
  );
}

function formatRevenueDriverTable(rows: Array<{ item: string; current: string; previous: string; delta: string; purchases: string }>): string {
  return codeTable(
    ["Driver", "Revenue", "+/-", "Purchases"],
    rows.map((row) => [row.item, `${row.previous} -> ${row.current}`, row.delta, row.purchases])
  );
}

function formatMetricDriverSection(
  title: string,
  rows: Array<{ label: string; keyEvents: MetricComparison }>,
  prefix: string,
  firstHeader: string,
  metricLabel: string
): string {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`) && (row.keyEvents.current > 0 || row.keyEvents.previous > 0))
    .slice(0, 5)
    .map((row) => ({
      item: gaLabel(row.label, prefix),
      current: row.keyEvents.current.toFixed(0),
      previous: row.keyEvents.previous.toFixed(0),
      delta: formatDelta(row.keyEvents.delta)
    }));

  return filtered.length ? `*${title}*\n${formatSimpleDriverTableWithHeader(filtered, firstHeader, metricLabel)}` : "";
}

function formatMetricDriverList(
  title: string,
  rows: Array<{ label: string; keyEvents: MetricComparison }>,
  prefix: string,
  metricLabel: string
): string {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`) && (row.keyEvents.current > 0 || row.keyEvents.previous > 0))
    .slice(0, 5);

  if (!filtered.length) return "";
  return [
    `*${title}*`,
    ...filtered.map((row, index) =>
      `${index + 1}. ${gaLabel(row.label, prefix)}\n   ${metricLabel}: ${row.keyEvents.previous.toFixed(0)} -> ${row.keyEvents.current.toFixed(0)} (${formatDelta(row.keyEvents.delta)})`
    )
  ].join("\n");
}

function formatRevenueDriverSection(
  title: string,
  rows: Array<{ label: string; revenue: MetricComparison; purchases?: MetricComparison }>,
  prefix: string
): string {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`) && (row.revenue.current > 0 || row.revenue.previous > 0))
    .slice(0, 5)
    .map((row) => ({
      item: gaLabel(row.label, prefix),
      current: row.revenue.current.toFixed(0),
      previous: row.revenue.previous.toFixed(0),
      delta: formatDelta(row.revenue.delta),
      purchases: row.purchases ? `${row.purchases.previous.toFixed(0)} -> ${row.purchases.current.toFixed(0)}` : "-"
    }));

  return filtered.length ? `*${title}*\n${formatRevenueDriverTable(filtered)}` : "";
}

function formatRevenueDriverList(
  title: string,
  rows: Array<{ label: string; revenue: MetricComparison; purchases?: MetricComparison }>,
  prefix: string
): string {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`) && (row.revenue.current > 0 || row.revenue.previous > 0))
    .slice(0, 5);

  if (!filtered.length) return "";
  return [
    `*${title}*`,
    ...filtered.map((row, index) => {
      const purchases = row.purchases ? ` | Purchases: ${row.purchases.previous.toFixed(0)} -> ${row.purchases.current.toFixed(0)}` : "";
      return `${index + 1}. ${gaLabel(row.label, prefix)}\n   Revenue: ${row.revenue.previous.toFixed(0)} -> ${row.revenue.current.toFixed(0)} (${formatDelta(row.revenue.delta)})${purchases}`;
    })
  ].join("\n");
}

function formatSimpleDriverTableWithHeader(rows: Array<{ item: string; current: string; previous: string; delta: string }>, firstHeader: string, metricLabel: string): string {
  return codeTable(
    [firstHeader, "Previous", "Current", "+/-"],
    rows.map((row) => [row.item, row.previous, row.current, row.delta]),
    metricLabel
  );
}

function codeTable(headers: string[], rows: string[][], label?: string): string {
  const tableRows = label ? [[label, ...Array(Math.max(0, headers.length - 1)).fill("")], headers, ...rows] : [headers, ...rows];
  const widths = headers.map((_, index) => Math.min(34, Math.max(...tableRows.map((row) => (row[index] ?? "").length), 3)));
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = tableRows.map((row, index) => {
    const line = row.map((cell, cellIndex) => pad(truncate(cell ?? "", widths[cellIndex] ?? 12), widths[cellIndex] ?? 12)).join(" | ");
    return label && index === 0 ? line : line;
  });
  body.splice(label ? 2 : 1, 0, divider);
  return `\`\`\`\n${body.join("\n")}\n\`\`\``;
}

function shortTableValue(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

function humanGaLabel(label: string): string {
  return label
    .replace(/^eventName:\s*/, "event ")
    .replace(/^sessionSourceMedium:\s*/, "source/medium ")
    .replace(/^sessionDefaultChannelGroup:\s*/, "channel ")
    .replace(/^landingPagePlusQueryString:\s*/, "landing page ")
    .replace(/^itemName:\s*/, "item ");
}

function gaLabel(label: string, prefix: string): string {
  const value = cleanGaValue(label.replace(new RegExp(`^${prefix}:\\s*`), ""));
  if (prefix === "landingPagePlusQueryString") return value === "/" ? "/ (homepage)" : value;
  return value || "(not set)";
}

function cleanGaValue(value: string): string {
  const stripped = value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || "(not set)";
}

function shortUrl(value?: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function isMonitoringDataFresh(freshness?: { currentHasData: boolean; previousHasData: boolean }): boolean {
  return Boolean(freshness?.currentHasData && freshness.previousHasData);
}

function gscDateWindowLine(freshness?: { current: { endDate: string }; previous: { endDate: string } }): string {
  if (!freshness) return "GSC uses latest available daily data.";
  return `GSC compares ${freshness.current.endDate} with ${freshness.previous.endDate}.`;
}

function dailyAlertDataKey(alert: string): string {
  const parsed = parseTaggedLine(alert);
  const source = parsed.source;
  if (source === "GSC") return `gsc:${gscCurrentDateFromMessage(parsed.message)}`;
  if (source === "GA4") return `ga4:${monitoringDateRanges("ga4", "daily").current.endDate}`;
  return `daily:${todayKey()}`;
}

function gscCurrentDateFromMessage(message: string): string {
  return message.match(/\bGSC compares\s+(\d{4}-\d{2}-\d{2})\s+with\s+\d{4}-\d{2}-\d{2}/i)?.[1] ??
    monitoringDateRanges("gsc", "daily").current.endDate;
}

function todayKey(date = new Date()): string {
  return localDateKey(date);
}

function weekKey(date = new Date()): string {
  const start = new Date(date.getFullYear(), 0, 1);
  const day = Math.floor((Number(localStartOfDay(date)) - Number(start)) / 86400000);
  return `${date.getFullYear()}-W${Math.ceil((day + start.getDay() + 1) / 7)}`;
}

function weeklyReportKey(date: Date): string {
  const anchor = date.getDay() === config.MONITORING_WEEKLY_FALLBACK_DAY
    ? addDays(date, -1)
    : date;
  return weekKey(anchor);
}

function monthKey(date = new Date()): string {
  return localDateKey(date).slice(0, 7);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localStartOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isWeeklyReportWindow(date: Date): boolean {
  const primaryWindow = date.getDay() === config.MONITORING_WEEKLY_DAY && date.getHours() >= config.MONITORING_WEEKLY_HOUR;
  const fallbackWindow = date.getDay() === config.MONITORING_WEEKLY_FALLBACK_DAY && date.getHours() >= config.MONITORING_WEEKLY_FALLBACK_HOUR;
  return primaryWindow || fallbackWindow;
}

function isMonthlyReportWindow(date: Date): boolean {
  if (date.getHours() < config.MONITORING_MONTHLY_HOUR) return false;
  if (config.MONITORING_MONTHLY_DAY === "end") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getDate() === 1;
  }

  return date.getDate() === config.MONITORING_MONTHLY_DAY;
}

function dailyComparisonNote(): string {
  return `_GSC compares ${dateRangeLabel(3, 1)} with ${dateRangeLabel(4, 1)}. GA4 compares ${dateRangeLabel(1, 1)} with ${dateRangeLabel(2, 1)}._`;
}

function reportSubtitle(lines: string[], mode: "alerts" | "summary"): string {
  if (mode !== "alerts") return "_Latest comparison snapshot grouped by source._";

  const sources = new Set(lines.map((line) => parseTaggedLine(line).source));
  const notes = [
    "_Only new anomalies are shown. Repeated schema issues are held for biweekly follow-up._",
    sources.has("GA4") ? `_GA4 compares ${dateRangeLabel(1, 1)} with ${dateRangeLabel(2, 1)}._` : ""
  ].filter(Boolean);

  return notes.join("\n");
}

function countryLabel(country: string): string {
  const normalized = country.toLowerCase().replace(/[^a-z]/g, "");
  const labels: Record<string, string> = {
    global: "Global",
    usa: "USA",
    us: "USA",
    can: "Canada",
    ca: "Canada",
    gbr: "UK",
    uk: "UK",
    irl: "Ireland",
    aus: "Australia",
    cri: "Costa Rica",
    npl: "Nepal",
    np: "Nepal",
    svn: "Slovenia"
  };
  return labels[normalized] ?? country.toUpperCase();
}

function dateRangeLabel(delayDays: number, days: number): string {
  const end = addDays(new Date(), -delayDays);
  const start = addDays(end, -(days - 1));
  return start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)
    ? end.toISOString().slice(0, 10)
    : `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 220);
}

function tag(source: string, client: string, message: string): string {
  return `[${source}] ${client}: ${message}`;
}

function parseTaggedLine(line: string): { source: string; client?: string; message: string } {
  const match = line.match(/^\[([^\]]+)\]\s+([^:]+):\s+([\s\S]+)$/);
  if (!match) return { source: "Other", message: line };
  return { source: match[1] ?? "Other", client: match[2], message: match[3] ?? "" };
}

function formatGroupedLines(lines: string[], singleClient?: string): string[] {
  const groups = new Map<string, Array<{ client?: string; message: string }>>();

  for (const line of lines) {
    const parsed = parseTaggedLine(line);
    const existing = groups.get(parsed.source) ?? [];
    existing.push({ client: parsed.client, message: parsed.message });
    groups.set(parsed.source, existing);
  }

  return Array.from(groups.entries()).flatMap(([source, groupLines]) => [
    "",
    `*${sourceLabel(source)}*`,
    shouldUseFullLines(source) ? formatFullLines(groupLines, Boolean(singleClient)) : formatSlackTable(groupLines, Boolean(singleClient))
  ]);
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    GSC: "GSC performance",
    GA4: "GA4 performance",
    "GSC indexing": "Indexable but not indexed",
    PageSpeed: "PageSpeed",
    Technical: "Technical checks",
    Schema: "Schema checks",
    "Data access": "Data access"
  };
  return labels[source] ?? source;
}

function formatSlackTable(rows: Array<{ client?: string; message: string }>, hideClient: boolean): string {
  if (hideClient) {
    return rows.slice(0, 20).map((row) => `- ${row.message}`).join("\n");
  }

  const maxMessageWidth = hideClient ? 96 : 74;
  const visibleRows = rows.slice(0, 12);
  const header = hideClient
    ? ["Alert"]
    : ["Client", "Alert"];
  const widths = hideClient
    ? [maxMessageWidth]
    : [
        Math.min(24, Math.max(6, ...visibleRows.map((row) => (row.client ?? "").length))),
        maxMessageWidth
      ];
  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  const body = visibleRows.map((row) => hideClient
    ? pad(truncate(row.message, widths[0] ?? maxMessageWidth), widths[0] ?? maxMessageWidth)
    : [
        pad(truncate(row.client ?? "-", widths[0] ?? 24), widths[0] ?? 24),
        pad(truncate(row.message, widths[1] ?? maxMessageWidth), widths[1] ?? maxMessageWidth)
      ].join(" | "));
  const more = rows.length > visibleRows.length ? [`... ${rows.length - visibleRows.length} more`] : [];
  const table = [
    hideClient
      ? pad(header[0] ?? "Alert", widths[0] ?? maxMessageWidth)
      : `${pad(header[0] ?? "Client", widths[0] ?? 24)} | ${pad(header[1] ?? "Alert", widths[1] ?? maxMessageWidth)}`,
    divider,
    ...body,
    ...more
  ];
  return `\`\`\`\n${table.join("\n")}\n\`\`\``;
}

function formatFullLines(rows: Array<{ client?: string; message: string }>, hideClient: boolean): string {
  const visibleRows = rows.slice(0, 25).map((row) => {
    const prefix = hideClient ? "- " : `- *${row.client ?? "Client"}:* `;
    const [firstLine, ...rest] = row.message.split("\n");
    return rest.length ? `${prefix}${firstLine}\n${rest.join("\n")}` : `${prefix}${row.message}`;
  });
  const more = rows.length > visibleRows.length ? [`- ... ${rows.length - visibleRows.length} more`] : [];
  return [...visibleRows, ...more].join("\n");
}

function shouldUseFullLines(source: string): boolean {
  return source === "GSC" || source === "GA4" || source === "Schema" || source === "Technical" || source === "GSC indexing" || source === "PageSpeed";
}

function truncate(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, Math.max(0, width - 3))}...` : clean;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function isTransientNetworkError(error: string): boolean {
  return /getaddrinfo|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket|terminated|network|undici|oauth2\.googleapis\.com\/token/i.test(error);
}

function isMissingPropertyConfigError(error: string): boolean {
  return /\bNo (?:GSC site|GA4 property) configured\b/i.test(error);
}

function shouldStoreTechnicalSnapshot(result: { status?: number; title?: string; metaDescription?: string; h1?: string; canonical?: string; schemaTypes: string[]; accessBlocked?: boolean }): boolean {
  if (result.accessBlocked) return false;
  return Boolean(
    result.status &&
    result.status < 500 &&
    (result.title || result.metaDescription || result.h1 || result.canonical || result.schemaTypes.length)
  );
}

function isSchemaAlert(alert: string): boolean {
  return alert.includes("Schema removed") || alert.includes("Schema JSON parse errors") || alert.includes("No JSON-LD schema detected");
}

function isRobotsAlert(alert: string): boolean {
  return alert.includes("Meta robots changed") || alert.includes("Page appears to be noindex");
}

function homepageFromClient(client: ClientConfig): string {
  if (client.gscSite?.startsWith("http")) return client.gscSite;
  if (client.gscSite?.startsWith("sc-domain:")) return `https://${client.gscSite.replace("sc-domain:", "")}/`;
  throw new Error(`No crawlable URL configured for ${client.client}`);
}

function normalizeRobotsTxt(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function previewRobotsTxt(value: string): string {
  const lines = value.split(/\r?\n/).slice(0, 35);
  return lines.join("\n").slice(0, 2500) || "(empty robots.txt)";
}

function compactRobotsPreview(value?: string): string {
  const text = value?.trim() || "(not stored)";
  return text.split(/\r?\n/).slice(0, 25).join("\n").slice(0, 1400);
}


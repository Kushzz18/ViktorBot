import { findClientByName } from "./clients.js";
import { getPriorityQueries, getPriorityUrls, isPriorityQuery, isPriorityUrl } from "./clientMemory.js";
import {
  fetchGaMonitoring,
  fetchGaScopedPerformance,
  fetchGscMonitoring,
  fetchGscScopedPerformance,
  monitoringDateRanges,
  type MetricComparison,
  type MonitoringDateSelection
} from "./monitoringGoogle.js";
import { cleanLabel, formatDelta, formatMetricDelta, formatMetricRows, formatPageLabel } from "./reportFormatting.js";

export type ClientDataRequest = {
  clientName: string;
  sources: Array<"gsc" | "ga">;
  period: MonitoringDateSelection;
  compare: boolean;
  countryFilter?: boolean;
  focus?: ClientDataFocus;
};

export type ClientDataFocus =
  | { source: "gsc"; dimension: "query" | "page"; value: string }
  | {
      source: "ga";
      metric: "activeUsers" | "sessions" | "keyEvents" | "totalRevenue" | "ecommercePurchases";
      dimension?: "landingPagePlusQueryString" | "sessionDefaultChannelGroup" | "sessionSourceMedium" | "eventName";
      value?: string;
    };

export async function formatClientDataRequest(request: ClientDataRequest): Promise<string> {
  const countryFilter = request.countryFilter !== false;
  if (request.focus?.source === "gsc") {
    return formatClientGscFocusedData(request.clientName, request.period, request.compare, request.focus, countryFilter);
  }
  if (request.focus?.source === "ga") {
    return formatClientGaFocusedData(request.clientName, request.period, request.compare, request.focus, countryFilter);
  }

  const parts: string[] = [];
  for (const source of request.sources) {
    parts.push(source === "gsc"
      ? await formatClientGscData(request.clientName, request.period, request.compare, countryFilter)
      : await formatClientGaData(request.clientName, request.period, request.compare, countryFilter));
  }
  return parts.join("\n\n");
}

async function formatClientGscFocusedData(
  clientName: string,
  period: MonitoringDateSelection,
  compare: boolean,
  focus: Extract<ClientDataFocus, { source: "gsc" }>,
  countryFilter = true
): Promise<string> {
  const client = await findClientByName(clientName);
  if (!client) return `I could not find a mapped client matching "${clientName}". Try \`list clients\`.`;
  const result = await fetchGscScopedPerformance(client, period, focus.dimension, focus.value, { countryFilter });
  if (result.error || !result.metrics) return `${client.client}: I could not fetch GSC ${focus.dimension} data. ${result.error ?? ""}`.trim();
  const ranges = result.freshness ?? monitoringDateRanges("gsc", period);
  return [
    `*GSC ${focus.dimension} performance - ${client.client}*`,
    `${titleCase(focus.dimension)}: ${result.value}`,
    `Period: ${periodLabel(period)} (${rangeLabel(ranges.current)})${compare ? ` compared with ${rangeLabel(ranges.previous)}` : ""}`,
    `Country: ${countryLabel(client.mainCountry, countryFilter)}`,
    "",
    "```",
    ...(compare ? [
      "Metric       | Current | Previous | Change",
      "-------------+---------+----------+--------",
      `Clicks       | ${cell(result.metrics.clicks.current)} | ${cell(result.metrics.clicks.previous)} | ${changeCell(result.metrics.clicks, compare)}`,
      `Impressions  | ${cell(result.metrics.impressions.current)} | ${cell(result.metrics.impressions.previous)} | ${changeCell(result.metrics.impressions, compare)}`,
      `CTR          | ${(result.metrics.ctr.current * 100).toFixed(2)}% | ${(result.metrics.ctr.previous * 100).toFixed(2)}% | ${formatPctDelta(result.metrics.ctr)}`,
      `Avg position | ${result.metrics.position.current.toFixed(1)} | ${result.metrics.position.previous.toFixed(1)} | ${formatDelta(result.metrics.position.delta, 1)}`
    ] : [
      "Metric       | Current",
      "-------------+--------",
      `Clicks       | ${cell(result.metrics.clicks.current)}`,
      `Impressions  | ${cell(result.metrics.impressions.current)}`,
      `CTR          | ${(result.metrics.ctr.current * 100).toFixed(2)}%`,
      `Avg position | ${result.metrics.position.current.toFixed(1)}`
    ]),
    "```",
    ...(focus.dimension === "page" ? [
      "",
      "*Top queries for this landing page*",
      ...(result.topQueries?.length ? formatGscRows(result.topQueries.map((row) => ({
        label: row.query,
        clicks: row.clicks,
        impressions: row.impressions
      })), compare) : ["No query-level data found for this landing page in the selected period."])
    ] : [])
  ].join("\n");
}

async function formatClientGaFocusedData(
  clientName: string,
  period: MonitoringDateSelection,
  compare: boolean,
  focus: Extract<ClientDataFocus, { source: "ga" }>,
  countryFilter = true
): Promise<string> {
  const client = await findClientByName(clientName);
  if (!client) return `I could not find a mapped client matching "${clientName}". Try \`list clients\`.`;
  const result = await fetchGaScopedPerformance(client, period, focus, { countryFilter });
  if (result.error) return `${client.client}: I could not fetch GA4 focused data. ${result.error}`.trim();
  const ranges = monitoringDateRanges("ga4", period);
  const title = focus.dimension ? `${gaMetricLabel(focus.metric)} by ${gaDimensionLabel(focus.dimension)}` : gaMetricLabel(focus.metric);
  const rows: Array<[string, MetricComparison]> = result.comparison
    ? [[title, result.comparison]]
    : result.rows.map((row) => [displayGaLabel(row.label, focus.dimension ?? ""), row.metric]);
  return [
    `*GA4 ${title} - ${client.client}*`,
    focus.value ? `Filter: ${focus.value}` : undefined,
    `Period: ${periodLabel(period)} (${rangeLabel(ranges.current)})${compare ? ` compared with ${rangeLabel(ranges.previous)}` : ""}`,
    `Country: ${countryLabel(client.mainCountry, countryFilter)}`,
    "",
    ...(rows.length ? [
      "```",
      ...(compare ? [
        `${focus.dimension ? gaDimensionLabel(focus.dimension) : "Metric"} | Current | Previous | Change`,
        "------------------------------+---------+----------+--------",
        ...rows.map(([label, metric]) => `${truncate(label, 30).padEnd(30)} | ${cell(metric.current)} | ${cell(metric.previous)} | ${changeCell(metric, compare)}`)
      ] : [
        `${focus.dimension ? gaDimensionLabel(focus.dimension) : "Metric"} | Current`,
        "------------------------------+--------",
        ...rows.map(([label, metric]) => `${truncate(label, 30).padEnd(30)} | ${cell(metric.current)}`)
      ]),
      "```"
    ] : ["No matching GA4 data found."])
  ].filter(Boolean).join("\n");
}

export async function formatClientGscData(clientName: string, period: MonitoringDateSelection = "weekly", compare = true, countryFilter = true): Promise<string> {
  const client = await findClientByName(clientName);
  if (!client) return `I could not find a mapped client matching "${clientName}". Try \`list clients\`.`;

  const gsc = await fetchGscMonitoring(client, period, { countryFilter });
  if (gsc.error || !gsc.metrics) {
    return `${client.client}: I could not fetch GSC data. ${gsc.error ?? ""}`.trim();
  }

  const ranges = monitoringDateRanges("gsc", period);
  return [
    `*GSC performance - ${client.client}*`,
    `Period: ${periodLabel(period)} (${rangeLabel(ranges.current)})${compare ? ` compared with ${rangeLabel(ranges.previous)}` : ""}`,
    `Country: ${countryLabel(client.mainCountry, countryFilter)}`,
    "",
    "```",
    "Metric       | Current | Previous | Change",
    "-------------+---------+----------+--------",
    `Clicks       | ${cell(gsc.metrics.clicks.current)} | ${cell(gsc.metrics.clicks.previous)} | ${changeCell(gsc.metrics.clicks, compare)}`,
    `Impressions  | ${cell(gsc.metrics.impressions.current)} | ${cell(gsc.metrics.impressions.previous)} | ${changeCell(gsc.metrics.impressions, compare)}`,
    `CTR          | ${(gsc.metrics.ctr.current * 100).toFixed(2)}% | ${(gsc.metrics.ctr.previous * 100).toFixed(2)}% | ${compare ? formatPctDelta(gsc.metrics.ctr) : "-"}`,
    `Avg position | ${gsc.metrics.position.current.toFixed(1)} | ${gsc.metrics.position.previous.toFixed(1)} | ${compare ? formatDelta(gsc.metrics.position.delta, 1) : "-"}`,
    "```",
    "",
    ...formatPriorityGscSection(client.client, gsc, compare),
    "",
    "*Pages - top 5 clicks gains*",
    ...formatGscRows(gscTop(gsc.pageMovers.map((page) => ({
      label: pageLabel(page.page),
      clicks: page.clicks,
      impressions: page.impressions
    })), "clicks", "up"), compare),
    "",
    "*Pages - top 5 clicks drops*",
    ...formatGscRows(gscTop(gsc.pageMovers.map((page) => ({
      label: pageLabel(page.page),
      clicks: page.clicks,
      impressions: page.impressions
    })), "clicks", "down"), compare),
    "",
    "*Pages - top 5 impression gains*",
    ...formatGscRows(gscTop(gsc.pageMovers.map((page) => ({
      label: pageLabel(page.page),
      clicks: page.clicks,
      impressions: page.impressions
    })), "impressions", "up"), compare),
    "",
    "*Pages - top 5 impression drops*",
    ...formatGscRows(gscTop(gsc.pageMovers.map((page) => ({
      label: pageLabel(page.page),
      clicks: page.clicks,
      impressions: page.impressions
    })), "impressions", "down"), compare),
    "",
    "*Queries - top 5 clicks gains*",
    ...formatGscRows(gscTop(gsc.queryMovers.map((query) => ({
      label: query.query,
      clicks: query.clicks,
      impressions: query.impressions
    })), "clicks", "up"), compare),
    "",
    "*Queries - top 5 clicks drops*",
    ...formatGscRows(gscTop(gsc.queryMovers.map((query) => ({
      label: query.query,
      clicks: query.clicks,
      impressions: query.impressions
    })), "clicks", "down"), compare),
    "",
    "*Queries - top 5 impression gains*",
    ...formatGscRows(gscTop(gsc.queryMovers.map((query) => ({
      label: query.query,
      clicks: query.clicks,
      impressions: query.impressions
    })), "impressions", "up"), compare),
    "",
    "*Queries - top 5 impression drops*",
    ...formatGscRows(gscTop(gsc.queryMovers.map((query) => ({
      label: query.query,
      clicks: query.clicks,
      impressions: query.impressions
    })), "impressions", "down"), compare),
    "",
    ...formatPriorityPageQuerySection(client.client, gsc, compare),
    "",
    ...(meaningfulSearchAppearances(gsc.searchAppearances).length ? [
      "*Search appearance drivers*",
      ...formatGscRows(meaningfulSearchAppearances(gsc.searchAppearances).map((row) => ({
      label: row.item,
      clicks: row.clicks,
      impressions: row.impressions
      })), compare),
      ""
    ] : []),
    "",
    "*GSC summary*",
    ...gscSummary(gsc, compare)
  ].join("\n");
}

export async function formatClientGaData(clientName: string, period: MonitoringDateSelection = "weekly", compare = true, countryFilter = true): Promise<string> {
  const client = await findClientByName(clientName);
  if (!client) return `I could not find a mapped client matching "${clientName}". Try \`list clients\`.`;

  const ga = await fetchGaMonitoring(client, period, { countryFilter });
  if (ga.error || !ga.metrics) {
    return `${client.client}: I could not fetch GA4 data. ${ga.error ?? ""}`.trim();
  }

  const ranges = monitoringDateRanges("ga4", period);
  const hasEcommerceData = hasGaRevenueData(ga);
  const metricRows = [
    `Active users        | ${cell(ga.metrics.activeUsers.current)} | ${cell(ga.metrics.activeUsers.previous)} | ${changeCell(ga.metrics.activeUsers, compare)}`,
    `Sessions            | ${cell(ga.metrics.sessions.current)} | ${cell(ga.metrics.sessions.previous)} | ${changeCell(ga.metrics.sessions, compare)}`,
    `Key events          | ${cell(ga.metrics.keyEvents.current)} | ${cell(ga.metrics.keyEvents.previous)} | ${changeCell(ga.metrics.keyEvents, compare)}`,
    ...(hasEcommerceData ? [
      `Revenue             | ${cell(ga.metrics.totalRevenue.current)} | ${cell(ga.metrics.totalRevenue.previous)} | ${changeCell(ga.metrics.totalRevenue, compare)}`,
      `Ecommerce purchases | ${cell(ga.metrics.ecommercePurchases.current)} | ${cell(ga.metrics.ecommercePurchases.previous)} | ${changeCell(ga.metrics.ecommercePurchases, compare)}`
    ] : [])
  ];
  return [
    `*GA4 performance - ${client.client}*`,
    `Period: ${periodLabel(period)} (${rangeLabel(ranges.current)})${compare ? ` compared with ${rangeLabel(ranges.previous)}` : ""}`,
    `Country: ${countryLabel(client.mainCountry, countryFilter)}`,
    "",
    "```",
    "Metric              | Current | Previous | Change",
    "--------------------+---------+----------+--------",
    ...metricRows,
    "```",
    "",
    "*Top channels*",
    ...(ga.topChannels.length ? formatGaRows(
      ga.topChannels.map((channel) => ({
        label: channel.channel,
        current: channel.sessions,
        previous: channel.activeUsers,
        extra: "sessions/users"
      })),
      "Channel",
      "Sessions",
      "Users"
    ) : ["No channel data found."]),
    "",
    "*Key events by event name*",
    ...formatGaSection(ga.keyEventBreakdown, "eventName", "Event", "Key events", compare),
    "",
    "*Key events by source / medium*",
    ...formatGaSection(ga.keyEventBreakdown, "sessionSourceMedium", "Source / medium", "Key events", compare),
    "",
    "*Key events by landing page*",
    ...formatGaSection(ga.keyEventBreakdown, "landingPagePlusQueryString", "Landing page", "Key events", compare),
    "",
    ...(hasEcommerceData ? [
      "*Revenue by channel*",
      ...formatRevenueSection(ga.revenueBreakdown, "sessionDefaultChannelGroup", compare),
      "",
      "*Revenue by source / medium*",
      ...formatRevenueSection(ga.revenueBreakdown, "sessionSourceMedium", compare),
      "",
      "*Revenue by landing page*",
      ...formatRevenueSection(ga.revenueBreakdown, "landingPagePlusQueryString", compare),
      "",
      "*Revenue by item*",
      ...formatRevenueItemRows(ga.revenueBreakdown.filter((row) => row.label.startsWith("itemName:")).slice(0, 5).map((row) => ({
        label: displayGaLabel(row.label, "itemName"),
        revenue: row.revenue,
        purchases: row.purchases?.current
      })), compare),
      ""
    ] : []),
    "*GA4 summary*",
    ...gaSummary(ga, compare)
  ].join("\n");
}

function cell(value: number): string {
  return value.toFixed(0).padStart(7, " ");
}

function countryLabel(mainCountry: string, countryFilter: boolean): string {
  if (!countryFilter) return "global (country filter removed)";
  return mainCountry === "global" ? "global" : mainCountry;
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function gaMetricLabel(metric: Extract<ClientDataFocus, { source: "ga" }>["metric"]): string {
  return {
    activeUsers: "active users",
    sessions: "sessions",
    keyEvents: "key events",
    totalRevenue: "revenue",
    ecommercePurchases: "ecommerce purchases"
  }[metric];
}

function gaDimensionLabel(dimension: NonNullable<Extract<ClientDataFocus, { source: "ga" }>["dimension"]>): string {
  return {
    landingPagePlusQueryString: "landing page",
    sessionDefaultChannelGroup: "channel",
    sessionSourceMedium: "source / medium",
    eventName: "event"
  }[dimension];
}

function changeCell(metric: MetricComparison, compare = true): string {
  if (!compare) return "-";
  return `${formatDelta(metric.delta)} (${metric.pctChange === null ? "new" : `${metric.pctChange >= 0 ? "+" : ""}${metric.pctChange.toFixed(0)}%`})`;
}

function formatPctDelta(metric: MetricComparison): string {
  return metric.pctChange === null ? "new" : `${metric.pctChange >= 0 ? "+" : ""}${metric.pctChange.toFixed(1)}%`;
}

function formatGscRows(
  rows: Array<{ label: string; clicks: MetricComparison; impressions: MetricComparison }>,
  compare: boolean
): string[] {
  return formatMetricRows(rows, compare);
}

function gscTop(
  rows: Array<{ label: string; clicks: MetricComparison; impressions: MetricComparison }>,
  metric: "clicks" | "impressions",
  direction: "up" | "down"
) {
  return rows
    .filter((row) => direction === "up" ? row[metric].delta > 0 : row[metric].delta < 0)
    .sort((a, b) => Math.abs(b[metric].delta) - Math.abs(a[metric].delta))
    .slice(0, 5);
}

function formatPriorityGscSection(
  clientName: string,
  gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>,
  compare: boolean
): string[] {
  const hasPriorityConfig = getPriorityQueries(clientName).length > 0 || getPriorityUrls(clientName).length > 0;
  if (!hasPriorityConfig) {
    return [
      "*Priority query/URL movement*",
      "No priority queries or URLs specified for this client."
    ];
  }

  const exactPriorityQueries = gsc.priorityQueries
    .filter((row) => row.clicks.delta !== 0 || row.impressions.delta !== 0)
    .map((row) => ({ label: `Query: ${row.query}`, clicks: row.clicks, impressions: row.impressions }));
  const fetchedPriorityQueries = gsc.queryMovers
    .filter((row) => isPriorityQuery(clientName, row.query))
    .filter((row) => row.clicks.delta !== 0 || row.impressions.delta !== 0)
    .map((row) => ({ label: `Query: ${row.query}`, clicks: row.clicks, impressions: row.impressions }));
  const exactPriorityPages = gsc.priorityPages
    .filter((row) => row.clicks.delta !== 0 || row.impressions.delta !== 0)
    .map((row) => ({ label: `URL: ${pageLabel(row.page)}`, clicks: row.clicks, impressions: row.impressions }));
  const fetchedPriorityPages = gsc.pageMovers
    .filter((row) => isPriorityUrl(clientName, row.page))
    .filter((row) => row.clicks.delta !== 0 || row.impressions.delta !== 0)
    .map((row) => ({ label: `URL: ${pageLabel(row.page)}`, clicks: row.clicks, impressions: row.impressions }));

  const rows = dedupeGscDisplayRows([
    ...exactPriorityQueries,
    ...exactPriorityPages,
    ...fetchedPriorityQueries,
    ...fetchedPriorityPages
  ])
    .sort((a, b) => Math.abs(b.clicks.delta) + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) + Math.abs(a.impressions.delta)))
    .slice(0, 8);
  return [
    "*Priority query/URL movement*",
    ...(rows.length ? formatGscRows(rows, compare) : ["Priority queries and URLs look stable for this comparison."])
  ];
}

function dedupeGscDisplayRows(
  rows: Array<{ label: string; clicks: MetricComparison; impressions: MetricComparison }>
): Array<{ label: string; clicks: MetricComparison; impressions: MetricComparison }> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = cleanLabel(row.label).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatGscPageQueryRows(
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>,
  compare: boolean
): string[] {
  return rows.slice(0, 5).map((row, index) => {
    const [page, query] = row.item.split(" | ");
    const displayPage = pageLabel(page);
    const signal = pageQuerySignal(row);
    if (!compare) return `${index + 1}. ${displayPage}\n   Query: "${query || "(not set)"}"\n   Clicks: ${row.clicks.current.toFixed(0)} | Impressions: ${row.impressions.current.toFixed(0)}`;
    return `${index + 1}. ${signal}: ${displayPage}\n   Query: "${query || "(not set)"}"\n   Clicks: ${row.clicks.previous.toFixed(0)} -> ${row.clicks.current.toFixed(0)} (${formatMetricDelta(row.clicks)})\n   Impressions: ${row.impressions.previous.toFixed(0)} -> ${row.impressions.current.toFixed(0)} (${formatMetricDelta(row.impressions)})`;
  });
}

function formatPriorityPageQuerySection(
  clientName: string,
  gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>,
  compare: boolean
): string[] {
  const rows = priorityPageQueryRows(clientName, gsc);
  return rows.length
    ? ["*Priority page + query spike/drop analysis*", ...formatGscPageQueryRows(rows, compare), ""]
    : [];
}

function priorityPageQueryRows(clientName: string, gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>): Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }> {
  return gsc.topPageQueries
    .filter((row) => {
      const [page, query] = row.item.split(" | ");
      return isPriorityUrl(clientName, page ?? "") || isPriorityQuery(clientName, query ?? "");
    })
    .filter((row) =>
      Math.abs(row.clicks.delta) >= 1 ||
      Math.abs(row.impressions.delta) >= 25 ||
      Math.abs(row.clicks.pctChange ?? 0) >= 50 ||
      Math.abs(row.impressions.pctChange ?? 0) >= 50
    )
    .sort((a, b) => pageQueryScore(b) - pageQueryScore(a))
    .slice(0, 5);
}

function pageQueryScore(row: { clicks: MetricComparison; impressions: MetricComparison }): number {
  return Math.abs(row.clicks.delta) * 100 + Math.abs(row.impressions.delta);
}

function pageQuerySignal(row: { clicks: MetricComparison; impressions: MetricComparison }): string {
  const clickWeight = row.clicks.delta * 100;
  const total = clickWeight + row.impressions.delta;
  if (total < 0) return "Drop driver";
  if (total > 0) return "Gain driver";
  return "Movement driver";
}

function formatGaRows(
  rows: Array<{ label: string; current: number; previous: number; extra: string }>,
  firstHeader: string,
  currentHeader: string,
  previousHeader: string
): string[] {
  const body = rows.map((row, index) =>
    `${`${index + 1}. ${shortenCell(row.label, 30)}`.padEnd(33, " ")} | ${row.current.toFixed(0).padStart(7, " ")} | ${row.previous.toFixed(0).padStart(5, " ")}`
  );
  return [
    "```",
    `${firstHeader.padEnd(33, " ")} | ${currentHeader.padStart(7, " ")} | ${previousHeader.padStart(5, " ")}`,
    "----------------------------------+---------+------",
    ...body,
    "```"
  ];
}

function formatGaComparisonRows(
  rows: Array<{ label: string; metric: MetricComparison }>,
  firstHeader: string,
  metricHeader: string,
  compare: boolean
): string[] {
  if (rows.some((row) => cleanLabel(row.label).length > 32)) {
    return formatGaComparisonList(rows, metricHeader, compare);
  }

  const body = rows.map((row, index) => {
    const label = `${index + 1}. ${shortenCell(row.label, 30)}`.padEnd(33, " ");
    if (!compare) return `${label} | ${row.metric.current.toFixed(0).padStart(7, " ")}`;
    return `${label} | ${row.metric.previous.toFixed(0).padStart(7, " ")} | ${row.metric.current.toFixed(0).padStart(7, " ")} | ${formatMetricDelta(row.metric).padStart(12, " ")}`;
  });
  const header = compare
    ? [`${firstHeader.padEnd(33, " ")} |    Prev |    Curr | Change      `, "----------------------------------+---------+---------+-------------"]
    : [`${firstHeader.padEnd(33, " ")} | ${metricHeader.padStart(7, " ")}`, "----------------------------------+---------"];
  return ["```", ...header, ...body, "```"];
}

function formatGaComparisonList(
  rows: Array<{ label: string; metric: MetricComparison }>,
  metricHeader: string,
  compare: boolean
): string[] {
  return rows.map((row, index) => {
    if (!compare) return `${index + 1}. ${row.label}\n   ${metricHeader}: ${row.metric.current.toFixed(0)}`;
    return `${index + 1}. ${row.label}\n   Previous: ${row.metric.previous.toFixed(0)} | Current: ${row.metric.current.toFixed(0)} | Change: ${formatMetricDelta(row.metric)}`;
  });
}

function formatGaSection(
  rows: Array<{ label: string; keyEvents: MetricComparison }>,
  prefix: string,
  firstHeader: string,
  metricHeader: string,
  compare: boolean
): string[] {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`))
    .slice(0, 5)
    .map((row) => ({ label: displayGaLabel(row.label, prefix), metric: row.keyEvents }));
  if (prefix === "landingPagePlusQueryString") {
    return filtered.length ? formatGaComparisonList(filtered, metricHeader, compare) : ["No data returned."];
  }
  return filtered.length ? formatGaComparisonRows(filtered, firstHeader, metricHeader, compare) : ["No data returned."];
}

function formatRevenueSection(
  rows: Array<{ label: string; revenue: MetricComparison; purchases?: MetricComparison }>,
  prefix: string,
  compare: boolean
): string[] {
  const filtered = rows
    .filter((row) => row.label.startsWith(`${prefix}:`))
    .slice(0, 5)
    .map((row) => ({
      label: displayGaLabel(row.label, prefix),
      revenue: row.revenue,
      purchases: row.purchases?.current
    }));
  return filtered.length ? formatRevenueRows(filtered, compare) : ["No data returned."];
}

function formatRevenueRows(
  rows: Array<{ label: string; revenue: MetricComparison; purchases?: number }>,
  compare: boolean
): string[] {
  if (rows.some((row) => cleanLabel(row.label).length > 32)) {
    return rows.map((row, index) => {
      const purchases = row.purchases === undefined ? "n/a" : row.purchases.toFixed(0);
      if (!compare) return `${index + 1}. ${row.label}\n   Revenue: ${row.revenue.current.toFixed(0)} | Purchases: ${purchases}`;
      return `${index + 1}. ${row.label}\n   Revenue: ${row.revenue.previous.toFixed(0)} -> ${row.revenue.current.toFixed(0)} (${formatMetricDelta(row.revenue)}) | Purchases: ${purchases}`;
    });
  }

  const body = rows.map((row, index) => {
    const label = `${index + 1}. ${shortenCell(row.label, 26)}`.padEnd(29, " ");
    const purchases = (row.purchases ?? 0).toFixed(0).padStart(3, " ");
    if (!compare) return `${label} | ${row.revenue.current.toFixed(0).padStart(6, " ")} | ${purchases}`;
    return `${label} | ${row.revenue.previous.toFixed(0).padStart(6, " ")} | ${row.revenue.current.toFixed(0).padStart(6, " ")} | ${formatMetricDelta(row.revenue).padStart(12, " ")} | ${purchases}`;
  });
  const header = compare
    ? ["Driver                        |   Prev |   Curr | Change       | Buy", "------------------------------+--------+--------+--------------+----"]
    : ["Driver                        |    Rev | Buy", "------------------------------+--------+----"];
  return body.length ? ["```", ...header, ...body, "```"] : ["No data returned."];
}

function formatRevenueItemRows(
  rows: Array<{ label: string; revenue: MetricComparison; purchases?: number }>,
  compare: boolean
): string[] {
  if (!rows.length) return ["No data returned."];

  return rows.map((row, index) => {
    const purchases = row.purchases === undefined ? "n/a" : row.purchases.toFixed(0);
    if (!compare) {
      return `${index + 1}. ${row.label}\n   Revenue: ${row.revenue.current.toFixed(0)} | Purchases: ${purchases}`;
    }

    return `${index + 1}. ${row.label}\n   Revenue: ${row.revenue.previous.toFixed(0)} -> ${row.revenue.current.toFixed(0)} (${formatMetricDelta(row.revenue)}) | Purchases: ${purchases}`;
  });
}

function gscSummary(gsc: Awaited<ReturnType<typeof fetchGscMonitoring>>, compare: boolean): string[] {
  if (!compare) return ["- Comparison is off for this request."];
  if (!gsc.metrics) return ["- GSC metrics were unavailable."];
  const metrics = gsc.metrics;
  const urbanIceContext = gsc.topPages.some((row) => /urbanicebotanicals\.com\/?$/i.test(row.page)) && gsc.topQueries.some((row) => /urban ice organics/i.test(row.query));
  const lowVolume = Math.max(metrics.clicks.current, metrics.clicks.previous) <= 100;
  const pageClickDrop = strongestMover(gsc.pageMovers.map((row) => ({ label: pageLabel(row.page), metric: row.clicks })), "down");
  const pageImpressionDrop = strongestMover(gsc.pageMovers.map((row) => ({ label: pageLabel(row.page), metric: row.impressions })), "down");
  const queryClickDrop = strongestMover(gsc.queryMovers.map((row) => ({ label: row.query, metric: row.clicks })), "down");
  const queryImpressionDrop = strongestMover(gsc.queryMovers.map((row) => ({ label: row.query, metric: row.impressions })), "down");
  const pageClickGain = strongestMover(gsc.pageMovers.map((row) => ({ label: pageLabel(row.page), metric: row.clicks })), "up");
  const queryClickGain = strongestMover(gsc.queryMovers.map((row) => ({ label: row.query, metric: row.clicks })), "up");
  const overall = metrics.clicks.delta < 0 && metrics.impressions.delta < 0
    ? urbanIceContext
      ? "Core read: this is mainly a branded-demand and entity-transition issue, not a broad technical SEO crash. The biggest losses are old-brand queries pointing to the homepage and capsules page, while the current-brand query is not showing the same collapse."
      : lowVolume
        ? `Traffic is still low-volume, but both clicks and impressions moved down (${metrics.clicks.previous.toFixed(0)} -> ${metrics.clicks.current.toFixed(0)} clicks; impressions ${formatMetricDelta(metrics.impressions)}). ${driverSentence("Main visibility loss", pageImpressionDrop, queryImpressionDrop)} Treat this as a watchlist issue unless the affected page/query is commercially important.`
        : `This is a negative GSC movement: clicks and impressions are both down. ${driverSentence("Main drop", pageClickDrop ?? pageImpressionDrop, queryClickDrop ?? queryImpressionDrop)}`
    : metrics.clicks.delta > 0 && metrics.impressions.delta > 0
      ? `Clicks and impressions are both up, so the direction is positive. ${driverSentence("Main lift", pageClickGain, queryClickGain)} Confirm the lift is coming from useful commercial terms before calling it a client win.`
      : lowVolume
        ? `Clicks are nearly flat at a low volume (${metrics.clicks.previous.toFixed(0)} -> ${metrics.clicks.current.toFixed(0)}), but impressions moved ${formatMetricDelta(metrics.impressions)}. ${driverSentence("Visibility clue", pageImpressionDrop ?? pageClickGain, queryImpressionDrop ?? queryClickGain)} This is a visibility/watchlist signal rather than a traffic issue yet.`
        : `The movement is mixed: clicks ${formatMetricDelta(metrics.clicks)} while impressions ${formatMetricDelta(metrics.impressions)}. ${driverSentence("Most useful clue", pageClickDrop ?? pageClickGain ?? pageImpressionDrop, queryClickDrop ?? queryClickGain ?? queryImpressionDrop)}`;
  const pageQueryDrivers = gsc.topPageQueries
    .filter((row) =>
      Math.abs(row.clicks.delta) >= 1 ||
      Math.abs(row.impressions.delta) >= 25 ||
      Math.abs(row.clicks.pctChange ?? 0) >= 50 ||
      Math.abs(row.impressions.pctChange ?? 0) >= 50
    )
    .sort((a, b) => pageQueryScore(b) - pageQueryScore(a))
    .slice(0, 5);
  const appearances = meaningfulSearchAppearances(gsc.searchAppearances)
    .filter((row) => row.clicks.delta < 0 || row.impressions.delta < 0)
    .slice(0, 3)
    .map((row) => `${shortenCell(row.item, 30)} ${formatMetricDelta(row.impressions)} impressions`);
  return [
    `*Overall*\n${overall}`,
    appearances.length ? `\n*Search appearance movement*\n${appearances.map((item) => `- ${item}`).join("\n")}` : "",
    `\n*Suggested next action*\n${gscActionItem(pageQueryDrivers, appearances, metrics, urbanIceContext)}`
  ].filter(Boolean);
}

function strongestMover(rows: Array<{ label: string; metric: MetricComparison }>, direction: "up" | "down"): { label: string; metric: MetricComparison } | undefined {
  return rows
    .filter((row) => direction === "up" ? row.metric.delta > 0 : row.metric.delta < 0)
    .sort((a, b) => Math.abs(b.metric.delta) - Math.abs(a.metric.delta))[0];
}

function driverSentence(
  prefix: string,
  page?: { label: string; metric: MetricComparison },
  query?: { label: string; metric: MetricComparison }
): string {
  const parts = [
    page ? `page ${shortenCell(page.label, 44)} (${formatMetricDelta(page.metric)})` : "",
    query ? `query "${shortenCell(query.label, 44)}" (${formatMetricDelta(query.metric)})` : ""
  ].filter(Boolean);
  return parts.length ? `${prefix}: ${parts.join("; ")}.` : "";
}

function gaSummary(ga: Awaited<ReturnType<typeof fetchGaMonitoring>>, compare: boolean): string[] {
  if (!compare) return ["- Comparison is off for this request."];
  if (!ga.metrics) return ["- GA4 metrics were unavailable."];
  const metrics = ga.metrics;
  const overall = metrics.activeUsers?.delta < 0 && metrics.sessions?.delta < 0
    ? "Users and sessions are both down, so traffic needs review."
    : metrics.activeUsers?.delta > 0 && metrics.sessions?.delta > 0
      ? "Users and sessions are both up. This is a positive traffic movement."
      : "Traffic is mixed. Check channel, source, and landing-page drivers.";
  const eventDrops = topGaMoving(ga.keyEventBreakdown, "eventName", "keyEvents", "down");
  const eventWins = topGaMoving(ga.keyEventBreakdown, "eventName", "keyEvents", "up");
  const keyEventSourceDrops = topGaMoving(ga.keyEventBreakdown, "sessionSourceMedium", "keyEvents", "down");
  const keyEventLandingDrops = topGaMoving(ga.keyEventBreakdown, "landingPagePlusQueryString", "keyEvents", "down");
  const keyEventSourceWins = topGaMoving(ga.keyEventBreakdown, "sessionSourceMedium", "keyEvents", "up");
  const keyEventLandingWins = topGaMoving(ga.keyEventBreakdown, "landingPagePlusQueryString", "keyEvents", "up");
  const revenueChannelDrops = topGaMoving(ga.revenueBreakdown, "sessionDefaultChannelGroup", "revenue", "down");
  const revenueSourceDrops = topGaMoving(ga.revenueBreakdown, "sessionSourceMedium", "revenue", "down");
  const revenueLandingDrops = topGaMoving(ga.revenueBreakdown, "landingPagePlusQueryString", "revenue", "down");
  const revenueItemWins = topGaMoving(ga.revenueBreakdown, "itemName", "revenue", "up");
  const eventSummary = gaActionSummary({
    eventDrops,
    eventWins,
    keyEventSourceDrops,
    keyEventLandingDrops,
    keyEventSourceWins,
    keyEventLandingWins,
    revenueChannelDrops,
    revenueSourceDrops,
    revenueLandingDrops,
    revenueItemWins,
    metrics
  });
  return [
    `*Overall*\n${overall}`,
    `\n*Suggested next action*\n${eventSummary}`
  ].filter(Boolean);
}

function gscActionItem(
  pageQueryDrivers: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>,
  appearances: string[],
  metrics: { clicks: MetricComparison; impressions: MetricComparison },
  hasBrandTransitionContext: boolean
): string {
  if (hasBrandTransitionContext) {
    return [
      "The main action is to protect the brand transition. The drop is concentrated around old-brand branded searches and the homepage, while the new-brand query is not showing the same loss.",
      "Check the homepage title/H1 and visible copy for the current brand plus former-name context, then add or verify Organization schema with alternateName for the old brand variants.",
      appearances.length ? "Because Product Snippet visibility also moved, review Product schema on the affected commercial pages after the brand/entity checks." : "After that, compare the same homepage and category pages in GA4 to confirm whether the organic drop is also reducing conversions."
    ].join(" ");
  }

  if (pageQueryDrivers.length) {
    const metricContext = Math.max(metrics.clicks.current, metrics.clicks.previous) <= 10
      ? "This is still small-volume movement, so do not overreact unless the page/query pair is on the priority list."
      : metrics.clicks.delta < 0 && metrics.impressions.delta < 0
        ? "Because both clicks and impressions are down, start with demand/visibility loss rather than only ranking."
        : "Because clicks and impressions are not moving in the same direction, this is a watchlist item until the same page/query also affects sessions, leads, or priority keywords.";
    const appearanceContext = appearances.length
      ? "Because search appearance also moved, check whether rich-result visibility changed for the same URL before deciding the action item."
      : "If GA4 is stable for the same URL, keep this on watch instead of turning it into urgent work.";
    const lead = formatPageQuery(pageQueryDrivers[0]?.item ?? "");
    return `${metricContext} Start with ${lead || "the strongest page + query row above"}, then check that same landing page in GA4. If the URL also lost sessions or key events, create a focused page review task; if it did not, treat it as GSC visibility movement and monitor the next report. ${appearanceContext}`;
  }

  if (metrics.clicks.delta > 0 && metrics.impressions.delta > 0) {
    return "Identify which winning page/query pair drove the lift and consider sharing it as a client-facing win if the query is commercially meaningful.";
  }

  return "No single page + query driver stands out yet. Review the top pages first, then compare GA4 landing-page movement before creating a task.";
}

function gaActionSummary(input: {
  eventDrops: string[];
  eventWins: string[];
  keyEventSourceDrops: string[];
  keyEventLandingDrops: string[];
  keyEventSourceWins: string[];
  keyEventLandingWins: string[];
  revenueChannelDrops: string[];
  revenueSourceDrops: string[];
  revenueLandingDrops: string[];
  revenueItemWins: string[];
  metrics: Record<string, MetricComparison>;
}): string {
  const usersDown = input.metrics.activeUsers?.delta < 0;
  const sessionsDown = input.metrics.sessions?.delta < 0;
  const revenueDown = input.metrics.totalRevenue?.delta < 0;
  const eventDown = input.metrics.keyEvents?.delta < 0;
  const leadingLanding = input.keyEventLandingDrops[0] ?? input.revenueLandingDrops[0];
  const leadingSource = input.keyEventSourceDrops[0] ?? input.revenueSourceDrops[0];

  if ((usersDown || sessionsDown) && leadingLanding) {
    return [
      "Core read: the traffic drop is affecting the funnel, not just visits.",
      `Start with the landing page losing the most key-event value: ${leadingLanding}.`,
      leadingSource ? `Then segment ${leadingSource} and check whether the same source also lost sessions or revenue.` : "",
      "If the same URL also appears in GSC page/query drops, treat this as an SEO-to-conversion issue. If GSC is stable, inspect page UX, product availability, tracking, and checkout path first."
    ].filter(Boolean).join(" ");
  }

  if (!usersDown && !sessionsDown && input.eventWins.length) {
    const source = input.keyEventSourceWins[0] ? ` The strongest source clue is ${input.keyEventSourceWins[0]}.` : "";
    const landing = input.keyEventLandingWins[0] ? ` The strongest landing-page clue is ${input.keyEventLandingWins[0]}.` : "";
    return `Traffic and key events are moving in the right direction. The main lift is ${input.eventWins[0]}.${source}${landing} Check whether this came from a real campaign, direct/branded demand, or tracking changes before sharing it as a client win.`;
  }

  if ((revenueDown || eventDown) && (input.eventDrops.length || input.revenueChannelDrops.length)) {
    const eventPart = input.eventDrops[0] ? `main event issue is ${input.eventDrops[0]}` : "";
    const revenuePart = input.revenueChannelDrops[0] ? `main revenue channel issue is ${input.revenueChannelDrops[0]}` : "";
    return `Prioritize conversion review: ${[eventPart, revenuePart].filter(Boolean).join("; ")}. Check tracking, landing page UX, and source quality before reporting this externally.`;
  }

  if (input.revenueItemWins.length) {
    return `Traffic/conversion risk is limited, but product movement is interesting. Review ${input.revenueItemWins[0]} and consider whether that product/category deserves more promotion.`;
  }

  return "No single GA4 driver clearly explains the movement. Check source/medium first, then landing page, then event names before creating an action item.";
}

function topGaMoving(
  rows: Array<{ label: string; keyEvents?: MetricComparison; revenue?: MetricComparison }>,
  prefix: string,
  metricName: "keyEvents" | "revenue",
  direction: "up" | "down"
): string[] {
  return rows
    .filter((row) => row.label.startsWith(`${prefix}:`))
    .map((row) => ({ label: humanGaLabel(row.label), metric: row[metricName] }))
    .filter((row): row is { label: string; metric: MetricComparison } => Boolean(row.metric))
    .filter((row) => direction === "up" ? row.metric.delta > 0 : row.metric.delta < 0)
    .sort((a, b) => Math.abs(b.metric.delta) - Math.abs(a.metric.delta))
    .slice(0, 5)
    .map((row) => `${row.label} ${formatMetricDelta(row.metric)}`);
}

function topMoving(rows: Array<{ label: string; metric: MetricComparison }>, direction: "up" | "down", shorten = true): string[] {
  return rows
    .filter((row) => direction === "up" ? row.metric.delta > 0 : row.metric.delta < 0)
    .sort((a, b) => Math.abs(b.metric.delta) - Math.abs(a.metric.delta))
    .slice(0, 5)
    .map((row) => `${shorten ? shortenCell(row.label, 42) : row.label} ${formatMetricDelta(row.metric)} clicks`);
}

function formatPageQuery(value: string): string {
  const [page, query] = value.split(" | ");
  return `${pageLabel(page)}${query ? ` from "${query}"` : ""}`;
}

function shortenCell(value: string, maxLength: number): string {
  const compact = cleanLabel(value).replace(/^https?:\/\/(www\.)?/i, "");
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function rangeLabel(range: { startDate: string; endDate: string }): string {
  return range.startDate === range.endDate ? range.endDate : `${range.startDate} to ${range.endDate}`;
}

function humanGaLabel(label: string): string {
  if (/^landingPagePlusQueryString:\s*$/.test(label)) return "landing page / (homepage)";
  const normalized = label
    .replace(/^eventName:\s*/, "event ")
    .replace(/^sessionSourceMedium:\s*/, "source/medium ")
    .replace(/^sessionDefaultChannelGroup:\s*/, "channel ")
    .replace(/^landingPagePlusQueryString:\s*/, "landing page ")
    .replace(/^itemName:\s*/, "item ");
  const cleaned = cleanLabel(normalized);
  if (cleaned.trim() === "landing page" || cleaned.trim() === "landing page /") return "landing page / (homepage)";
  return cleaned;
}

function displayGaLabel(label: string, prefix: string): string {
  const human = humanGaLabel(label);
  if (prefix === "eventName") return human.replace(/^event\s+/, "");
  if (prefix === "sessionSourceMedium") return human.replace(/^source\/medium\s+/, "");
  if (prefix === "sessionDefaultChannelGroup") return human.replace(/^channel\s+/, "");
  if (prefix === "landingPagePlusQueryString") return pageLabel(human.replace(/^landing page\s+/, ""));
  if (prefix === "itemName") return human.replace(/^item\s+/, "");
  return human;
}

function pageLabel(value: string): string {
  return formatPageLabel(value);
}

function meaningfulSearchAppearances(
  rows: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>
): Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }> {
  return rows.filter((row) => Math.abs(row.clicks.delta) >= 3 || Math.abs(row.impressions.delta) >= 50);
}

function hasGaRevenueData(ga: Awaited<ReturnType<typeof fetchGaMonitoring>>): boolean {
  const metrics = ga.metrics;
  if (!metrics) return false;
  if ((metrics.totalRevenue?.current ?? 0) > 0 || (metrics.totalRevenue?.previous ?? 0) > 0) return true;
  if ((metrics.ecommercePurchases?.current ?? 0) > 0 || (metrics.ecommercePurchases?.previous ?? 0) > 0) return true;
  return ga.revenueBreakdown.some((row) =>
    row.revenue.current > 0 ||
    row.revenue.previous > 0 ||
    (row.purchases?.current ?? 0) > 0 ||
    (row.purchases?.previous ?? 0) > 0
  );
}

function periodLabel(period: MonitoringDateSelection): string {
  if (typeof period === "object") return "Custom";
  if (period === "daily") return "Daily";
  if (period === "monthly") return "Monthly";
  if (period === "quarterly") return "3 months";
  if (/^\d+d$/.test(period)) return `${Number.parseInt(period, 10)} days`;
  return "Weekly";
}

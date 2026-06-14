import { google } from "googleapis";
import type { ClientConfig } from "./clients.js";
import { getPriorityQueries, getPriorityUrls } from "./clientMemory.js";
import { getGoogleAuthClient } from "./googleAuth.js";

export type MetricComparison = {
  current: number;
  previous: number;
  delta: number;
  pctChange: number | null;
};

export type GscMonitoringResult = {
  metrics?: {
    clicks: MetricComparison;
    impressions: MetricComparison;
    ctr: MetricComparison;
    position: MetricComparison;
  };
  freshness?: MonitoringFreshness;
  dailyHistory: Array<{ date: string; clicks: number; impressions: number }>;
  topPages: Array<{ page: string; clicks: MetricComparison; impressions: MetricComparison }>;
  topQueries: Array<{ query: string; clicks: MetricComparison; impressions: MetricComparison }>;
  topPageQueries: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>;
  pageMovers: Array<{ page: string; clicks: MetricComparison; impressions: MetricComparison }>;
  queryMovers: Array<{ query: string; clicks: MetricComparison; impressions: MetricComparison }>;
  priorityPages: Array<{ page: string; clicks: MetricComparison; impressions: MetricComparison }>;
  priorityQueries: Array<{ query: string; clicks: MetricComparison; impressions: MetricComparison }>;
  searchAppearances: Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>;
  error?: string;
};

export type GaMonitoringResult = {
  metrics?: Record<string, MetricComparison>;
  freshness?: MonitoringFreshness;
  topChannels: Array<{ channel: string; sessions: number; activeUsers: number }>;
  trafficBreakdown: Array<{ label: string; sessions: MetricComparison; activeUsers?: MetricComparison }>;
  keyEventBreakdown: Array<{ label: string; keyEvents: MetricComparison }>;
  revenueBreakdown: Array<{ label: string; revenue: MetricComparison; purchases?: MetricComparison }>;
  error?: string;
};

export type GscScopedPerformance = {
  dimension: "query" | "page";
  value: string;
  metrics?: {
    clicks: MetricComparison;
    impressions: MetricComparison;
    ctr: MetricComparison;
    position: MetricComparison;
  };
  topQueries?: Array<{ query: string; clicks: MetricComparison; impressions: MetricComparison }>;
  freshness?: MonitoringFreshness;
  error?: string;
};

export type GaScopedPerformance = {
  dimension?: "landingPagePlusQueryString" | "sessionDefaultChannelGroup" | "sessionSourceMedium" | "eventName";
  value?: string;
  metric: "activeUsers" | "sessions" | "keyEvents" | "totalRevenue" | "ecommercePurchases";
  comparison?: MetricComparison;
  rows: Array<{ label: string; metric: MetricComparison; secondary?: MetricComparison }>;
  freshness?: MonitoringFreshness;
  error?: string;
};

type DateRange = {
  startDate: string;
  endDate: string;
};

type MonitoringFreshness = {
  current: DateRange;
  previous: DateRange;
  currentHasData: boolean;
  previousHasData: boolean;
};

export type CustomDateComparison = {
  kind: "custom";
  current: DateRange;
  previous: DateRange;
};

export type MonitoringPeriod = "daily" | "weekly" | "monthly" | "quarterly" | `${number}d`;
export type MonitoringDateSelection = MonitoringPeriod | CustomDateComparison;
type GaDimensionFilter = Record<string, unknown> | undefined;
type GscDimensionFilterGroup = {
  filters?: Array<{
    dimension: string;
    operator: string;
    expression: string;
  }>;
};
type DataFetchOptions = {
  countryFilter?: boolean;
};

export function monitoringDateRanges(source: "gsc" | "ga4", period: MonitoringDateSelection): { current: DateRange; previous: DateRange } {
  return comparisonRanges(source === "gsc" ? 3 : 1, period);
}

export async function fetchGscMonitoring(client: ClientConfig, period: MonitoringDateSelection, options: DataFetchOptions = {}): Promise<GscMonitoringResult> {
  if (!client.gscSite) {
      return { dailyHistory: [], topPages: [], topQueries: [], topPageQueries: [], pageMovers: [], queryMovers: [], priorityPages: [], priorityQueries: [], searchAppearances: [], error: "No GSC site configured." };
  }

  try {
    const auth = await getGoogleAuthClient(client.googleProfile);
    const searchconsole = google.searchconsole({ version: "v1", auth });
    const dimensionFilterGroups = options.countryFilter === false ? undefined : countryFilter(client.mainCountry);
    const ranges = await resolveGscDateRanges(searchconsole, client.gscSite, period, dimensionFilterGroups);
    const priorityQueries = getPriorityQueries(client.client).slice(0, 20);
    const priorityUrls = getPriorityUrls(client.client).slice(0, 20);
    const historyRange = period === "daily" ? dailyHistoryRange(ranges.current.endDate, 56) : undefined;

    const [
      current,
      previous,
      pages,
      previousPages,
      queries,
      previousQueries,
      pageQueries,
      previousPageQueries,
      searchAppearances,
      previousSearchAppearances,
      dailyHistory
    ] = await Promise.all([
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensionFilterGroups,
          rowLimit: 1
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensionFilterGroups,
          rowLimit: 1
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensions: ["page"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensions: ["page"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensions: ["query"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensions: ["query"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensions: ["page", "query"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensions: ["page", "query"],
          dimensionFilterGroups,
          rowLimit: 250
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensions: ["searchAppearance"],
          dimensionFilterGroups,
          rowLimit: 25
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensions: ["searchAppearance"],
          dimensionFilterGroups,
          rowLimit: 100
        }
      }),
      historyRange
        ? searchconsole.searchanalytics.query({
          siteUrl: client.gscSite,
          requestBody: {
            ...historyRange,
            dimensions: ["date"],
            dimensionFilterGroups,
            rowLimit: 80
          }
        })
        : Promise.resolve(undefined)
    ]);

    const [priorityQueryRows, priorityPageRows] = await Promise.all([
      fetchPriorityGscRows(searchconsole, client.gscSite, ranges, dimensionFilterGroups, "query", priorityQueries),
      fetchPriorityGscRows(searchconsole, client.gscSite, ranges, dimensionFilterGroups, "page", priorityUrls)
    ]);

    const currentRow = current.data.rows?.[0];
    const previousRow = previous.data.rows?.[0];

    const comparedPages = compareDimensionRows(pages.data.rows, previousPages.data.rows, "page")
      .filter((row) => hasMeaningfulGscSignal(row.clicks, row.impressions));
    const comparedQueries = compareDimensionRows(queries.data.rows, previousQueries.data.rows, "query")
      .filter((row) => hasMeaningfulGscSignal(row.clicks, row.impressions));
    const comparedPageQueries = compareGscRows(pageQueries.data.rows, previousPageQueries.data.rows, ([page, query]) => `${page ?? ""} | ${query ?? ""}`)
      .filter((row) => hasMeaningfulGscSignal(row.clicks, row.impressions));

    return {
      metrics: {
        clicks: compare(currentRow?.clicks ?? 0, previousRow?.clicks ?? 0),
        impressions: compare(currentRow?.impressions ?? 0, previousRow?.impressions ?? 0),
        ctr: compare(currentRow?.ctr ?? 0, previousRow?.ctr ?? 0),
        position: compare(currentRow?.position ?? 0, previousRow?.position ?? 0)
      },
      freshness: {
        ...ranges,
        currentHasData: Boolean(currentRow),
        previousHasData: Boolean(previousRow)
      },
      dailyHistory: (dailyHistory?.data.rows ?? [])
        .map((row) => ({
          date: row.keys?.[0] ?? "",
          clicks: row.clicks ?? 0,
          impressions: row.impressions ?? 0
        }))
        .filter((row) => Boolean(row.date))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topPages: comparedPages
        .sort((a, b) => b.clicks.current - a.clicks.current)
        .slice(0, 5),
      topQueries: comparedQueries
        .sort((a, b) => b.clicks.current - a.clicks.current)
        .slice(0, 5),
      topPageQueries: comparedPageQueries
        .sort((a, b) => Math.abs(b.clicks.delta) + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) + Math.abs(a.impressions.delta)))
        .slice(0, 10),
      pageMovers: comparedPages
        .sort((a, b) => Math.abs(b.clicks.delta) + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) + Math.abs(a.impressions.delta)))
        .slice(0, 60),
      queryMovers: comparedQueries
        .sort((a, b) => Math.abs(b.clicks.delta) + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) + Math.abs(a.impressions.delta)))
        .slice(0, 60),
      priorityPages: priorityPageRows.map((row) => ({ page: row.item, clicks: row.clicks, impressions: row.impressions })),
      priorityQueries: priorityQueryRows.map((row) => ({ query: row.item, clicks: row.clicks, impressions: row.impressions })),
      searchAppearances: compareGscRows(searchAppearances.data.rows, previousSearchAppearances.data.rows, ([appearance]) => appearance ?? "(not set)")
        .sort((a, b) => Math.abs(b.clicks.delta) + Math.abs(b.impressions.delta) - (Math.abs(a.clicks.delta) + Math.abs(a.impressions.delta)))
        .slice(0, 5)
    };
  } catch (error) {
    return {
      topPages: [],
      dailyHistory: [],
      topQueries: [],
      topPageQueries: [],
      pageMovers: [],
      queryMovers: [],
      priorityPages: [],
      priorityQueries: [],
      searchAppearances: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchGscScopedPerformance(
  client: ClientConfig,
  period: MonitoringDateSelection,
  dimension: "query" | "page",
  value: string,
  options: DataFetchOptions = {}
): Promise<GscScopedPerformance> {
  if (!client.gscSite) return { dimension, value, error: "No GSC site configured." };

  try {
    const auth = await getGoogleAuthClient(client.googleProfile);
    const searchconsole = google.searchconsole({ version: "v1", auth });
    const ranges = comparisonRanges(3, period);
    const filters = addDimensionFilter(options.countryFilter === false ? undefined : countryFilter(client.mainCountry), dimension, dimension === "page" ? normalizePriorityPage(value, client.gscSite) : value);
    const [current, previous, currentQueries, previousQueries] = await Promise.all([
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.current,
          dimensions: [dimension],
          dimensionFilterGroups: filters,
          rowLimit: 1
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl: client.gscSite,
        requestBody: {
          ...ranges.previous,
          dimensions: [dimension],
          dimensionFilterGroups: filters,
          rowLimit: 1
        }
      }),
      dimension === "page"
        ? searchconsole.searchanalytics.query({
          siteUrl: client.gscSite,
          requestBody: {
            ...ranges.current,
            dimensions: ["query"],
            dimensionFilterGroups: filters,
            rowLimit: 25
          }
        })
        : Promise.resolve(undefined),
      dimension === "page"
        ? searchconsole.searchanalytics.query({
          siteUrl: client.gscSite,
          requestBody: {
            ...ranges.previous,
            dimensions: ["query"],
            dimensionFilterGroups: filters,
            rowLimit: 25
          }
        })
        : Promise.resolve(undefined)
    ]);
    const currentRow = current.data.rows?.[0];
    const previousRow = previous.data.rows?.[0];
    const topQueries = dimension === "page"
      ? compareDimensionRows(currentQueries?.data.rows, previousQueries?.data.rows, "query")
        .filter((row) => hasMeaningfulGscSignal(row.clicks, row.impressions))
        .sort((a, b) => b.clicks.current - a.clicks.current || b.impressions.current - a.impressions.current)
        .slice(0, 5)
      : undefined;
    return {
      dimension,
      value: currentRow?.keys?.[0] ?? previousRow?.keys?.[0] ?? value,
      metrics: {
        clicks: compare(currentRow?.clicks ?? 0, previousRow?.clicks ?? 0),
        impressions: compare(currentRow?.impressions ?? 0, previousRow?.impressions ?? 0),
        ctr: compare(currentRow?.ctr ?? 0, previousRow?.ctr ?? 0),
        position: compare(currentRow?.position ?? 0, previousRow?.position ?? 0)
      },
      topQueries,
      freshness: {
        ...ranges,
        currentHasData: Boolean(currentRow),
        previousHasData: Boolean(previousRow)
      }
    };
  } catch (error) {
    return { dimension, value, error: error instanceof Error ? error.message : String(error) };
  }
}

function dailyHistoryRange(endDate: string, days: number): DateRange {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const start = addDays(end, -(days - 1));
  return { startDate: formatDate(start), endDate };
}

async function resolveGscDateRanges(
  searchconsole: ReturnType<typeof google.searchconsole>,
  siteUrl: string,
  period: MonitoringDateSelection,
  dimensionFilterGroups: GscDimensionFilterGroup[] | undefined
): Promise<{ current: DateRange; previous: DateRange }> {
  const fallback = comparisonRanges(3, period);
  if (period !== "daily") return fallback;

  try {
    const end = addDays(new Date(), -1);
    const start = addDays(end, -13);
    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: formatDate(start),
        endDate: formatDate(end),
        dimensions: ["date"],
        dimensionFilterGroups,
        rowLimit: 14
      }
    });
    const dates = (response.data.rows ?? [])
      .filter((row) => (row.clicks ?? 0) > 0 || (row.impressions ?? 0) > 0)
      .map((row) => row.keys?.[0] ?? "")
      .filter(Boolean)
      .sort();
    const available = new Set(dates);
    const currentDate = [...dates].reverse().find((date) => {
      const previousDate = formatDate(addDays(new Date(`${date}T00:00:00.000Z`), -1));
      return available.has(previousDate);
    });
    if (!currentDate) return fallback;
    const previousDate = formatDate(addDays(new Date(`${currentDate}T00:00:00.000Z`), -1));
    return {
      current: { startDate: currentDate, endDate: currentDate },
      previous: { startDate: previousDate, endDate: previousDate }
    };
  } catch {
    return fallback;
  }
}

async function fetchPriorityGscRows(
  searchconsole: ReturnType<typeof google.searchconsole>,
  siteUrl: string,
  ranges: { current: DateRange; previous: DateRange },
  baseFilters: ReturnType<typeof countryFilter>,
  dimension: "query" | "page",
  values: string[]
): Promise<Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }>> {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const rows = await Promise.all(unique.map(async (value) => {
    const filters = addDimensionFilter(baseFilters, dimension, dimension === "page" ? normalizePriorityPage(value, siteUrl) : value);
    const [current, previous] = await Promise.all([
      searchconsole.searchanalytics.query({
        siteUrl,
        requestBody: {
          ...ranges.current,
          dimensions: [dimension],
          dimensionFilterGroups: filters,
          rowLimit: 1
        }
      }),
      searchconsole.searchanalytics.query({
        siteUrl,
        requestBody: {
          ...ranges.previous,
          dimensions: [dimension],
          dimensionFilterGroups: filters,
          rowLimit: 1
        }
      })
    ]);
    const currentRow = current.data.rows?.[0];
    const previousRow = previous.data.rows?.[0];
    return {
      item: currentRow?.keys?.[0] ?? previousRow?.keys?.[0] ?? value,
      clicks: compare(currentRow?.clicks ?? 0, previousRow?.clicks ?? 0),
      impressions: compare(currentRow?.impressions ?? 0, previousRow?.impressions ?? 0)
    };
  }));

  return rows.filter((row) => row.clicks.delta !== 0 || row.impressions.delta !== 0);
}

function addDimensionFilter(
  baseFilters: ReturnType<typeof countryFilter>,
  dimension: "query" | "page",
  expression: string
) : GscDimensionFilterGroup[] {
  const extra = {
    dimension,
    operator: dimension === "page" ? "contains" : "equals",
    expression
  };
  if (!baseFilters?.length) return [{ filters: [extra] }];
  return baseFilters.map((group) => ({
    filters: [...(group.filters ?? []), extra]
  }));
}

function normalizePriorityPage(value: string, siteUrl: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  if (trimmed.startsWith("/") && /^https?:\/\//i.test(siteUrl)) {
    try {
      return new URL(trimmed, siteUrl).toString();
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("/") && /^sc-domain:/i.test(siteUrl)) return trimmed.slice(1);
  if (/^https?:\/\//i.test(value)) return value;
  return trimmed;
}

function hasMeaningfulGscSignal(clicks: MetricComparison, impressions: MetricComparison): boolean {
  return clicks.current > 0 || clicks.previous > 0 || impressions.current > 0 || impressions.previous > 0;
}

function compareGscRows(
  currentRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  previousRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  labelForKeys: (keys: string[]) => string
): Array<{ item: string; clicks: MetricComparison; impressions: MetricComparison }> {
  const currentByKey = rowsByKey(currentRows);
  const previousByKey = rowsByKey(previousRows);
  const keys = new Set([...currentByKey.keys(), ...previousByKey.keys()]);

  return [...keys].map((key) => {
    const current = currentByKey.get(key) ?? { keys: previousByKey.get(key)?.keys ?? [], clicks: 0, impressions: 0 };
    const previous = previousByKey.get(key) ?? { keys: current.keys, clicks: 0, impressions: 0 };
    return {
      item: labelForKeys(current.keys),
      clicks: compare(current.clicks, previous.clicks),
      impressions: compare(current.impressions, previous.impressions)
    };
  });
}

function compareDimensionRows(
  currentRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  previousRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  keyName: "page"
): Array<{ page: string; clicks: MetricComparison; impressions: MetricComparison }>;
function compareDimensionRows(
  currentRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  previousRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  keyName: "query"
): Array<{ query: string; clicks: MetricComparison; impressions: MetricComparison }>;
function compareDimensionRows(
  currentRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  previousRows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined,
  keyName: "page" | "query"
) {
  const currentByKey = rowsByKey(currentRows);
  const previousByKey = rowsByKey(previousRows);
  const keys = new Set([...currentByKey.keys(), ...previousByKey.keys()]);

  return [...keys].map((key) => {
    const current = currentByKey.get(key) ?? { keys: previousByKey.get(key)?.keys ?? [], clicks: 0, impressions: 0 };
    const previous = previousByKey.get(key) ?? { keys: current.keys, clicks: 0, impressions: 0 };
    return {
      [keyName]: current.keys[0] ?? "",
      clicks: compare(current.clicks, previous.clicks),
      impressions: compare(current.impressions, previous.impressions)
    };
  });
}

function rowsByKey(
  rows: Array<{ keys?: string[] | null; clicks?: number | null; impressions?: number | null }> | undefined
): Map<string, { keys: string[]; clicks: number; impressions: number }> {
  return new Map(
    (rows ?? []).map((row) => {
      const keys = row.keys ?? [];
      return [
        keys.join("\u0001"),
        {
          keys,
          clicks: row.clicks ?? 0,
          impressions: row.impressions ?? 0
        }
      ];
    })
  );
}

export async function fetchGaMonitoring(client: ClientConfig, period: MonitoringDateSelection, options: DataFetchOptions = {}): Promise<GaMonitoringResult> {
  if (!client.ga4PropertyId) {
    return { topChannels: [], trafficBreakdown: [], keyEventBreakdown: [], revenueBreakdown: [], error: "No GA4 property configured." };
  }

  try {
    const auth = await getGoogleAuthClient(client.googleProfile);
    const analyticsData = google.analyticsdata({ version: "v1beta", auth });
    const ranges = comparisonRanges(1, period);
    const dimensionFilter = options.countryFilter === false ? undefined : gaCountryFilter(client.mainCountry);
    const metrics = [
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "keyEvents" },
      { name: "totalRevenue" },
      { name: "ecommercePurchases" }
    ];

    const [
      summary,
      channels,
      trafficByChannel,
      trafficBySource,
      trafficByLanding,
      keyEventsByEvent,
      keyEventsBySource,
      keyEventsByLanding,
      revenueByChannel,
      revenueBySource,
      revenueByLanding,
      revenueByItem
    ] = await Promise.all([
      analyticsData.properties.runReport({
        property: `properties/${client.ga4PropertyId}`,
        requestBody: {
          dateRanges: [
            { name: "current", ...ranges.current },
            { name: "previous", ...ranges.previous }
          ],
          metrics,
          dimensionFilter
        }
      }),
      analyticsData.properties.runReport({
        property: `properties/${client.ga4PropertyId}`,
        requestBody: {
          dateRanges: [{ ...ranges.current }],
          dimensions: [{ name: "sessionDefaultChannelGroup" }],
          metrics: [{ name: "sessions" }, { name: "activeUsers" }],
          dimensionFilter,
          orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
          limit: "5"
        }
      }),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "sessionDefaultChannelGroup", "sessions", "activeUsers", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "sessionSourceMedium", "sessions", "activeUsers", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "landingPagePlusQueryString", "sessions", "activeUsers", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "eventName", "keyEvents", undefined, dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "sessionSourceMedium", "keyEvents", undefined, dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "landingPagePlusQueryString", "keyEvents", undefined, dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "sessionDefaultChannelGroup", "totalRevenue", "ecommercePurchases", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "sessionSourceMedium", "totalRevenue", "ecommercePurchases", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "landingPagePlusQueryString", "totalRevenue", "ecommercePurchases", dimensionFilter),
      runGaBreakdown(analyticsData, client.ga4PropertyId, ranges, "itemName", "itemRevenue", "itemsPurchased", dimensionFilter)
    ]);

    const current = summary.data.rows?.find((row) => row.dimensionValues?.[0]?.value === "current");
    const previous = summary.data.rows?.find((row) => row.dimensionValues?.[0]?.value === "previous");
    const metricHeaders = summary.data.metricHeaders?.map((header) => header.name ?? "") ?? [];
    const resultMetrics: Record<string, MetricComparison> = {};
    const currentHasData = Boolean(current) && hasAnyMetricValue(current?.metricValues);
    const previousHasData = Boolean(previous) && hasAnyMetricValue(previous?.metricValues);

    metricHeaders.forEach((name, index) => {
      resultMetrics[name] = compare(
        Number(current?.metricValues?.[index]?.value ?? 0),
        Number(previous?.metricValues?.[index]?.value ?? 0)
      );
    });

    return {
      metrics: resultMetrics,
      freshness: {
        ...ranges,
        currentHasData,
        previousHasData
      },
      topChannels:
        channels.data.rows?.map((row) => ({
          channel: row.dimensionValues?.[0]?.value ?? "(not set)",
          sessions: Number(row.metricValues?.[0]?.value ?? 0),
          activeUsers: Number(row.metricValues?.[1]?.value ?? 0)
        })) ?? [],
      trafficBreakdown: topRowsByGroup([trafficByChannel, trafficBySource, trafficByLanding], 5).map((row) => ({
        label: row.label,
        sessions: row.primary,
        activeUsers: row.secondary
      })),
      keyEventBreakdown: topRowsByGroup([keyEventsByEvent, keyEventsBySource, keyEventsByLanding], 5).map((row) => ({
        label: row.label,
        keyEvents: row.primary
      })),
      revenueBreakdown: topRowsByGroup([revenueByChannel, revenueBySource, revenueByLanding, revenueByItem], 5).map((row) => ({
        label: row.label,
        revenue: row.primary,
        purchases: row.secondary
      }))
    };
  } catch (error) {
    return {
      topChannels: [],
      trafficBreakdown: [],
      keyEventBreakdown: [],
      revenueBreakdown: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchGaScopedPerformance(
  client: ClientConfig,
  period: MonitoringDateSelection,
  input: {
    metric: GaScopedPerformance["metric"];
    dimension?: GaScopedPerformance["dimension"];
    value?: string;
  },
  options: DataFetchOptions = {}
): Promise<GaScopedPerformance> {
  if (!client.ga4PropertyId) return { ...input, rows: [], error: "No GA4 property configured." };

  try {
    const auth = await getGoogleAuthClient(client.googleProfile);
    const analyticsData = google.analyticsdata({ version: "v1beta", auth });
    const ranges = comparisonRanges(1, period);
    const baseFilter = options.countryFilter === false ? undefined : gaCountryFilter(client.mainCountry);
    const dimensionFilter = input.dimension && input.value
      ? mergeGaDimensionFilters(baseFilter, gaStringFilter(input.dimension, input.value, input.dimension === "eventName" ? "EXACT" : "CONTAINS"))
      : baseFilter;

    if (!input.dimension) {
      const response = await analyticsData.properties.runReport({
        property: `properties/${client.ga4PropertyId}`,
        requestBody: {
          dateRanges: [
            { name: "current", ...ranges.current },
            { name: "previous", ...ranges.previous }
          ],
          metrics: [{ name: input.metric }],
          dimensionFilter
        }
      });
      const current = response.data.rows?.find((row) => row.dimensionValues?.[0]?.value === "current");
      const previous = response.data.rows?.find((row) => row.dimensionValues?.[0]?.value === "previous");
      return {
        ...input,
        comparison: compare(
          Number(current?.metricValues?.[0]?.value ?? 0),
          Number(previous?.metricValues?.[0]?.value ?? 0)
        ),
        rows: [],
        freshness: {
          ...ranges,
          currentHasData: hasAnyMetricValue(current?.metricValues),
          previousHasData: hasAnyMetricValue(previous?.metricValues)
        }
      };
    }

    const secondaryMetric = input.metric === "totalRevenue" ? "ecommercePurchases" : input.metric === "sessions" ? "activeUsers" : undefined;
    const rows = await runGaBreakdown(
      analyticsData,
      client.ga4PropertyId,
      ranges,
      input.dimension,
      input.metric,
      secondaryMetric,
      dimensionFilter
    );
    return {
      ...input,
      rows: rows.slice(0, input.value ? 5 : 10).map((row) => ({
        label: row.label,
        metric: row.primary,
        secondary: row.secondary
      })),
      freshness: {
        ...ranges,
        currentHasData: rows.some((row) => row.primary.current > 0),
        previousHasData: rows.some((row) => row.primary.previous > 0)
      }
    };
  } catch (error) {
    return { ...input, rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function mergeGaDimensionFilters(baseFilter: GaDimensionFilter, extraFilter: Record<string, unknown>): GaDimensionFilter {
  if (!baseFilter) return extraFilter;
  return {
    andGroup: {
      expressions: [
        baseFilter,
        extraFilter
      ]
    }
  };
}

function gaStringFilter(dimension: string, value: string, matchType: "EXACT" | "CONTAINS"): Record<string, unknown> {
  return {
    filter: {
      fieldName: dimension,
      stringFilter: {
        matchType,
        value,
        caseSensitive: false
      }
    }
  };
}

function hasAnyMetricValue(values: Array<{ value?: string | null }> | null | undefined): boolean {
  return (values ?? []).some((value) => Number(value.value ?? 0) > 0);
}

function topRowsByGroup(
  groups: Array<Array<{ label: string; primary: MetricComparison; secondary?: MetricComparison }>>,
  perGroup: number
): Array<{ label: string; primary: MetricComparison; secondary?: MetricComparison }> {
  return groups.flatMap((group) =>
    group
      .filter((row) => row.primary.current > 0 || row.primary.previous > 0)
      .slice(0, perGroup)
  );
}

async function runGaBreakdown(
  analyticsData: ReturnType<typeof google.analyticsdata>,
  propertyId: string,
  ranges: { current: DateRange; previous: DateRange },
  dimension: string,
  primaryMetric: string,
  secondaryMetric?: string,
  dimensionFilter?: GaDimensionFilter
): Promise<Array<{ label: string; primary: MetricComparison; secondary?: MetricComparison }>> {
  try {
    const metrics = [{ name: primaryMetric }, ...(secondaryMetric ? [{ name: secondaryMetric }] : [])];
    const response = await analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [
          { name: "current", ...ranges.current },
          { name: "previous", ...ranges.previous }
        ],
        dimensions: [{ name: dimension }],
        metrics,
        dimensionFilter,
        orderBys: [{ metric: { metricName: primaryMetric }, desc: true }],
        limit: "12"
      }
    });

    const previousByLabel = new Map<string, { primary: number; secondary: number }>();
    const currentByLabel = new Map<string, { primary: number; secondary: number }>();

    for (const row of response.data.rows ?? []) {
      const values = row.dimensionValues?.map((item) => item.value ?? "") ?? [];
      const rangeName = values.includes("previous") ? "previous" : "current";
      const dimensionValue = values.find((value) => value !== "current" && value !== "previous") ?? "(not set)";
      const label = `${dimension}: ${dimensionValue}`;
      const primary = Number(row.metricValues?.[0]?.value ?? 0);
      const secondary = Number(row.metricValues?.[1]?.value ?? 0);
      if (rangeName === "previous") {
        previousByLabel.set(label, { primary, secondary });
      } else {
        currentByLabel.set(label, { primary, secondary });
      }
    }

    const labels = new Set([...currentByLabel.keys(), ...previousByLabel.keys()]);
    return [...labels].map((label) => {
      const current = currentByLabel.get(label) ?? { primary: 0, secondary: 0 };
      const previous = previousByLabel.get(label) ?? { primary: 0, secondary: 0 };
      return {
        label,
        primary: compare(current.primary, previous.primary),
        ...(secondaryMetric ? { secondary: compare(current.secondary, previous.secondary) } : {})
      };
    }).sort((a, b) => Math.abs(b.primary.delta) - Math.abs(a.primary.delta));
  } catch {
    return [];
  }
}

export function compare(current: number, previous: number): MetricComparison {
  const delta = current - previous;
  const pctChange = previous === 0 ? null : (delta / previous) * 100;
  return { current, previous, delta, pctChange };
}

function comparisonRanges(delayDays: number, period: MonitoringDateSelection): { current: DateRange; previous: DateRange } {
  if (typeof period === "object") {
    return {
      current: period.current,
      previous: period.previous
    };
  }

  const days = periodDays(period);
  const end = addDays(new Date(), -delayDays);
  const start = addDays(end, -(days - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));

  return {
    current: { startDate: formatDate(start), endDate: formatDate(end) },
    previous: { startDate: formatDate(previousStart), endDate: formatDate(previousEnd) }
  };
}

function periodDays(period: MonitoringPeriod): number {
  if (period === "daily") return 1;
  if (period === "monthly") return 28;
  if (period === "quarterly") return 90;
  if (/^\d+d$/.test(period)) return Math.max(1, Math.min(548, Number.parseInt(period, 10)));
  return 7;
}

function countryFilter(country: string) {
  if (!country || country.toLowerCase() === "global") return undefined;

  return [
    {
      filters: [
        {
          dimension: "country",
          operator: "equals",
          expression: country.toLowerCase()
        }
      ]
    }
  ];
}

function gaCountryFilter(country: string): GaDimensionFilter {
  const countryId = gaCountryId(country);
  if (!countryId) return undefined;

  return {
    filter: {
      fieldName: "countryId",
      stringFilter: {
        matchType: "EXACT",
        value: countryId
      }
    }
  };
}

function gaCountryId(country: string): string | undefined {
  const normalized = country.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized || normalized === "global") return undefined;

  const map: Record<string, string> = {
    usa: "US",
    us: "US",
    unitedstates: "US",
    can: "CA",
    ca: "CA",
    canada: "CA",
    gbr: "GB",
    uk: "GB",
    unitedkingdom: "GB",
    irl: "IE",
    ie: "IE",
    ireland: "IE",
    aus: "AU",
    au: "AU",
    australia: "AU",
    chn: "CN",
    cn: "CN",
    china: "CN",
    npl: "NP",
    np: "NP",
    nepal: "NP"
  };

  return map[normalized] ?? country.toUpperCase();
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

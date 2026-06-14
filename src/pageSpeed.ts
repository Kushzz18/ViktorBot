import type { ClientConfig } from "./clients.js";
import { config } from "./config.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PageSpeedResult = {
  mobile?: PageSpeedStrategyResult;
  desktop?: PageSpeedStrategyResult;
  previous?: PageSpeedHistoryEntry;
  trendAlerts?: string[];
  error?: string;
  disabled?: boolean;
};

export type PageSpeedStrategyResult = {
  performanceScore?: number;
  lcpMs?: number;
  inpMs?: number;
  cls?: number;
  status: "ok" | "needs-attention" | "poor" | "error";
};

export type PageSpeedHistoryEntry = {
  client: string;
  url: string;
  checkedAt: string;
  mobile?: PageSpeedStrategyResult;
  desktop?: PageSpeedStrategyResult;
};

const historyPath = join(config.DATA_DIR, "pagespeed-history.json");

export async function checkPageSpeed(client: ClientConfig): Promise<PageSpeedResult> {
  if (!config.PAGESPEED_API_KEY) {
    return { disabled: true, error: "PageSpeed API key is not configured." };
  }

  const url = pageUrl(client);

  try {
    const [mobile, desktop] = await Promise.all([
      fetchPageSpeed(url, "mobile"),
      fetchPageSpeed(url, "desktop")
    ]);

    const { previous, trendAlerts } = await recordPageSpeedHistory(client, url, { mobile, desktop });
    return { mobile, desktop, previous, trendAlerts };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function recordPageSpeedHistory(
  client: ClientConfig,
  url: string,
  result: Pick<PageSpeedResult, "mobile" | "desktop">
): Promise<{ previous?: PageSpeedHistoryEntry; trendAlerts: string[] }> {
  const history = await loadPageSpeedHistory();
  const previous = [...history]
    .reverse()
    .find((entry) => entry.client === client.client && entry.url === url);
  const nextEntry: PageSpeedHistoryEntry = {
    client: client.client,
    url,
    checkedAt: new Date().toISOString(),
    mobile: result.mobile,
    desktop: result.desktop
  };

  history.push(nextEntry);
  const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const trimmed = history
    .filter((entry) => Date.parse(entry.checkedAt) >= cutoff)
    .slice(-5000);
  await savePageSpeedHistory(trimmed);

  return {
    previous,
    trendAlerts: previous ? pageSpeedTrendAlerts(previous, nextEntry) : []
  };
}

async function loadPageSpeedHistory(): Promise<PageSpeedHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8")) as PageSpeedHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
}

async function savePageSpeedHistory(history: PageSpeedHistoryEntry[]) {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

function pageSpeedTrendAlerts(previous: PageSpeedHistoryEntry, current: PageSpeedHistoryEntry): string[] {
  return [
    trendAlert("mobile", previous.mobile, current.mobile),
    trendAlert("desktop", previous.desktop, current.desktop)
  ].filter((value): value is string => Boolean(value));
}

function trendAlert(
  label: "mobile" | "desktop",
  previous?: PageSpeedStrategyResult,
  current?: PageSpeedStrategyResult
): string | undefined {
  if (!previous?.performanceScore || !current?.performanceScore) return undefined;
  const delta = current.performanceScore - previous.performanceScore;
  const statusWorse = statusRank(current.status) > statusRank(previous.status);
  if (delta > -15 && !statusWorse) return undefined;
  return `PSI ${label} trend worsened - score ${previous.performanceScore} -> ${current.performanceScore}${statusWorse ? `, status ${previous.status} -> ${current.status}` : ""}`;
}

function statusRank(status: PageSpeedStrategyResult["status"]): number {
  return { ok: 0, "needs-attention": 1, poor: 2, error: 3 }[status];
}

function pageUrl(client: ClientConfig): string {
  if (client.gscSite?.startsWith("http")) return client.gscSite;
  if (client.gscSite?.startsWith("sc-domain:")) return `https://${client.gscSite.replace("sc-domain:", "")}/`;
  throw new Error(`No PageSpeed URL configured for ${client.client}`);
}

async function fetchPageSpeed(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedStrategyResult> {
  const apiUrl = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  apiUrl.searchParams.set("url", url);
  apiUrl.searchParams.set("strategy", strategy);
  apiUrl.searchParams.set("category", "performance");
  if (config.PAGESPEED_API_KEY) {
    apiUrl.searchParams.set("key", config.PAGESPEED_API_KEY);
  }

  const response = await fetch(apiUrl);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PageSpeed ${strategy} failed (${response.status}): ${extractGoogleError(text)}`);
  }

  const data = (await response.json()) as {
    lighthouseResult?: {
      categories?: { performance?: { score?: number } };
      audits?: Record<string, { numericValue?: number }>;
    };
  };

  const performanceScore = Math.round((data.lighthouseResult?.categories?.performance?.score ?? 0) * 100);
  const lcpMs = data.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue;
  const inpMs = data.lighthouseResult?.audits?.["interaction-to-next-paint"]?.numericValue;
  const cls = data.lighthouseResult?.audits?.["cumulative-layout-shift"]?.numericValue;

  return {
    performanceScore,
    lcpMs,
    inpMs,
    cls,
    status: pageSpeedStatus(performanceScore, lcpMs, inpMs, cls)
  };
}

function extractGoogleError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 220);
  } catch {
    return text.replace(/\s+/g, " ").slice(0, 220);
  }
}

function pageSpeedStatus(
  performanceScore?: number,
  lcpMs?: number,
  inpMs?: number,
  cls?: number
): PageSpeedStrategyResult["status"] {
  if (
    (performanceScore ?? 100) < 50 ||
    (lcpMs ?? 0) > 4000 ||
    (inpMs ?? 0) > 500 ||
    (cls ?? 0) > 0.25
  ) {
    return "poor";
  }

  if (
    (performanceScore ?? 100) < 75 ||
    (lcpMs ?? 0) > 2500 ||
    (inpMs ?? 0) > 200 ||
    (cls ?? 0) > 0.1
  ) {
    return "needs-attention";
  }

  return "ok";
}

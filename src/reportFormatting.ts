import type { MetricComparison } from "./monitoringGoogle.js";

export function formatMetricDelta(metric: MetricComparison): string {
  const pct = metric.pctChange === null ? "new" : `${metric.pctChange >= 0 ? "+" : ""}${metric.pctChange.toFixed(0)}%`;
  return `${formatDelta(metric.delta)} (${pct})`;
}

export function formatDelta(value: number, digits = 0): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function formatPageLabel(value: string): string {
  const cleaned = cleanLabel(value);
  if (!cleaned || cleaned === "/" || cleaned === "(homepage)") return "/ (homepage)";
  try {
    const url = new URL(cleaned);
    return `${url.pathname || "/"}${url.search || ""}` || "/ (homepage)";
  } catch {
    const withoutDomain = cleaned.replace(/^https?:\/\/(www\.)?[^/]+/i, "");
    if (!withoutDomain || withoutDomain === "/") return "/ (homepage)";
    return withoutDomain.startsWith("/") ? withoutDomain : `/${withoutDomain}`;
  }
}

export function formatMetricRows(
  rows: Array<{ label: string; clicks: MetricComparison; impressions: MetricComparison }>,
  compare: boolean
): string[] {
  if (!rows.length) return ["No data returned."];
  if (rows.some((row) => cleanLabel(row.label).length > 41)) {
    return rows.map((row, index) => {
      if (!compare) {
        return `${index + 1}. ${row.label}\n   Clicks: ${row.clicks.current.toFixed(0)} | Impressions: ${row.impressions.current.toFixed(0)}`;
      }
      return [
        `${index + 1}. ${row.label}`,
        `   Clicks: ${row.clicks.previous.toFixed(0)} -> ${row.clicks.current.toFixed(0)} (${formatMetricDelta(row.clicks)})`,
        `   Impressions: ${row.impressions.previous.toFixed(0)} -> ${row.impressions.current.toFixed(0)} (${formatMetricDelta(row.impressions)})`
      ].join("\n");
    });
  }

  const body = rows.map((row, index) => {
    const label = safeTableText(row.label).padEnd(44, " ");
    if (!compare) return `${index + 1}. ${label} | ${row.clicks.current.toFixed(0).padStart(6, " ")} | ${row.impressions.current.toFixed(0).padStart(7, " ")}`;
    return `${index + 1}. ${label} | ${row.clicks.current.toFixed(0).padStart(6, " ")} | ${formatMetricDelta(row.clicks).padStart(13, " ")} | ${row.impressions.current.toFixed(0).padStart(7, " ")} | ${formatMetricDelta(row.impressions).padStart(13, " ")}`;
  });
  const header = compare
    ? ["Item                                         | Clicks | Clicks Delta | Impr.   | Impr. Delta", "---------------------------------------------+--------+--------------+---------+-------------"]
    : ["Item                                         | Clicks | Impr.", "---------------------------------------------+--------+-------"];
  return [...header, ...body].map((line) => `\`${line}\``);
}

export function cleanLabel(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeTableText(value: string): string {
  return cleanLabel(value).replace(/[`|]/g, " ").slice(0, 41);
}

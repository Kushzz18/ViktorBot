import { google } from "googleapis";
import type { ClientConfig } from "./clients.js";
import { getGoogleAuthClient } from "./googleAuth.js";
import { checkUrl } from "./siteChecks.js";

export type IndexingIssue = {
  url: string;
  coverageState: string;
  indexingState?: string;
};

const MAX_URLS_PER_CLIENT = 25;

export async function checkIndexableNotIndexed(client: ClientConfig): Promise<{ issues: IndexingIssue[]; error?: string }> {
  if (!client.gscSite) return { issues: [], error: "No GSC site configured." };

  try {
    const homepage = homepageFromClient(client);
    const candidates = await discoverCandidateUrls(homepage);
    const auth = await getGoogleAuthClient(client.googleProfile);
    const searchconsole = google.searchconsole({ version: "v1", auth });
    const issues: IndexingIssue[] = [];

    for (const url of candidates.slice(0, MAX_URLS_PER_CLIENT)) {
      const crawl = await checkUrl(url);
      if (!crawl.ok || crawl.noindex || (crawl.status && crawl.status >= 400)) continue;

      const inspected = await searchconsole.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: crawl.finalUrl ?? url,
          siteUrl: client.gscSite
        }
      });
      const indexStatus = inspected.data.inspectionResult?.indexStatusResult;
      const coverageState = indexStatus?.coverageState ?? "Unknown";
      const indexingState = indexStatus?.indexingState ?? undefined;

      if (isNotIndexed(coverageState, indexingState)) {
        issues.push({
          url: crawl.finalUrl ?? url,
          coverageState,
          indexingState
        });
      }
    }

    return { issues };
  } catch (error) {
    return { issues: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function discoverCandidateUrls(homepage: string): Promise<string[]> {
  const urls = new Set<string>([homepage]);
  const sitemapUrls = [new URL("/sitemap.xml", homepage).toString()];

  try {
    const robots = await fetch(new URL("/robots.txt", homepage)).then((response) => response.ok ? response.text() : "");
    for (const line of robots.split(/\r?\n/)) {
      const match = line.match(/^sitemap:\s*(.+)$/i);
      if (match?.[1]) sitemapUrls.push(match[1].trim());
    }
  } catch {
    // Best-effort discovery.
  }

  for (const sitemapUrl of [...new Set(sitemapUrls)].slice(0, 4)) {
    await collectSitemapUrls(sitemapUrl, urls, homepage, 0);
  }

  return [...urls].filter((url) => sameHost(homepage, url) && !isLikelyAsset(url)).slice(0, MAX_URLS_PER_CLIENT);
}

async function collectSitemapUrls(sitemapUrl: string, urls: Set<string>, homepage: string, depth: number): Promise<void> {
  if (depth > 1 || urls.size >= MAX_URLS_PER_CLIENT) return;

  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) return;

    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeXml(match[1] ?? ""));

    for (const loc of locs.slice(0, 120)) {
      if (urls.size >= MAX_URLS_PER_CLIENT) return;
      if (!sameHost(homepage, loc)) continue;
      if (loc.endsWith(".xml")) {
        await collectSitemapUrls(loc, urls, homepage, depth + 1);
      } else {
        urls.add(loc);
      }
    }
  } catch {
    // Ignore sitemap failures.
  }
}

function isNotIndexed(coverageState: string, indexingState?: string): boolean {
  const coverage = coverageState.toLowerCase();
  const indexed = coverage.includes("indexed") && !coverage.includes("not indexed");
  const excluded = /excluded|crawled|discovered|alternate|duplicate|redirect|not found|blocked|not indexed/i.test(coverageState);
  return !indexed || excluded || indexingState === "INDEXING_STATE_UNSPECIFIED";
}

function homepageFromClient(client: ClientConfig): string {
  if (client.gscSite?.startsWith("http")) return client.gscSite;
  if (client.gscSite?.startsWith("sc-domain:")) return `https://${client.gscSite.replace("sc-domain:", "")}/`;
  throw new Error(`No crawlable URL configured for ${client.client}`);
}

function sameHost(homepage: string, url: string): boolean {
  try {
    return new URL(homepage).hostname.replace(/^www\./, "") === new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function isLikelyAsset(value: string): boolean {
  return /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js)$/i.test(new URL(value).pathname);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

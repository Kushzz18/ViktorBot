import { lookup } from "node:dns/promises";
import tls from "node:tls";
import type { ClientConfig } from "./clients.js";
import type { StoredTechnicalSnapshot } from "./monitoringStore.js";

export type SiteCheckResult = {
  url: string;
  finalUrl?: string;
  status?: number;
  fetchError?: string;
  accessBlocked?: boolean;
  accessBlockReason?: string;
  ok: boolean;
  dnsOk: boolean;
  sslDaysRemaining?: number;
  title?: string;
  metaDescription?: string;
  h1?: string;
  canonical?: string;
  robotsDirective?: string;
  noindex: boolean;
  schemaTypes: string[];
  schemaErrors: string[];
  alerts: string[];
};

export async function checkClientSite(
  client: ClientConfig,
  previous?: StoredTechnicalSnapshot
): Promise<SiteCheckResult> {
  const url = homepageFromClient(client);
  const result = await checkUrl(url, previous);
  return {
    ...result,
    alerts: [...result.alerts, ...homepageSchemaAlerts(result.schemaTypes)]
  };
}

export async function checkUrl(
  url: string,
  previous?: StoredTechnicalSnapshot,
  options?: { alertWhenNoSchema?: boolean }
): Promise<SiteCheckResult> {
  const alerts: string[] = [];
  const dnsOk = await checkDns(url);
  const sslDaysRemaining = await checkSsl(url);
  const response = await fetchHtml(url);
  const hasReliableHtml = Boolean(response.ok && response.html);
  const accessBlockReason = response.html ? detectAccessBlock(response.html, response.finalUrl) : undefined;
  const accessBlocked = Boolean(accessBlockReason);

  if (!dnsOk) alerts.push("DNS lookup failed");
  if (sslDaysRemaining !== undefined && sslDaysRemaining < 14) {
    alerts.push(`SSL certificate expires in ${sslDaysRemaining} days`);
  }
  if (!response.ok && response.status) alerts.push(`HTTP status problem: ${response.status}`);
  if (response.status && response.status >= 500) alerts.push(`5xx response detected: ${response.status}`);

  const extracted = response.html ? extractTechnicalSignals(response.html, response.headers) : emptySignals(response.headers);
  if (accessBlocked) alerts.push(`Bot/site access blocked: ${accessBlockReason}`);
  if (hasReliableHtml && !accessBlocked && extracted.noindex) alerts.push("Page appears to be noindex");
  if (hasReliableHtml && !accessBlocked && !extracted.canonical) alerts.push("Canonical tag missing");
  if (hasReliableHtml && !accessBlocked && !extracted.title) alerts.push("Title tag missing");
  if (hasReliableHtml && !accessBlocked && !extracted.h1) alerts.push("H1 missing");
  const redirected = Boolean(response.finalUrl && normalizeUrl(response.finalUrl) !== normalizeUrl(url));
  if (hasReliableHtml && !accessBlocked && redirected) alerts.push(`URL redirects to ${response.finalUrl}`);
  if (hasReliableHtml && !accessBlocked && options?.alertWhenNoSchema && !redirected && !extracted.schemaTypes.length) alerts.push("No JSON-LD schema detected");
  if (hasReliableHtml && !accessBlocked && !redirected && previous?.schemaTypes.length && !extracted.schemaTypes.length) {
    alerts.push(`Schema removed. Previously saw: ${previous.schemaTypes.join(", ")}`);
  }
  if (hasReliableHtml && !accessBlocked && extracted.schemaErrors.length) alerts.push(`Schema JSON parse errors: ${extracted.schemaErrors.length}`);

  if (previous && hasReliableHtml && !accessBlocked) {
    if (changed(previous.title, extracted.title)) alerts.push("Title changed since last snapshot");
    if (changed(previous.metaDescription, extracted.metaDescription)) alerts.push("Meta description changed since last snapshot");
    if (changed(previous.h1, extracted.h1)) alerts.push("H1 changed since last snapshot");
    if (changed(previous.canonical, extracted.canonical)) alerts.push("Canonical changed since last snapshot");
    if (changed(previous.robotsDirective, extracted.robotsDirective)) {
      alerts.push(`Meta robots changed from "${previous.robotsDirective || "none"}" to "${extracted.robotsDirective || "none"}"`);
    }
  }

  return {
    url,
    finalUrl: response.finalUrl,
    status: response.status,
    fetchError: response.fetchError,
    accessBlocked,
    accessBlockReason,
    ok: response.ok && dnsOk && !extracted.noindex && !accessBlocked,
    dnsOk,
    sslDaysRemaining,
    ...extracted,
    alerts
  };
}

function detectAccessBlock(html: string, finalUrl?: string): string | undefined {
  const haystack = `${finalUrl ?? ""}\n${html}`.toLowerCase();
  if (haystack.includes("/.well-known/sgcaptcha") || haystack.includes("sgcaptcha") || haystack.includes("siteground")) {
    return "SiteGround verification/captcha page";
  }
  if (/(cf-chl|\/cdn-cgi\/challenge-platform|turnstile|g-recaptcha|hcaptcha|recaptcha|checking your browser|verify you are human|just a moment\.\.\.)/i.test(haystack)) {
    return "anti-bot/captcha page";
  }
  return undefined;
}

export function snapshotFromSiteCheck(result: SiteCheckResult): StoredTechnicalSnapshot {
  return {
    title: result.title,
    metaDescription: result.metaDescription,
    h1: result.h1,
    canonical: result.canonical,
    robotsDirective: result.robotsDirective,
    schemaTypes: result.schemaTypes
  };
}

function homepageFromClient(client: ClientConfig): string {
  if (client.gscSite?.startsWith("http")) return client.gscSite;
  if (client.gscSite?.startsWith("sc-domain:")) return `https://${client.gscSite.replace("sc-domain:", "")}/`;
  throw new Error(`No crawlable URL configured for ${client.client}`);
}

async function checkDns(url: string): Promise<boolean> {
  try {
    await lookup(new URL(url).hostname);
    return true;
  } catch {
    return false;
  }
}

async function checkSsl(url: string): Promise<number | undefined> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") return undefined;

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: parsed.hostname,
        port: 443,
        servername: parsed.hostname,
        timeout: 8000
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const validTo = cert.valid_to ? new Date(cert.valid_to).getTime() : undefined;
        resolve(validTo ? Math.ceil((validTo - Date.now()) / 86400000) : undefined);
      }
    );

    socket.on("error", () => resolve(undefined));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

async function fetchHtml(url: string): Promise<{
  ok: boolean;
  status?: number;
  finalUrl?: string;
  html?: string;
  fetchError?: string;
  headers: Headers;
}> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ViktorBot/0.1; +https://rankmetop.com/seo-monitoring)"
      }
    });
    const contentType = response.headers.get("content-type") ?? "";
    const html = contentType.includes("text/html") ? await response.text() : "";

    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      html,
      headers: response.headers
    };
  } catch (error) {
    return {
      ok: false,
      fetchError: error instanceof Error ? error.message : String(error),
      headers: new Headers()
    };
  }
}

function extractTechnicalSignals(html: string, headers: Headers) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription = firstMatch(
    html,
    /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i
  );
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const canonical = firstMatch(html, /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["'][^>]*>/i);
  const robots = [
    firstMatch(html, /<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i),
    headers.get("x-robots-tag") ?? ""
  ].filter(Boolean).join("; ");
  const noindex = /\bnoindex\b/i.test(robots);
  const { schemaTypes, schemaErrors } = extractJsonLd(html);

  return {
    title: cleanText(title),
    metaDescription: cleanText(metaDescription),
    h1: cleanText(stripTags(h1 ?? "")),
    canonical: canonical?.trim(),
    robotsDirective: cleanText(robots) || undefined,
    noindex,
    schemaTypes,
    schemaErrors
  };
}

function emptySignals(headers: Headers) {
  const noindex = /\bnoindex\b/i.test(headers.get("x-robots-tag") ?? "");

  return {
    title: undefined,
    metaDescription: undefined,
    h1: undefined,
    canonical: undefined,
    robotsDirective: cleanText(headers.get("x-robots-tag") ?? "") || undefined,
    noindex,
    schemaTypes: [],
    schemaErrors: []
  };
}

function homepageSchemaAlerts(schemaTypes: string[]): string[] {
  const meaningfulTypes = schemaTypes.filter((type) => !isIgnoredHomepageSchemaType(type));
  if (!meaningfulTypes.length) return [];

  const alerts: string[] = [];
  const genericTypes = meaningfulTypes.filter((type) => isGenericHomepageSchemaType(type));
  if (genericTypes.length) {
    alerts.push(`Generic homepage schema detected (${genericTypes.join(", ")}). Homepage should use Organization or LocalBusiness/entity schema instead`);
  }

  if (!meaningfulTypes.some((type) => isHomepageEntitySchemaType(type))) {
    alerts.push(`Missing homepage entity schema. Expected Organization or LocalBusiness/entity schema, found ${meaningfulTypes.join(", ")}`);
  }

  return alerts;
}

function isIgnoredHomepageSchemaType(type: string): boolean {
  return normalizeSchemaType(type) === "breadcrumblist";
}

function isGenericHomepageSchemaType(type: string): boolean {
  return new Set([
    "article",
    "blogposting",
    "newsarticle",
    "webpage",
    "collectionpage",
    "imageobject"
  ]).has(normalizeSchemaType(type));
}

function isHomepageEntitySchemaType(type: string): boolean {
  const normalized = normalizeSchemaType(type);
  if (normalized === "organization" || normalized === "localbusiness") return true;
  return new Set([
    "automotivebusiness",
    "dentist",
    "drycleaningorlaundry",
    "emergencyservice",
    "employmentagency",
    "entertainmentbusiness",
    "financialservice",
    "foodestablishment",
    "governmentoffice",
    "healthandbeautybusiness",
    "homeandconstructionbusiness",
    "legalservice",
    "lodgingbusiness",
    "medicalbusiness",
    "professionalservice",
    "radiostation",
    "realestateagent",
    "recyclingcenter",
    "selfstorage",
    "shoppingcenter",
    "sportsactivitylocation",
    "store",
    "travelagency"
  ]).has(normalized);
}

function normalizeSchemaType(type: string): string {
  return type.toLowerCase().replace(/^https?:\/\/schema\.org\//i, "").replace(/[^a-z0-9]/g, "");
}

function extractJsonLd(html: string): { schemaTypes: string[]; schemaErrors: string[] } {
  const matches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const schemaTypes = new Set<string>();
  const schemaErrors: string[] = [];

  for (const match of matches) {
    try {
      const parsed = JSON.parse(sanitizeJsonLd(decodeHtmlEntities(stripHtmlComments(match[1]?.trim() ?? ""))));
      collectSchemaTypes(parsed, schemaTypes);
    } catch (error) {
      schemaErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    schemaTypes: [...schemaTypes],
    schemaErrors: schemaTypes.size ? [] : schemaErrors
  };
}

function sanitizeJsonLd(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }
    if (inString && /[\r\n\t]/.test(char)) {
      output += " ";
      continue;
    }
    output += char;
  }

  return output;
}

function stripHtmlComments(value: string): string {
  return value.replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function collectSchemaTypes(value: unknown, schemaTypes: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchemaTypes(item, schemaTypes));
    return;
  }

  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];

  if (typeof type === "string") schemaTypes.add(type);
  if (Array.isArray(type)) {
    type.filter((item): item is string => typeof item === "string").forEach((item) => schemaTypes.add(item));
  }

  for (const child of Object.values(record)) {
    if (typeof child === "object") collectSchemaTypes(child, schemaTypes);
  }
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1];
}

function cleanText(value?: string): string | undefined {
  const cleaned = stripTags(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function changed(previous?: string, current?: string): boolean {
  if (!previous || !current) return false;
  return previous.trim() !== current.trim();
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/$/, "");
  }
}

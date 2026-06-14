import type { ClientConfig } from "./clients.js";
import { getTechnicalSnapshot, setTechnicalSnapshot } from "./monitoringStore.js";
import { checkUrl, snapshotFromSiteCheck } from "./siteChecks.js";
import { isIgnoredSchemaUrl } from "./clientMemory.js";

type Candidate = {
  url: string;
  group: string;
  expectedSchemaTypes?: string[];
};

const groupPatterns: Array<{ group: string; patterns: RegExp[]; commonPaths: string[] }> = [
  {
    group: "brand authority",
    patterns: [/\/about/i, /\/contact/i, /\/faq/i],
    commonPaths: ["/about-us/", "/about/", "/contact-us/", "/contact/", "/faq/", "/faqs/"]
  },
  {
    group: "service",
    patterns: [/\/services?\//i, /\/service-/i],
    commonPaths: ["/services/"]
  },
  {
    group: "industry",
    patterns: [/\/industr(?:y|ies)\//i, /\/solutions?\//i],
    commonPaths: ["/industries/", "/solutions/"]
  },
  {
    group: "location",
    patterns: [/\/locations?\//i, /\/areas?\//i],
    commonPaths: ["/locations/", "/areas/"]
  },
  {
    group: "product",
    patterns: [/\/products?\//i, /\/product\//i],
    commonPaths: ["/products/", "/shop/"]
  },
  {
    group: "collection",
    patterns: [/\/collections?\//i, /\/categories?\//i, /\/product-category\//i],
    commonPaths: ["/collections/", "/categories/", "/product-category/"]
  }
];

export async function checkSchemaCoverage(client: ClientConfig): Promise<string[]> {
  const candidates = await discoverSchemaCandidates(client);
  const alerts: string[] = [];

  for (const candidate of candidates) {
    if (isIgnoredSchemaUrl(client.client, candidate.url)) continue;
    const snapshotKey = `${client.client}:schema:${candidate.url}`;
    const result = await checkUrl(candidate.url, getTechnicalSnapshot(snapshotKey), { alertWhenNoSchema: true });

    if (!result.status || result.status >= 400) {
      continue;
    }

    for (const alert of result.alerts) {
      if (isSchemaAlert(alert)) {
        alerts.push(`[Schema] ${client.client}: ${candidate.group} page schema issue - ${alert} - ${candidate.url}`);
      } else if (isRobotsAlert(alert)) {
        alerts.push(`[Technical] ${client.client}: ${candidate.group} page robots change - ${alert} - ${candidate.url}`);
      }
    }

    const missingTypes = missingExpectedSchemaTypes(result.schemaTypes, candidate.expectedSchemaTypes);
    if (missingTypes.length) {
      const found = result.schemaTypes.length ? result.schemaTypes.slice(0, 8).join(", ") : "none";
      alerts.push(`[Schema] ${client.client}: ${candidate.group} page schema issue - expected ${missingTypes.join(", ")} as page schema, found ${found} - ${candidate.url}`);
    }

    if (shouldStoreTechnicalSnapshot(result)) {
      await setTechnicalSnapshot(snapshotKey, snapshotFromSiteCheck(result));
    }
  }

  return alerts;
}

async function discoverSchemaCandidates(client: ClientConfig): Promise<Candidate[]> {
  const homepage = homepageFromClient(client);
  const discovered = await discoverSitemapUrls(homepage);
  const candidates: Candidate[] = [{ url: homepage, group: "homepage" }];

  for (const group of groupPatterns) {
    const limit = group.group === "brand authority" ? 6 : 2;
    const matches = discovered
      .filter((url) => group.patterns.some((pattern) => pattern.test(new URL(url).pathname)))
      .filter((url) => !isParentPage(url))
      .slice(0, limit)
      .map((url) => ({
        url,
        group: group.group,
        expectedSchemaTypes: group.group === "brand authority" ? expectedBrandAuthoritySchemaTypes(url) : undefined
      }));

    if (matches.length) {
      candidates.push(...matches);
    }
  }

  return dedupeCandidates(candidates).slice(0, 13);
}

function expectedBrandAuthoritySchemaTypes(url: string): string[] | undefined {
  const path = new URL(url).pathname.toLowerCase();
  if (/\/about(?:-us)?\/?$/i.test(path)) return ["AboutPage"];
  if (/\/contact(?:-us)?\/?$/i.test(path)) return ["ContactPage"];
  if (/\/faqs?\/?$/i.test(path)) return ["FAQPage"];
  return undefined;
}

function missingExpectedSchemaTypes(foundTypes: string[], expectedTypes?: string[]): string[] {
  if (!expectedTypes?.length) return [];
  const found = new Set(foundTypes.map((type) => type.toLowerCase()));
  return expectedTypes.filter((type) => !found.has(type.toLowerCase()));
}

function isParentPage(value: string): boolean {
  try {
    const path = new URL(value).pathname.replace(/\/+$/, "").toLowerCase();
    return [
      "/products",
      "/product",
      "/collections",
      "/collection",
      "/services",
      "/service",
      "/industries",
      "/industry",
      "/solutions",
      "/locations",
      "/location",
      "/areas",
      "/categories",
      "/product-category",
      "/shop"
    ].includes(path);
  } catch {
    return false;
  }
}

async function discoverSitemapUrls(homepage: string): Promise<string[]> {
  const urls = new Set<string>();
  const sitemapUrls = [new URL("/sitemap.xml", homepage).toString()];

  try {
    const robots = await fetch(new URL("/robots.txt", homepage)).then((response) => response.ok ? response.text() : "");
    for (const line of robots.split(/\r?\n/)) {
      const match = line.match(/^sitemap:\s*(.+)$/i);
      if (match?.[1]) sitemapUrls.push(match[1].trim());
    }
  } catch {
    // Sitemap discovery is best-effort.
  }

  for (const sitemapUrl of [...new Set(sitemapUrls)].slice(0, 5)) {
    await collectSitemapUrls(sitemapUrl, urls, 0);
  }

  return [...urls].filter((url) => sameHost(homepage, url)).slice(0, 500);
}

async function collectSitemapUrls(sitemapUrl: string, urls: Set<string>, depth: number): Promise<void> {
  if (depth > 1) return;

  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) return;

    const xml = await response.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((match) => decodeXml(match[1] ?? ""));

    for (const loc of locs.slice(0, 200)) {
      if (loc.endsWith(".xml")) {
        await collectSitemapUrls(loc, urls, depth + 1);
      } else {
        urls.add(loc);
      }
    }
  } catch {
    // Ignore sitemap failures.
  }
}

function homepageFromClient(client: ClientConfig): string {
  if (client.gscSite?.startsWith("http")) return client.gscSite;
  if (client.gscSite?.startsWith("sc-domain:")) return `https://${client.gscSite.replace("sc-domain:", "")}/`;
  throw new Error(`No schema URL configured for ${client.client}`);
}

function sameHost(homepage: string, url: string): boolean {
  try {
    return new URL(homepage).hostname.replace(/^www\./, "") === new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isSchemaAlert(alert: string): boolean {
  return alert.includes("No JSON-LD schema") || alert.includes("Schema removed") || alert.includes("Schema JSON parse errors");
}

function isRobotsAlert(alert: string): boolean {
  return alert.includes("Meta robots changed") || alert.includes("Page appears to be noindex");
}

function shouldStoreTechnicalSnapshot(result: { status?: number; title?: string; metaDescription?: string; h1?: string; canonical?: string; schemaTypes: string[] }): boolean {
  return Boolean(
    result.status &&
    result.status < 500 &&
    (result.title || result.metaDescription || result.h1 || result.canonical || result.schemaTypes.length)
  );
}

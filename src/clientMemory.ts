import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

type ClientNote = {
  text: string;
  createdAt: string;
  author?: string;
  source?: string;
  sourceText?: string;
};

type ClientMemoryState = {
  notes: Record<string, ClientNote[]>;
  ignoredSchemaUrls: Record<string, string[]>;
  priorityQueries: Record<string, string[]>;
  priorityUrls: Record<string, string[]>;
};

const statePath = join(config.DATA_DIR, "client-memory.json");

let state: ClientMemoryState = {
  notes: {},
  ignoredSchemaUrls: {},
  priorityQueries: {},
  priorityUrls: {}
};

export async function loadClientMemory() {
  await mkdir(config.DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(statePath, "utf8");
    state = {
      ...state,
      ...(JSON.parse(raw) as Partial<ClientMemoryState>)
    };
    state.notes ??= {};
    state.ignoredSchemaUrls ??= {};
    state.priorityQueries ??= {};
    state.priorityUrls ??= {};
    if (normalizeStoredNotes()) await saveClientMemory();
  } catch {
    await saveClientMemory();
  }
}

export async function addClientNote(clientName: string, text: string, author?: string, source?: string, sourceText?: string): Promise<string | undefined> {
  const key = normalizeClient(clientName);
  const cleaned = prepareClientNoteText(text);
  if (!cleaned) return;
  const cleanedSourceText = sourceText ? stripClientLogWrappers(cleanNoteText(sourceText)) : undefined;
  const fingerprint = noteFingerprint(cleaned);
  state.notes[key] = [
    {
      text: cleaned,
      author,
      source,
      sourceText: cleanedSourceText && normalizeLookup(cleanedSourceText) !== normalizeLookup(cleaned) ? cleanedSourceText : undefined,
      createdAt: new Date().toISOString()
    },
    ...(state.notes[key] ?? []).filter((note) => noteFingerprint(note.text) !== fingerprint)
  ].slice(0, 200);
  await saveClientMemory();
  return cleaned;
}

export async function updateClientNote(clientName: string, target: string, text: string, author?: string, source?: string): Promise<string | undefined> {
  const key = normalizeClient(clientName);
  const notes = state.notes[key] ?? [];
  const cleanedTarget = target.trim().toLowerCase();
  const cleaned = prepareClientNoteText(text);
  if (!cleanedTarget || !cleaned || !notes.length) return undefined;

  const index = findNoteIndex(notes, cleanedTarget);
  if (index < 0) return undefined;

  const updated: ClientNote = {
    ...notes[index],
    text: cleaned,
    author: author ?? notes[index]?.author,
    source: source ?? notes[index]?.source,
    createdAt: new Date().toISOString()
  };
  const fingerprint = noteFingerprint(cleaned);
  state.notes[key] = [
    updated,
    ...notes.filter((_, noteIndex) => noteIndex !== index).filter((note) => noteFingerprint(note.text) !== fingerprint)
  ].slice(0, 200);
  await saveClientMemory();
  return cleaned;
}

export async function removeClientNote(clientName: string, target: string): Promise<ClientNote | undefined> {
  const key = normalizeClient(clientName);
  const notes = state.notes[key] ?? [];
  const cleanedTarget = target.trim().toLowerCase();
  if (!cleanedTarget || !notes.length) return undefined;

  const factMatch = findFactRef(notes, cleanedTarget);
  if (factMatch) {
    const note = notes[factMatch.noteIndex];
    const facts = noteTextToBullets(note.text);
    const [removedFact] = facts.splice(factMatch.factIndex, 1);
    if (!removedFact) return undefined;

    if (facts.length) {
      notes[factMatch.noteIndex] = {
        ...note,
        text: facts.join("\n")
      };
    } else {
      notes.splice(factMatch.noteIndex, 1);
    }

    state.notes[key] = notes;
    await saveClientMemory();
    return {
      ...note,
      text: removedFact
    };
  }

  const removeIndex = findNoteIndex(notes, cleanedTarget);

  if (removeIndex < 0 || removeIndex >= notes.length) return undefined;

  const [removed] = notes.splice(removeIndex, 1);
  state.notes[key] = notes;
  await saveClientMemory();
  return removed;
}

export function formatClientNotes(clientName: string): string {
  const notes = dedupeNotesForDisplay(state.notes[normalizeClient(clientName)] ?? []);
  let nextNumber = 1;
  return [
    `*Client memory - ${clientName}*`,
    notes.length
      ? notes.map((note) => {
        const formatted = formatNoteForDisplay(note, nextNumber);
        nextNumber += noteTextToBullets(note.text).length || 1;
        return formatted;
      }).join("\n\n")
      : `No saved notes yet. To add one, reply with: \`add client log: <note>\``
  ].join("\n");
}

export function formatClientKnowledgeForReport(clientName: string): string {
  const notes = dedupeNotesForDisplay(state.notes[normalizeClient(clientName)] ?? []);
  if (!notes.length) return "";

  const bullets = notes
    .flatMap((note) => noteTextToBullets(note.text))
    .filter(Boolean)
    .slice(0, 5);
  if (!bullets.length) return "";

  return [
    "*Client knowledge*",
    ...bullets.map((bullet) => `- ${bullet}`)
  ].join("\n");
}

export function formatClientNotePreview(text: string, createdAt = new Date().toISOString(), startNumber = 1): string {
  const cleaned = prepareClientNoteText(text);
  const bullets = noteTextToBullets(cleaned);
  const header = `*Recorded ${formatNoteDate(createdAt)}*`;
  const body = bullets.length
    ? bullets.map((bullet, index) => `${startNumber + index}. ${bullet}`).join("\n")
    : `${startNumber}. ${cleaned}`;
  return [header, body].join("\n");
}

export async function addPriorityQueries(clientName: string, queries: string[]) {
  const key = normalizeClient(clientName);
  const existing = new Set((state.priorityQueries[key] ?? []).map(normalizeQuery));
  for (const query of queries) {
    const cleaned = normalizeQuery(query);
    if (cleaned) existing.add(cleaned);
  }
  state.priorityQueries[key] = [...existing].slice(0, 500);
  await saveClientMemory();
}

export async function removePriorityQueries(clientName: string, queries: string[]): Promise<string[]> {
  const key = normalizeClient(clientName);
  const targets = new Set(queries.map(normalizeQuery).filter(Boolean));
  if (!targets.size) return [];
  const existing = state.priorityQueries[key] ?? [];
  const removed: string[] = [];
  state.priorityQueries[key] = existing.filter((query) => {
    const normalized = normalizeQuery(query);
    const match = [...targets].some((target) => normalized === target || normalized.includes(target) || target.includes(normalized));
    if (match) removed.push(query);
    return !match;
  });
  await saveClientMemory();
  return removed;
}

export async function replacePriorityQueries(clientName: string, queries: string[]) {
  const key = normalizeClient(clientName);
  state.priorityQueries[key] = [...new Set(queries.map(normalizeQuery).filter(Boolean))].slice(0, 500);
  await saveClientMemory();
}

export async function addPriorityUrls(clientName: string, urls: string[]) {
  const key = normalizeClient(clientName);
  const existing = new Set((state.priorityUrls[key] ?? []).map(normalizeUrl));
  for (const url of urls) {
    const cleaned = normalizeUrl(url);
    if (cleaned) existing.add(cleaned);
  }
  state.priorityUrls[key] = [...existing].slice(0, 500);
  await saveClientMemory();
}

export async function removePriorityUrls(clientName: string, urls: string[]): Promise<string[]> {
  const key = normalizeClient(clientName);
  const targets = new Set(urls.map(normalizeUrl).filter(Boolean));
  if (!targets.size) return [];
  const existing = state.priorityUrls[key] ?? [];
  const removed: string[] = [];
  state.priorityUrls[key] = existing.filter((url) => {
    const normalized = normalizeUrl(url);
    const match = [...targets].some((target) =>
      normalized === target ||
      normalized.startsWith(`${target}/`) ||
      target.startsWith(`${normalized}/`)
    );
    if (match) removed.push(url);
    return !match;
  });
  await saveClientMemory();
  return removed;
}

export async function replacePriorityUrls(clientName: string, urls: string[]) {
  const key = normalizeClient(clientName);
  state.priorityUrls[key] = [...new Set(urls.map(normalizeUrl).filter(Boolean))].slice(0, 500);
  await saveClientMemory();
}

export function formatPriorityQueries(clientName: string): string {
  const queries = state.priorityQueries[normalizeClient(clientName)] ?? [];
  return [
    `*Priority queries - ${clientName}*`,
    ...(queries.length
      ? queries.map((query, index) => `${index + 1}. ${query}`)
      : [`No priority queries saved yet. Send: \`add priority query: query one, query two\``])
  ].join("\n");
}

export function getPriorityQueries(clientName: string): string[] {
  return state.priorityQueries[normalizeClient(clientName)] ?? [];
}

export function formatPriorityUrls(clientName: string): string {
  const urls = state.priorityUrls[normalizeClient(clientName)] ?? [];
  return [
    `*Priority URLs - ${clientName}*`,
    ...(urls.length
      ? urls.map((url, index) => `${index + 1}. ${url}`)
      : [`No priority URLs saved yet. Send: \`add priority url: https://example.com/page/\``])
  ].join("\n");
}

export function getPriorityUrls(clientName: string): string[] {
  return state.priorityUrls[normalizeClient(clientName)] ?? [];
}

export function isPriorityQuery(clientName: string, query: string): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return false;
  return (state.priorityQueries[normalizeClient(clientName)] ?? []).some((saved) =>
    normalized === saved || normalized.includes(saved) || saved.includes(normalized)
  );
}

export function isPriorityUrl(clientName: string, url: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  return (state.priorityUrls[normalizeClient(clientName)] ?? []).some((saved) =>
    normalized === saved || normalized.startsWith(`${saved}/`) || saved.startsWith(`${normalized}/`)
  );
}

export async function ignoreSchemaUrls(clientName: string, urls: string[]) {
  const key = normalizeClient(clientName);
  const existing = new Set((state.ignoredSchemaUrls[key] ?? []).map(normalizeUrl));
  for (const url of urls) existing.add(normalizeUrl(url));
  state.ignoredSchemaUrls[key] = [...existing].filter(Boolean).slice(0, 500);
  await saveClientMemory();
}

export function isIgnoredSchemaUrl(clientName: string, url: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  return (state.ignoredSchemaUrls[normalizeClient(clientName)] ?? []).map(normalizeUrl).some((saved) =>
    normalized === saved ||
    normalized.startsWith(`${saved}/`) ||
    saved.startsWith(`${normalized}/`) ||
    normalized.endsWith(saved.startsWith("/") ? saved : `/${saved}`)
  );
}

function normalizeClient(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "").toLowerCase();
  }
}

function normalizeQuery(value: string): string {
  return value
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanNoteText(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function prepareClientNoteText(text: string): string {
  const cleaned = stripClientLogWrappers(cleanNoteText(text));
  const existingFacts = extractExistingFactLines(cleaned);
  if (existingFacts.length >= 2) return existingFacts.join("\n");
  const facts = extractSmartClientFacts(cleaned);
  if (facts.length >= 2) return facts.join("\n");
  if (facts.length === 1 && shouldUseSingleExtractedFact(cleaned, facts[0])) return facts[0];
  return cleaned;
}

function stripClientLogWrappers(text: string): string {
  return text
    .replace(/^\s*\*?\s*(?:client\s+)?(?:message|response|business|business understanding|action)\s*:?\s*\*?\s*$/gim, "")
    .replace(/\*?\s*(?:client\s+)?(?:message|response|business|business understanding)\s*:\s*\*?/gi, "")
    .replace(/^\s*(?:go to channel|command)\b[\s\S]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSmartClientFacts(text: string): string[] {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return [];

  const facts: string[] = [];
  const website = text.match(/(?:^|\n)\s*Website\s*:\s*(https?:\/\/\S+|[a-z0-9.-]+\.[a-z]{2,}\S*)/i);
  if (website?.[1]) facts.push(`Website: ${cleanUrlish(website[1])}`);

  const mentionedWebsite = compact.match(/\bwe\s+are\s+(https?:\/\/\S+|[a-z0-9.-]+\.[a-z]{2,})(?:\b|[.,])/i);
  if (!website?.[1] && mentionedWebsite?.[1]) facts.push(`Website: ${cleanUrlish(mentionedWebsite[1])}`);

  const status = text.match(/(?:^|\n)\s*Status\s*:\s*([^\n]+)/i);
  if (status?.[1]) facts.push(`Status: ${cleanFactValue(status[1])}`);

  if (/\ball access provided\b/i.test(compact)) facts.push("Access: All access provided");

  if (/\bBig\s*Commerce\b/i.test(compact)) facts.push("Platform: BigCommerce; be careful with website changes");

  const competitors = extractSectionUrls(text, /competitor urls?/i);
  if (competitors.length) facts.push(`Competitors: ${competitors.join(", ")}`);

  const staging = text.match(/(?:^|\n)\s*(?:sandbox|staging)\s*(?:\/\s*staging)?\s*url\s*:\s*(https?:\/\/\S+|[a-z0-9.-]+\.[a-z]{2,}\S*)/i);
  if (staging?.[1]) facts.push(`Staging URL: ${cleanUrlish(staging[1])}`);

  if (/\bnew staging site\b/i.test(compact) && /\b(final and ready|ready)\b/i.test(compact)) {
    facts.push("Staging status: New staging site is development-ready and needs SEO review before launch");
  } else if (/\bnew staging site\b/i.test(compact)) {
    facts.push("Staging status: New staging site exists and needs SEO review");
  }

  const launch = compact.match(/\bpushed\s+(?:that\s+)?(?:website|site)\s+to\s+live\s+on\s+([A-Z][a-z]+\s+\d{4})\b/i);
  if (launch?.[1] && /\branking started to drop\b/i.test(compact) && /\breverted back\b/i.test(compact)) {
    facts.push(`Launch history: Site went live in ${launch[1]} and rankings dropped, so it was reverted`);
  }

  if (/\bApril\b/i.test(compact) && /\bseasonality|seasonal|hike|pick time|peak time\b/i.test(compact)) {
    facts.push("Seasonality: April/May traffic increases may be seasonal; April is a key business period");
  }

  const founded = compact.match(/\b(?:the\s+)?(?:company\s+)?(?:was\s+)?founded\s+in\s+(\d{4})\b/i);
  if (founded?.[1]) facts.push(`Company founded: ${founded[1]}`);

  const websiteLaunch =
    compact.match(/\b(?:current\s+)?website\s+(?:was\s+)?launched\b[^.]*?\b(\d{4})\b/i)
    ?? compact.match(/\bbuilt\s+(?:a\s+)?(?:new\s+)?website\s+in\s+(\d{4})\b/i);
  if (websiteLaunch?.[1]) facts.push(`Current website launched: ${websiteLaunch[1]}`);

  if (/\bB2B platforms?\b/i.test(compact) || /\bindustry networks?\b/i.test(compact) || /\blong-term partnerships?\b/i.test(compact)) {
    const acquisitionParts = [
      /\bB2B platforms?\b/i.test(compact) ? "B2B platforms" : "",
      /\bindustry networks?\b/i.test(compact) ? "industry networks" : "",
      /\blong-term partnerships?\b/i.test(compact) ? "long-term partnerships" : ""
    ].filter(Boolean);
    facts.push(`Historical customer acquisition: ${acquisitionParts.join(", ")}`);
  }

  const focusParts = [
    /\bdirect online presence\b/i.test(compact) ? "Strengthening direct online presence" : "",
    /\bmanufacturing capabilities?\b/i.test(compact) ? "showcasing manufacturing capabilities" : "",
    /\bengineering expertise\b/i.test(compact) ? "engineering expertise" : "",
    /\bquality standards?\b/i.test(compact) ? "quality standards" : "",
    /\bglobal customers?\b/i.test(compact) ? "global customers" : ""
  ].filter(Boolean);
  if (focusParts.length) facts.push(`Recent focus: ${joinReadable(focusParts)}`);

  const years = compact.match(/\b(\d{2,})\+?\s*years\b/i);
  if (years?.[1]) facts.push(`Total manufacturing experience: ${years[1]}+ years`);

  const businessContext = extractBusinessContext(compact);
  if (businessContext) facts.push(`Business context: ${businessContext}`);

  const problem = firstSentenceMatching(text, /\bproblem\s+is\b|\bissue\s+is\b|\bconcern\s+is\b/i);
  if (problem) facts.push(`Client problem: ${problem}`);

  const currentSetup = firstSentenceMatching(text, /\b(?:directed|redirected|linked|menu|dropdown|category level page|sold out|central .* page)\b/i);
  if (currentSetup) facts.push(`Current site setup: ${currentSetup}`);

  const seoConcern = firstSentenceMatching(text, /\bSEO\b|\bsearch engines?\b|\bGoogle\b/i, /\b(?:hurting|impact|affect|problem|concern|rank|traffic|visibility)\b/i);
  if (seoConcern) facts.push(`SEO concern: ${seoConcern}`);

  const productStatus =
    firstSentenceMatching(text, /\b(?:available for sale|taking custom orders|started doing the work|now have available|new ones as they are developed)\b/i)
    ?? firstSentenceMatching(text, /\b(?:new .* line|developed|developing)\b/i);
  if (productStatus) facts.push(`Product status: ${productStatus}`);

  const clientAsk =
    firstSentenceMatching(text, /\b(?:would like to know|want to know|thoughts about|what do you think|what should we do|is this hurting us)\b/i)
    ?? firstSentenceMatching(text, /\bget your input\b/i);
  if (clientAsk) facts.push(`Client ask: ${clientAsk}`);

  const urls = [...compact.matchAll(/https?:\/\/[^\s>)]+|[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s>)]+)?/gi)]
    .map((match) => cleanUrlish(match[0]))
    .filter((url) => !website?.[1] || normalizeUrl(url) !== normalizeUrl(website[1]));
  const relevantUrls = dedupeStrings(urls).slice(0, 6);
  if (relevantUrls.length) facts.push(`Relevant URLs: ${relevantUrls.join(", ")}`);

  return dedupeStrings(facts).slice(0, 12);
}

function shouldUseSingleExtractedFact(text: string, fact: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 360) return true;
  if (extractSentenceList(text).length <= 2) return true;
  return normalizeLookup(compact) === normalizeLookup(fact);
}

function extractBusinessContext(text: string): string | undefined {
  const soldMatch = text.match(/\bfor\s+(?:the\s+)?(?:nearly\s+)?\d{1,3}\+?\s+years?\b[^.?!]*?\b(?:has|have)\s+sold\s+([^.?!]+)/i);
  if (soldMatch?.[1]) return cleanFactValue(`Has sold ${soldMatch[1]}`);

  const sellMatch = text.match(/\b(?:we|they|the company)\s+(?:sell|sells|offer|offers|provide|provides|manufacture|manufactures)\s+([^.?!]+)/i);
  if (sellMatch?.[1]) return cleanFactValue(sellMatch[0]);

  return undefined;
}

function firstSentenceMatching(text: string, required: RegExp, secondary?: RegExp): string | undefined {
  for (const sentence of extractSentenceList(text)) {
    if (required.test(sentence) && (!secondary || secondary.test(sentence))) {
      return cleanSentenceForFact(sentence);
    }
  }
  return undefined;
}

function extractSentenceList(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanSentenceForFact(sentence: string): string {
  return sentence
    .replace(/\s*\(\s*(https?:\/\/[^)]+|[a-z0-9.-]+\.[a-z]{2,}[^)]*)\s*\)/gi, " ($1)")
    .replace(/\s+/g, " ")
    .replace(/[.;,\s]+$/g, "")
    .trim();
}

function extractExistingFactLines(text: string): string[] {
  const allowedLabels = new Set([
    "access",
    "business context",
    "client ask",
    "client problem",
    "company founded",
    "competitors",
    "current website launched",
    "current site setup",
    "historical customer acquisition",
    "launch history",
    "platform",
    "product status",
    "recent focus",
    "relevant urls",
    "seasonality",
    "seo concern",
    "staging status",
    "staging url",
    "status",
    "total manufacturing experience",
    "website"
  ]);
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  const factLines = lines.filter((line) => {
    const match = line.match(/^([^:]{2,60}):\s*(.+)$/);
    return Boolean(match?.[1] && match?.[2] && allowedLabels.has(match[1].toLowerCase().trim()));
  });
  return dedupeStrings(factLines).slice(0, 20);
}

function findNoteIndex(notes: ClientNote[], target: string): number {
  const normalizedTarget = normalizeNoteLookupTarget(target);
  if (/^(?:latest|last|newest|recent|recently added|just added|record just added|this|this record|the record)$/i.test(normalizedTarget)) {
    return 0;
  }

  const numeric = normalizedTarget.match(/^#?(\d+)$/);
  if (numeric) return Number(numeric[1]) - 1;

  const normalizedLookup = normalizeLookup(normalizedTarget);
  return notes.findIndex((note) => {
    const prepared = prepareClientNoteText(note.text);
    const normalized = normalizeLookup(prepared);
    const recordedAt = normalizeLookup(formatNoteDate(note.createdAt));
    return normalized.includes(normalizedLookup)
      || normalizeLookup(note.text).includes(normalizedLookup)
      || recordedAt.includes(normalizedLookup)
      || normalizeLookup(`Recorded ${formatNoteDate(note.createdAt)}`).includes(normalizedLookup);
  });
}

function findFactRef(notes: ClientNote[], target: string): { noteIndex: number; factIndex: number } | undefined {
  const normalizedTarget = normalizeNoteLookupTarget(target);
  const numeric = normalizedTarget.match(/^#?(\d+)$/);
  if (numeric) {
    let remaining = Number(numeric[1]);
    if (!Number.isInteger(remaining) || remaining < 1) return undefined;
    for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
      const facts = noteTextToBullets(notes[noteIndex].text);
      if (remaining <= facts.length) return { noteIndex, factIndex: remaining - 1 };
      remaining -= facts.length;
    }
    return undefined;
  }

  if (/^(?:latest|last|newest|recent|recently added|just added|record just added|this|this record|the record)$/i.test(normalizedTarget)) {
    return undefined;
  }

  const normalizedLookup = normalizeLookup(normalizedTarget.replace(/^["']|["']$/g, ""));
  if (!normalizedLookup) return undefined;

  for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
    const facts = noteTextToBullets(notes[noteIndex].text);
    const factIndex = facts.findIndex((fact) => {
      const normalizedFact = normalizeLookup(fact);
      return normalizedFact === normalizedLookup
        || normalizedFact.includes(normalizedLookup)
        || normalizedLookup.includes(normalizedFact);
    });
    if (factIndex >= 0) return { noteIndex, factIndex };
  }

  return undefined;
}

function normalizeNoteLookupTarget(value: string): string {
  return value
    .replace(/^remove\s+(?:the\s+)?/i, "")
    .replace(/^(?:client\s+)?(?:log|record|note|memory|log item)\s+/i, "")
    .replace(/^recorded\s+/i, "")
    .trim();
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanFactValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[.;,\s]+$/g, "").trim();
}

function cleanUrlish(value: string): string {
  return value.replace(/[>)\].,;]+$/g, "").trim();
}

function extractSectionUrls(text: string, heading: RegExp): string[] {
  const lines = text.split(/\n+/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[*#\s]*[A-Z][A-Za-z /-]{2,}\s*:\s*/.test(line) && !/^https?:\/\//i.test(line.trim())) break;
    section.push(line);
  }
  return [...new Set(section.flatMap((line) =>
    [...line.matchAll(/https?:\/\/[^\s>)]+|[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s>)]+)?/gi)].map((match) => cleanUrlish(match[0]))
  ))].slice(0, 8);
}

function joinReadable(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatNoteForDisplay(note: ClientNote, startNumber: number): string {
  return formatClientNotePreview(note.text, note.createdAt, startNumber);
}

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Katmandu"
  }).format(date);
}

function noteTextToBullets(text: string): string[] {
  const cleaned = prepareClientNoteText(text);
  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length > 1) return lines.slice(0, 20);

  const single = lines[0] ?? "";
  if (!single) return [];

  const labelMatches = [...single.matchAll(/(?:^|[.;]\s+)([A-Z][A-Za-z0-9 /&+-]{2,40})\s*:\s*([^.;]+(?:[.;]|$))/g)]
    .map((match) => `${match[1].trim()}: ${match[2].replace(/[.;]\s*$/, "").trim()}`)
    .filter(Boolean);
  if (labelMatches.length >= 2) return labelMatches.slice(0, 20);

  const semicolonParts = single
    .split(/\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (semicolonParts.length >= 2) return semicolonParts.slice(0, 20);

  const sentences = single
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length > 1 ? sentences.slice(0, 20) : [single];
}

function noteFingerprint(text: string): string {
  return noteTextToBullets(text)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeNotesForDisplay(notes: ClientNote[]): ClientNote[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const fingerprint = noteFingerprint(note.text);
    if (!fingerprint || seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function normalizeStoredNotes(): boolean {
  let changed = false;
  for (const [key, notes] of Object.entries(state.notes)) {
    const normalized: ClientNote[] = [];
    const seen = new Set<string>();
    for (const note of notes) {
      const text = prepareClientNoteText(note.text);
      const fingerprint = noteFingerprint(text);
      if (!text || !fingerprint || seen.has(fingerprint)) {
        changed = true;
        continue;
      }
      seen.add(fingerprint);
      const next = { ...note, text };
      if (next.text !== note.text) changed = true;
      normalized.push(next);
    }
    state.notes[key] = normalized.slice(0, 200);
  }
  return changed;
}

async function saveClientMemory() {
  await mkdir(config.DATA_DIR, { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

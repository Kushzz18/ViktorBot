import { google } from "googleapis";
import { askAssistant } from "./ai.js";
import { getGoogleAuthClient } from "./googleAuth.js";

export type DriveSearchResult = {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
  parents?: string[] | null;
  textPreview?: string;
  matchSource?: "name" | "content";
};

export type DriveSearchOptions = {
  clientName?: string;
  googleProfile?: string;
};

export async function searchDriveKnowledge(query: string, limit = 8, options: DriveSearchOptions = {}): Promise<DriveSearchResult[]> {
  const auth = await getGoogleAuthClient(options.googleProfile);
  const drive = google.drive({ version: "v3", auth });

  const files: DriveSearchResult[] = [];
  const seen = new Set<string>();
  const terms = searchTerms(query);
  const clientTerms = options.clientName ? searchTerms(options.clientName, 2) : [];
  const clientAliases = buildClientAliases(options.clientName);
  const queryMatchedIds = new Set<string>();
  const nameMatchedIds = new Set<string>();
  const clientMatchedIds = new Set<string>();

  for (const driveQuery of buildFolderQueries(query)) {
    const folderResponse = await drive.files.list({
      pageSize: 10,
      q: driveQuery,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc"
    });

    for (const folder of folderResponse.data.files ?? []) {
      if (!folder.id) continue;
      const childResponse = await drive.files.list({
        pageSize: Math.max(limit * 4, 20),
        q: `trashed = false and '${escapeDriveQuery(folder.id)}' in parents`,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc"
      });
      const children = childResponse.data.files ?? [];
      const folderHasClientMatch = locallyMatchesClient(folder, clientTerms, clientAliases);

      for (const file of children) {
        if (!file.id) continue;
        queryMatchedIds.add(file.id);
        if (fileNameMatchesTerms(file, terms)) nameMatchedIds.add(file.id);
        if (folderHasClientMatch || locallyMatchesClient(file, clientTerms, clientAliases)) {
          clientMatchedIds.add(file.id);
        }
        if (seen.has(file.id)) continue;
        seen.add(file.id);
        files.push(file);
      }
    }
  }

  for (const driveQuery of buildClientSpecificNameQueries(query, options.clientName)) {
    const response = await drive.files.list({
      pageSize: Math.max(limit * 8, 40),
      q: driveQuery,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc"
    });

    for (const file of response.data.files ?? []) {
      if (!file.id) continue;
      queryMatchedIds.add(file.id);
      nameMatchedIds.add(file.id);
      clientMatchedIds.add(file.id);
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      files.push(file);
    }
  }

  for (const driveQuery of buildDriveQueries(query, "name")) {
    const response = await drive.files.list({
      pageSize: Math.max(limit * 4, 20),
      q: driveQuery,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc"
    });

    for (const file of response.data.files ?? []) {
      if (!file.id) continue;
      queryMatchedIds.add(file.id);
      nameMatchedIds.add(file.id);
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      files.push(file);
    }
  }

  if (clientTerms.length) {
    for (const driveQuery of buildClientMatchQueries(options.clientName ?? "")) {
      const response = await drive.files.list({
        pageSize: Math.max(limit * 8, 40),
        q: driveQuery,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc"
      });

      for (const file of response.data.files ?? []) {
        if (!file.id) continue;
        clientMatchedIds.add(file.id);
        if (seen.has(file.id)) continue;
        seen.add(file.id);
        files.push(file);
      }
    }
  }

  if (files.length < limit) {
    for (const driveQuery of buildDriveQueries(query, "content")) {
      const response = await drive.files.list({
        pageSize: Math.max(limit * 4, 20),
        q: driveQuery,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc"
      });

      for (const file of response.data.files ?? []) {
        if (!file.id) continue;
        queryMatchedIds.add(file.id);
        if (seen.has(file.id)) continue;
        seen.add(file.id);
        files.push(file);
      }
    }
  }

  const enriched = await Promise.all(
    files.map(async (file) => {
      const nameMatched = Boolean(file.id && nameMatchedIds.has(file.id));
      const directClientMatched = locallyMatchesClient(file, clientTerms, clientAliases);
      const localClientMatched = Boolean(file.id && clientMatchedIds.has(file.id)) || directClientMatched;
      const clientMatched = Boolean(file.id && clientMatchedIds.has(file.id)) || localClientMatched;
      return {
        ...file,
        matchSource: nameMatched ? "name" as const : "content" as const,
        clientMatched,
        directClientMatched,
        localClientMatched,
        score: scoreDriveResult(file, terms, nameMatched, clientMatched, clientTerms)
      };
    })
  );
  const sorted = enriched
    .filter((file) => queryMatchedIds.has(file.id ?? ""))
    .filter((file) => !clientTerms.length || file.clientMatched)
    .filter((file) => file.score >= (file.matchSource === "name" ? 240 : 90))
    .sort((a, b) => b.score - a.score);
  const structuredNameMatches = structuredAssetNameMatches(sorted, query);
  const scopedStructuredNameMatches = clientTerms.length
    ? structuredNameMatches.filter((file) => file.directClientMatched)
    : structuredNameMatches;
  if (isStructuredAssetQuery(query) && scopedStructuredNameMatches.length) {
    return scopedStructuredNameMatches
      .slice(0, limit)
      .map(({ score: _score, clientMatched: _clientMatched, directClientMatched: _directClientMatched, localClientMatched: _localClientMatched, ...file }) => file);
  }
  if (isStructuredAssetQuery(query) && !structuredNameMatches.length) {
    return [];
  }
  const localClientMatches = clientTerms.length ? sorted.filter((file) => file.localClientMatched) : [];
  const clientScoped = localClientMatches.length ? localClientMatches : sorted;
  const selected = clientScoped;
  return selected
    .slice(0, limit)
    .map(({ score: _score, clientMatched: _clientMatched, directClientMatched: _directClientMatched, localClientMatched: _localClientMatched, ...file }) => file);
}

function buildFolderQueries(query: string): string[] {
  const terms = searchTerms(query).slice(0, 6).map(escapeDriveQuery);
  if (!terms.length) return [];
  return [
    `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${terms.map((term) => `name contains '${term}'`).join(" and ")})`,
    `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${terms.map((term) => `name contains '${term}'`).join(" or ")})`
  ];
}

function buildClientSpecificNameQueries(query: string, clientName?: string): string[] {
  if (!clientName) return [];
  const queryTerms = searchTerms(query).slice(0, 6).map(escapeDriveQuery);
  const clientGroups = clientTermGroups(clientName).map((group) => group.map(escapeDriveQuery));
  if (!queryTerms.length || !clientGroups.length) return [];
  return clientGroups.map((group) =>
    `trashed = false and (${[...queryTerms, ...group].map((term) => `name contains '${term}'`).join(" and ")})`
  );
}

function buildDriveQueries(query: string, mode: "name" | "content"): string[] {
  const exact = escapeDriveQuery(query.trim());
  const terms = searchTerms(query).slice(0, 6).map(escapeDriveQuery);
  const compact = escapeDriveQuery(query.replace(/[^a-z0-9]+/gi, ""));

  const nameQueries = [
    compact.length >= 5 ? `trashed = false and name contains '${compact}'` : undefined,
    terms.length >= 2
      ? `trashed = false and (${terms.map((term) => `name contains '${term}'`).join(" and ")})`
      : undefined,
    terms.length
      ? `trashed = false and (${terms.map((term) => `name contains '${term}'`).join(" or ")})`
      : undefined
  ];
  const contentQueries = [
    exact ? `trashed = false and fullText contains '${exact}'` : undefined,
    terms.length
      ? `trashed = false and (${terms.map((term) => `fullText contains '${term}'`).join(" or ")})`
      : undefined
  ];
  const queries = mode === "name" ? nameQueries : contentQueries;

  return queries.filter((value): value is string => Boolean(value));
}

function buildClientMatchQueries(clientName: string): string[] {
  const exact = escapeDriveQuery(clientName.trim());
  const terms = searchTerms(clientName, 2).slice(0, 6).map(escapeDriveQuery);
  const compact = escapeDriveQuery(clientName.replace(/[^a-z0-9]+/gi, ""));
  return [
    compact.length >= 5 ? `trashed = false and name contains '${compact}'` : undefined,
    terms.length
      ? `trashed = false and (${terms.map((term) => `name contains '${term}'`).join(" and ")})`
      : undefined,
    exact ? `trashed = false and fullText contains '${exact}'` : undefined,
    terms.length
      ? `trashed = false and (${terms.map((term) => `fullText contains '${term}'`).join(" and ")})`
      : undefined
  ].filter((value): value is string => Boolean(value));
}

function clientTermGroups(clientName: string): string[][] {
  const terms = searchTerms(clientName, 2);
  const groups: string[][] = [];
  if (terms.length) groups.push(terms);
  const meaningfulTerms = terms.filter((term) => term.length > 2);
  if (meaningfulTerms.length) groups.push(meaningfulTerms);
  if (terms.length >= 2) groups.push([terms[0] ?? "", terms[terms.length - 1] ?? ""].filter(Boolean));
  const singular = terms.map((term) => singularize(term));
  if (singular.length) groups.push(singular);
  return dedupeTermGroups(groups);
}

function dedupeTermGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  return groups.filter((group) => {
    const clean = group.filter(Boolean);
    if (!clean.length) return false;
    const key = clean.join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchTerms(query: string, minLength = 3): string[] {
  const expanded = query
    .replace(/\bdomain\s*wide\b/gi, "domainwide domain wide")
    .replace(/\bsite\s*wide\b/gi, "sitewide site wide");
  return expanded
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= minLength && !["the", "and", "for", "with", "from", "this", "that", "client", "drive", "file", "docs", "doc", "document", "documents", "fetch", "find", "search"].includes(term));
}

function buildClientAliases(clientName?: string): string[] {
  if (!clientName) return [];
  const terms = searchTerms(clientName, 2);
  const aliases = new Set<string>();
  aliases.add(terms.join(" "));
  aliases.add(terms.join(""));
  if (terms[0] && terms[0].length >= 4) aliases.add(terms[0]);
  if (terms.length >= 2) {
    aliases.add(`${terms[0]} ${terms[terms.length - 1]}`);
    aliases.add(`${terms[0]}${terms[terms.length - 1]}`);
  }
  aliases.add(terms.map((term) => singularize(term)).join(" "));
  aliases.add(terms.map((term) => singularize(term)).join(""));
  return [...aliases].filter((alias) => alias.length >= 4);
}

function locallyMatchesClient(file: DriveSearchResult, clientTerms: string[], clientAliases: string[]): boolean {
  if (!clientTerms.length) return true;
  const name = `${file.name ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const compactName = name.replace(/\s+/g, "");
  if (clientAliases.some((alias) => name.includes(alias) || compactName.includes(alias.replace(/\s+/g, "")))) return true;
  const compactClient = clientTerms.join("");
  if (compactClient.length >= 4 && compactName.includes(compactClient)) return true;
  const meaningfulTerms = clientTerms.filter((term) => term.length > 2);
  return meaningfulTerms.length
    ? meaningfulTerms.every((term) => termMatchesName(term, name, compactName))
    : clientTerms.every((term) => termMatchesName(term, name, compactName));
}

function fileNameMatchesTerms(file: DriveSearchResult, terms: string[]): boolean {
  if (!terms.length) return false;
  const name = `${file.name ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const compactName = name.replace(/\s+/g, "");
  return terms.some((term) => name.includes(term) || compactName.includes(term));
}

function scoreDriveResult(file: DriveSearchResult, terms: string[], nameMatched: boolean, clientMatched: boolean, clientTerms: string[]): number {
  const name = `${file.name ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const compactName = name.replace(/\s+/g, "");
  let score = 0;
  if (nameMatched) score += 200;
  if (clientMatched) score += 160;

  for (const term of terms) {
    if (name.includes(term)) score += 20;
    else if (compactName.includes(term)) score += 15;
  }
  for (const term of clientTerms) {
    if (name.includes(term)) score += 40;
    else if (compactName.includes(term)) score += 30;
  }

  if (terms.length && terms.every((term) => name.includes(term) || compactName.includes(term))) score += 80;
  if (terms.length >= 2 && name.includes(terms.join(" "))) score += 180;
  if (terms.length >= 2 && compactName.includes(terms.join(""))) score += 140;
  if (!terms.includes("category") && /\bcategory\b/.test(name)) score -= 120;
  if (/crawl/.test(name) && /budget/.test(name)) score += 50;
  if (file.mimeType === "application/vnd.google-apps.document") score += 10;
  if (file.mimeType === "application/vnd.google-apps.folder") score += 5;
  return score;
}

function isStructuredAssetQuery(query: string): boolean {
  return /\b(topical\s+map|eav|domain\s*wide|domainwide|attribute\s+mapping|content\s+brief|seo\s+brief)\b/i.test(query);
}

function structuredAssetNameMatches<T extends DriveSearchResult>(files: T[], query: string): T[] {
  return files.filter((file) => matchesStructuredAssetName(file.name ?? "", query));
}

function matchesStructuredAssetName(nameValue: string, query: string): boolean {
  const name = nameValue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const compactName = name.replace(/\s+/g, "");
  const lowerQuery = query.toLowerCase();
  if (/\beav\b/i.test(lowerQuery) && !/\beav\b/i.test(name)) return false;
  if (/\btopical\s+map\b/i.test(lowerQuery) && !/\btopical\s+map\b/i.test(name)) return false;
  if (/\bdomain\s*wide\b|\bdomainwide\b/i.test(lowerQuery) && !(/\bdomain\s+wide\b/i.test(name) || compactName.includes("domainwide"))) return false;
  if (/\battribute\s+mapping\b/i.test(lowerQuery) && !/\battribute\s+mapping\b/i.test(name)) return false;
  if (/\bcontent\s+brief\b/i.test(lowerQuery) && !/\bcontent\s+brief\b/i.test(name)) return false;
  if (/\bseo\s+brief\b/i.test(lowerQuery) && !/\bseo\s+brief\b/i.test(name)) return false;
  return true;
}

function termMatchesName(term: string, name: string, compactName: string): boolean {
  const singular = singularize(term);
  return name.includes(term) || compactName.includes(term) || name.includes(singular) || compactName.includes(singular);
}

function singularize(value: string): string {
  return value.length > 3 ? value.replace(/s$/i, "") : value;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function formatDriveKnowledgeSearch(query: string, options: DriveSearchOptions = {}): Promise<string> {
  const results = await searchDriveKnowledge(query, 5, options);

  if (!results.length) {
    const suffix = options.clientName ? ` for ${options.clientName}` : "";
    return `I could not find Drive files matching "${query}"${suffix}.`;
  }

  const lines = results.map((file, index) => {
    const name = file.name ?? "Untitled file";
    const link = file.webViewLink ? `<${file.webViewLink}|${name}>` : name;
    return `${index + 1}. ${link}`;
  });

  return [`Drive files matching "${query}":`, ...lines].join("\n");
}

export async function formatDriveFolderSearch(query: string, options: DriveSearchOptions = {}): Promise<string> {
  const limit = options.clientName ? 1 : 5;
  const results = await searchDriveFolders(query, limit, options);

  if (!results.length) {
    const suffix = options.clientName ? ` for ${options.clientName}` : "";
    return `I could not find Drive folders matching "${query}"${suffix}.`;
  }

  if (options.clientName && results[0]) {
    const folder = results[0];
    const name = folder.name ?? "Untitled folder";
    const link = folder.webViewLink ? `<${folder.webViewLink}|${name}>` : name;
    return [`Drive folder matching "${query}" for ${options.clientName}:`, `- ${link}`].join("\n");
  }

  const lines = results.map((folder, index) => {
    const name = folder.name ?? "Untitled folder";
    const link = folder.webViewLink ? `<${folder.webViewLink}|${name}>` : name;
    return `${index + 1}. ${link}`;
  });

  return [`Drive folders matching "${query}":`, ...lines].join("\n");
}

async function searchDriveFolders(query: string, limit = 8, options: DriveSearchOptions = {}): Promise<DriveSearchResult[]> {
  const auth = await getGoogleAuthClient(options.googleProfile);
  const drive = google.drive({ version: "v3", auth });
  const terms = searchTerms(stripClientTermsFromQuery(query, options.clientName));
  const clientTerms = options.clientName ? searchTerms(options.clientName, 2) : [];
  const clientAliases = buildClientAliases(options.clientName);
  const seen = new Set<string>();
  const folders: Array<DriveSearchResult & { score: number; clientMatched: boolean; assetTermMatches: number }> = [];
  const minAssetMatches = Math.min(3, Math.max(1, terms.length));

  for (const driveQuery of buildFolderSearchQueries(query, options.clientName)) {
    const response = await drive.files.list({
      pageSize: Math.max(limit * 8, 40),
      q: driveQuery,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
      orderBy: "modifiedTime desc"
    });

    for (const folder of response.data.files ?? []) {
      if (!folder.id || seen.has(folder.id)) continue;
      seen.add(folder.id);
      const clientMatched = locallyMatchesClient(folder, clientTerms, clientAliases);
      const assetTermMatches = countNameTermMatches(folder, terms);
      folders.push({
        ...folder,
        matchSource: "name",
        clientMatched,
        assetTermMatches,
        score: scoreDriveFolderResult(folder, terms, assetTermMatches, clientMatched, clientTerms)
      });
    }
  }

  if (clientTerms.length) {
    const candidateParentIds = [...new Set(folders
      .filter((folder) => folder.assetTermMatches >= minAssetMatches)
      .flatMap((folder) => folder.parents ?? []))]
      .slice(0, 12);
    const siblingMatchedParents = await findClientSiblingParentIds(drive, candidateParentIds, clientTerms, clientAliases);
    for (const folder of folders) {
      if ((folder.parents ?? []).some((parentId) => siblingMatchedParents.has(parentId))) {
        folder.clientMatched = true;
        folder.score += 260;
      }
    }
  }

  return folders
    .filter((folder) => !clientTerms.length || folder.clientMatched || folder.assetTermMatches >= minAssetMatches)
    .filter((folder) => folder.score >= 120)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, clientMatched: _clientMatched, assetTermMatches: _assetTermMatches, ...folder }) => folder);
}

function buildFolderSearchQueries(query: string, clientName?: string): string[] {
  const terms = searchTerms(stripClientTermsFromQuery(query, clientName)).slice(0, 6).map(escapeDriveQuery);
  const clientGroups = clientName ? clientTermGroups(clientName).map((group) => group.map(escapeDriveQuery)) : [];
  const queries = [
    terms.length >= 2
      ? `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${terms.map((term) => `name contains '${term}'`).join(" and ")})`
      : undefined,
    terms.length
      ? `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${terms.map((term) => `name contains '${term}'`).join(" or ")})`
      : undefined,
    ...clientGroups.map((group) =>
      terms.length
        ? `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${[...terms, ...group].map((term) => `name contains '${term}'`).join(" and ")})`
        : `trashed = false and mimeType = 'application/vnd.google-apps.folder' and (${group.map((term) => `name contains '${term}'`).join(" and ")})`
    )
  ];
  return queries.filter((value): value is string => Boolean(value));
}

function stripClientTermsFromQuery(query: string, clientName?: string): string {
  if (!clientName) return query;
  const clientTerms = searchTerms(clientName, 2);
  const clientAliases = buildClientAliases(clientName);
  const removable = new Set([
    ...clientTerms,
    ...clientAliases,
    clientTerms.join(""),
    clientTerms.join(" ")
  ].map((term) => term.toLowerCase().replace(/[^a-z0-9]+/g, "")));
  return query
    .split(/\s+/)
    .filter((term) => !removable.has(term.toLowerCase().replace(/[^a-z0-9]+/g, "")))
    .join(" ");
}

function countNameTermMatches(file: DriveSearchResult, terms: string[]): number {
  const name = `${file.name ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const compactName = name.replace(/\s+/g, "");
  return terms.filter((term) => termMatchesName(term, name, compactName)).length;
}

function scoreDriveFolderResult(
  folder: DriveSearchResult,
  terms: string[],
  assetTermMatches: number,
  clientMatched: boolean,
  clientTerms: string[]
): number {
  let score = scoreDriveResult(folder, terms, fileNameMatchesTerms(folder, terms), clientMatched, clientTerms);
  score += assetTermMatches * 110;
  if (terms.length && assetTermMatches === terms.length) score += 300;
  if (terms.length >= 3 && assetTermMatches <= 1) score -= 260;
  if (terms.length >= 4 && assetTermMatches < 3) score -= 200;
  return score;
}

async function findClientSiblingParentIds(
  drive: ReturnType<typeof google.drive>,
  parentIds: string[],
  clientTerms: string[],
  clientAliases: string[]
): Promise<Set<string>> {
  const matched = new Set<string>();
  for (const parentId of parentIds.slice(0, 12)) {
    try {
      const response = await drive.files.list({
        pageSize: 30,
        q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${escapeDriveQuery(parentId)}' in parents`,
        fields: "files(id,name,mimeType)"
      });
      if ((response.data.files ?? []).some((file) => locallyMatchesClient(file, clientTerms, clientAliases))) {
        matched.add(parentId);
      }
    } catch {
      // Best effort: Drive may hide sibling metadata for shared folders.
    }
  }
  return matched;
}

export async function readDriveFileText(file: DriveSearchResult, options: DriveSearchOptions = {}): Promise<{ text?: string; error?: string }> {
  if (!file.id || !file.mimeType) return { error: "That Drive result does not have a readable file id." };
  return readDriveFileTextById(file.id, file.mimeType, options);
}

export async function readDriveFileTextById(fileId: string, mimeType: string, options: DriveSearchOptions = {}): Promise<{ text?: string; error?: string }> {
  if (!fileId) return { error: "Missing file id." };

  try {
    const auth = await getGoogleAuthClient(options.googleProfile);
    const drive = google.drive({ version: "v3", auth });

    if (mimeType === "application/vnd.google-apps.document") {
      const response = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      return { text: normalizeDocumentText(response.data) };
    }

    if (mimeType === "application/vnd.google-apps.spreadsheet") {
      const response = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
      return { text: normalizeDocumentText(response.data) };
    }

    if (mimeType === "application/vnd.google-apps.presentation") {
      const response = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      return { text: normalizeDocumentText(response.data) };
    }

    if (mimeType === "application/pdf") {
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: response.data as ArrayBuffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return { text: normalizeDocumentText(parsed.text) };
    }

    if (/^text\/|json|csv|xml|html/i.test(mimeType)) {
      const response = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
      return { text: normalizeDocumentText(response.data) };
    }

    return { error: "I found the file, but this file type is not readable yet." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function summarizeDriveKnowledgeFile(query: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options);
  if (!selected) return notFoundMessage(query, options);
  return summarizeDriveFile(selected, options);
}

export async function summarizeDriveKnowledgeUrl(url: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await getDriveFileFromUrl(url, options).catch(() => undefined);
  if (!selected) {
    const remote = await readRemoteUrlText(url);
    if (!remote.text) return `I could not read that URL: ${remote.error ?? "no text returned"}`;
    return summarizeRemoteFile(url, remote.text);
  }
  return summarizeDriveFile(selected, options);
}

export async function answerDriveKnowledgeUrlQuestion(url: string, question: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await getDriveFileFromUrl(url, options).catch(() => undefined);
  if (!selected) {
    const remote = await readRemoteUrlText(url);
    if (!remote.text) return `I could not read that URL: ${remote.error ?? "no text returned"}`;
    const answer = await askAssistant(
      `remote-url-qa:${url.slice(0, 160)}`,
      question,
      [
        "Answer only from this URL content. If the answer is not in the content, say that clearly.",
        `URL: ${url}`,
        `Text:\n${remote.text.slice(0, 14000)}`
      ].join("\n\n")
    );
    return [`*From <${url}|this file>*`, answer].join("\n");
  }
  const read = await readDriveFileText(selected, options);
  if (!read.text) return `I found ${formatDriveLink(selected)}, but I could not read it: ${read.error ?? "no text returned"}`;

  const answer = await askAssistant(
    `drive-qa:${selected.id}`,
    question,
    [
      "Answer only from this file. If the answer is not in the file, say that clearly.",
      `File: ${selected.name ?? "Untitled file"}`,
      `Link: ${selected.webViewLink ?? "not available"}`,
      `Text:\n${read.text.slice(0, 14000)}`
    ].join("\n\n")
  );

  return [`*From ${formatDriveLink(selected)}*`, answer].join("\n");
}

async function summarizeDriveFile(selected: DriveSearchResult, options: DriveSearchOptions = {}): Promise<string> {
  const read = await readDriveFileText(selected, options);
  if (!read.text) return `I found ${formatDriveLink(selected)}, but I could not read it: ${read.error ?? "no text returned"}`;

  const summary = await askAssistant(
    `drive-summary:${selected.id}`,
    "Summarize this file for an SEO operations team. Keep it concise, practical, and mention important action items or client knowledge.",
    [
      `File: ${selected.name ?? "Untitled file"}`,
      `Link: ${selected.webViewLink ?? "not available"}`,
      `Text:\n${read.text.slice(0, 12000)}`
    ].join("\n\n")
  );

  return [`*Summary - ${formatDriveLink(selected)}*`, summary].join("\n");
}

async function getDriveFileFromUrl(url: string, options: DriveSearchOptions = {}): Promise<DriveSearchResult | undefined> {
  const fileId = extractDriveFileId(url);
  if (!fileId) return undefined;

  const auth = await getGoogleAuthClient(options.googleProfile);
  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,modifiedTime,webViewLink"
  });

  return response.data;
}

function extractDriveFileId(url: string): string | undefined {
  const decoded = safeDecode(url);
  return decoded.match(/\/(?:d|folders)\/([a-zA-Z0-9_-]+)/)?.[1] ??
    decoded.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1];
}

async function summarizeRemoteFile(url: string, text: string): Promise<string> {
  const summary = await askAssistant(
    `remote-url-summary:${url.slice(0, 160)}`,
    "Summarize this file for an SEO operations team. Keep it concise, practical, and mention important action items or client knowledge.",
    [
      `URL: ${url}`,
      `Text:\n${text.slice(0, 12000)}`
    ].join("\n\n")
  );

  return [`*Summary - <${url}|this file>*`, summary].join("\n");
}

async function readRemoteUrlText(url: string): Promise<{ text?: string; error?: string }> {
  try {
    const exportUrl = publicGoogleExportUrl(url);
    const targetUrl = exportUrl ?? url;
    const response = await fetch(targetUrl);
    if (!response.ok) return { error: `HTTP ${response.status}` };

    const contentType = response.headers.get("content-type") ?? "";
    if (/application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(targetUrl)) {
      const buffer = await response.arrayBuffer();
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      await parser.destroy();
      return { text: normalizeDocumentText(parsed.text) };
    }

    const text = await response.text();
    return { text: normalizeDocumentText(stripHtmlForRemoteText(text, contentType)) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function publicGoogleExportUrl(url: string): string | undefined {
  const decoded = safeDecode(url);
  const id = extractDriveFileId(decoded);
  if (!id) return undefined;

  if (/docs\.google\.com\/document\//i.test(decoded)) {
    return `https://docs.google.com/document/d/${id}/export?format=txt`;
  }
  if (/docs\.google\.com\/spreadsheets\//i.test(decoded)) {
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  }
  if (/docs\.google\.com\/presentation\//i.test(decoded)) {
    return `https://docs.google.com/presentation/d/${id}/export/txt`;
  }

  return undefined;
}

function stripHtmlForRemoteText(text: string, contentType: string): string {
  if (!/html/i.test(contentType) && !/<html[\s>]/i.test(text)) return text;
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function answerDriveKnowledgeQuestion(query: string, question: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options);
  if (!selected) return notFoundMessage(query, options);
  const read = await readDriveFileText(selected, options);
  if (!read.text) return `I found ${formatDriveLink(selected)}, but I could not read it: ${read.error ?? "no text returned"}`;

  const answer = await askAssistant(
    `drive-qa:${selected.id}`,
    question,
    [
      "Answer only from this file. If the answer is not in the file, say that clearly.",
      `File: ${selected.name ?? "Untitled file"}`,
      `Link: ${selected.webViewLink ?? "not available"}`,
      `Text:\n${read.text.slice(0, 14000)}`
    ].join("\n\n")
  );

  return [`*From ${formatDriveLink(selected)}*`, answer].join("\n");
}

export async function appendToGoogleDocument(query: string, content: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options, (file) => file.mimeType === "application/vnd.google-apps.document");
  if (!selected?.id) return `I could not find a Google Doc matching "${query}"${options.clientName ? ` for ${options.clientName}` : ""}.`;

  const auth = await getGoogleAuthClient(options.googleProfile);
  const docs = google.docs({ version: "v1", auth });
  const doc = await docs.documents.get({ documentId: selected.id, fields: "body(content(endIndex))" });
  const endIndex = Math.max(1, ...((doc.data.body?.content ?? []).map((item) => item.endIndex ?? 1))) - 1;
  await docs.documents.batchUpdate({
    documentId: selected.id,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: endIndex },
          text: `\n${content.trim()}\n`
        }
      }]
    }
  });

  return `Appended to ${formatDriveLink(selected)}.`;
}

export async function replaceInGoogleDocument(query: string, target: string, replacement: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options, (file) => file.mimeType === "application/vnd.google-apps.document");
  if (!selected?.id) return `I could not find a Google Doc matching "${query}"${options.clientName ? ` for ${options.clientName}` : ""}.`;

  const read = await readDriveFileText(selected, options);
  if (!read.text) return `I found ${formatDriveLink(selected)}, but I could not read it: ${read.error ?? "no text returned"}`;

  if (!read.text.includes(target)) return `I found ${formatDriveLink(selected)}, but I could not find the text to update.`;

  const auth = await getGoogleAuthClient(options.googleProfile);
  const docs = google.docs({ version: "v1", auth });
  await docs.documents.batchUpdate({
    documentId: selected.id,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: {
              text: target,
              matchCase: true
            },
            replaceText: replacement
          }
        }
      ]
    }
  });

  return `Updated ${formatDriveLink(selected)}.`;
}

export async function appendToGoogleSheet(query: string, values: string[], options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options, (file) => file.mimeType === "application/vnd.google-apps.spreadsheet");
  if (!selected?.id) return `I could not find a Google Sheet matching "${query}"${options.clientName ? ` for ${options.clientName}` : ""}.`;

  const auth = await getGoogleAuthClient(options.googleProfile);
  const sheets = google.sheets({ version: "v4", auth });
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: selected.id, fields: "sheets.properties.title" });
  const sheetName = metadata.data.sheets?.[0]?.properties?.title ?? "Sheet1";
  await sheets.spreadsheets.values.append({
    spreadsheetId: selected.id,
    range: `'${sheetName.replace(/'/g, "''")}'!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });

  return `Appended one row to ${formatDriveLink(selected)} -> ${sheetName}.`;
}

export async function updateGoogleSheetCell(query: string, cell: string, value: string, options: DriveSearchOptions = {}): Promise<string> {
  const selected = await findBestDriveFile(query, options, (file) => file.mimeType === "application/vnd.google-apps.spreadsheet");
  if (!selected?.id) return `I could not find a Google Sheet matching "${query}"${options.clientName ? ` for ${options.clientName}` : ""}.`;
  const cleanedCell = cell.trim().toUpperCase();
  if (!/^[A-Z]+[1-9][0-9]*$/.test(cleanedCell)) return "Tell me the exact cell to update, like B12.";

  const auth = await getGoogleAuthClient(options.googleProfile);
  const sheets = google.sheets({ version: "v4", auth });
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: selected.id, fields: "sheets.properties.title" });
  const sheetName = metadata.data.sheets?.[0]?.properties?.title ?? "Sheet1";
  await sheets.spreadsheets.values.update({
    spreadsheetId: selected.id,
    range: `'${sheetName.replace(/'/g, "''")}'!${cleanedCell}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] }
  });

  return `Updated ${formatDriveLink(selected)} -> ${sheetName}!${cleanedCell}.`;
}

async function findBestDriveFile(
  query: string,
  options: DriveSearchOptions,
  predicate?: (file: DriveSearchResult) => boolean
): Promise<DriveSearchResult | undefined> {
  const results = await searchDriveKnowledge(query, 8, options);
  return predicate ? results.find(predicate) : results[0];
}

function notFoundMessage(query: string, options: DriveSearchOptions): string {
  const suffix = options.clientName ? ` for ${options.clientName}` : "";
  return `I could not find a readable Drive file matching "${query}"${suffix}.`;
}

function formatDriveLink(file: DriveSearchResult): string {
  const name = file.name ?? "Untitled file";
  return file.webViewLink ? `<${file.webViewLink}|${name}>` : name;
}

function normalizeDocumentText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

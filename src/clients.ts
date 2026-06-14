import { readFile, writeFile } from "node:fs/promises";
import { google } from "googleapis";
import { config } from "./config.js";
import { discoverGoogleAccess } from "./googleDiscovery.js";
import { getGoogleAuthClient } from "./googleAuth.js";
import { formatSheetSyncStatus, loadSheetClientOverlays, normalizeKey } from "./sheetSync.js";
import { getClientChannel, getTeamMembers } from "./adminSettings.js";

export type ClientConfig = {
  client: string;
  slackChannel: string;
  gscSite: string | null;
  ga4PropertyId: string | null;
  mainCountry: string;
  googleProfile?: string;
  clickupListName: string;
  team?: string;
  techOwner?: string;
  devOwner?: string;
  responsiblePeople?: string[];
  teamMemberNames?: string[];
  dashboardUrl?: string;
  dashboardStatus?: Array<{
    metric: string;
    value: string;
    signal: "positive" | "negative";
  }>;
  ownerSlackUserIds?: string[];
  teamSlackUserIds?: string[];
  moneyPages?: Array<{
    url: string;
    expectedSchemaTypes?: string[];
  }>;
};

export async function loadClients(): Promise<ClientConfig[]> {
  const clients = await loadEditableClients();
  return enrichClientsFromSheets(clients);
}

export async function loadEditableClients(): Promise<ClientConfig[]> {
  try {
    const raw = await readFile(config.CLIENTS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Array<Partial<ClientConfig>>;
    return parsed.map(normalizeClientConfig).filter((client) => client.client);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function upsertClient(input: Partial<ClientConfig>, originalClient?: string): Promise<ClientConfig[]> {
  const nextClient = normalizeClientConfig(input);
  if (!nextClient.client) throw new Error("Client name is required.");

  const clients = await loadEditableClients();
  const targetKey = normalize(originalClient || nextClient.client);
  const index = clients.findIndex((client) => normalize(client.client) === targetKey);

  if (index >= 0) clients[index] = nextClient;
  else clients.push(nextClient);

  await saveEditableClients(clients);
  return clients;
}

export async function removeClient(clientName: string): Promise<boolean> {
  const targetKey = normalize(clientName);
  if (!targetKey) return false;

  const clients = await loadEditableClients();
  const nextClients = clients.filter((client) => normalize(client.client) !== targetKey);
  if (nextClients.length === clients.length) return false;

  await saveEditableClients(nextClients);
  return true;
}

export async function updateClientMainCountry(clientName: string, mainCountry: string): Promise<ClientConfig | undefined> {
  const targetKey = normalize(clientName);
  const country = cleanText(mainCountry) || "global";
  if (!targetKey) return undefined;

  const clients = await loadEditableClients();
  const index = clients.findIndex((client) => normalize(client.client) === targetKey);
  if (index < 0) return undefined;

  clients[index] = normalizeClientConfig({
    ...clients[index],
    mainCountry: country
  });
  await saveEditableClients(clients);
  return clients[index];
}

export async function updateClientGoogleProfile(clientName: string, googleProfile: string): Promise<ClientConfig | undefined> {
  const targetKey = normalize(clientName);
  const profile = cleanOptional(googleProfile);
  if (!targetKey) return undefined;

  const clients = await loadEditableClients();
  const index = clients.findIndex((client) => normalize(client.client) === targetKey);
  if (index < 0) return undefined;

  clients[index] = normalizeClientConfig({
    ...clients[index],
    googleProfile: profile
  });
  await saveEditableClients(clients);
  return clients[index];
}

export async function inferClientFromText(text: string): Promise<ClientConfig | undefined> {
  const clients = await loadClients();
  const normalized = normalize(text);

  return bestClientMatch(clients, normalized);
}

export async function inferClientFromChannelName(channelName: string): Promise<ClientConfig | undefined> {
  const clients = await loadClients();
  const normalized = normalize(channelName);
  return bestClientMatch(clients, normalized);
}

export async function findClientByName(name: string): Promise<ClientConfig | undefined> {
  const clients = await loadClients();
  const normalized = normalize(name);
  return bestClientMatch(clients, normalized);
}

function bestClientMatch(clients: ClientConfig[], normalized: string): ClientConfig | undefined {
  const scored = clients
    .map((client) => ({ client, score: matchScore(client, normalized) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.client;
}

function matchScore(client: ClientConfig, normalized: string): number {
  let score = 0;

  for (const name of clientAliases(client)) {
    const alias = normalize(name).replace(/\bseo\b/g, "").trim();
    if (alias.length <= 2) continue;
    if (normalized === alias) score += 100;
    else if (normalized.includes(alias) || alias.includes(normalized)) score += 60;
    else if (tokenOverlap(alias, normalized)) score += 25;
  }

  if (/\b(ie|ireland)\b/.test(normalized) && /\b(ie|ireland)\b/.test(normalize(`${client.client} ${client.gscSite ?? ""}`))) {
    score += 50;
  }

  if (/\b(ie|ireland)\b/.test(normalized) && /(\.ie\/?$|ireland)/i.test(`${client.gscSite ?? ""} ${client.client}`)) {
    score += 100;
  }

  if (/\b(uk|co uk|united kingdom)\b/.test(normalized) && /\b(uk|co uk|united kingdom)\b/.test(normalize(`${client.client} ${client.gscSite ?? ""}`))) {
    score += 50;
  }

  if (/\b(uk|united kingdom)\b/.test(normalized) && /(\.co\.uk\/?$|uk|united kingdom)/i.test(`${client.gscSite ?? ""} ${client.client}`)) {
    score += 100;
  }

  return score;
}

export function clientAliases(client: ClientConfig): string[] {
  return [
    client.client,
    client.clickupListName,
    ...domainAliases(client.gscSite)
  ].filter((value): value is string => Boolean(value));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenOverlap(alias: string, normalized: string): boolean {
  const aliasTokens = alias.split(/\s+/).filter((token) => token.length > 2 && !["seo", "www", "com", "co"].includes(token));
  const channelTokens = normalized.split(/\s+/).filter((token) => token.length > 2 && !["seo", "www", "com", "co"].includes(token));
  if (!aliasTokens.length || !channelTokens.length) return false;

  return aliasTokens.some((aliasToken) =>
    channelTokens.some((channelToken) => aliasToken.includes(channelToken) || channelToken.includes(aliasToken))
  );
}

function domainAliases(value: string | null): string[] {
  if (!value) return [];
  const domain = value
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const base = domain.split(".")[0] ?? domain;
  return [domain, base, domain.replace(/\./g, " ")];
}

async function saveEditableClients(clients: ClientConfig[]): Promise<void> {
  const cleanClients = clients.map(stripRuntimeClientFields);
  await writeFile(config.CLIENTS_CONFIG_PATH, `${JSON.stringify(cleanClients, null, 2)}\n`, "utf8");
}

function normalizeClientConfig(input: Partial<ClientConfig>): ClientConfig {
  const client = cleanText(input.client);
  return {
    client,
    slackChannel: cleanSlackChannel(input.slackChannel),
    gscSite: cleanNullable(input.gscSite),
    ga4PropertyId: cleanNullable(input.ga4PropertyId),
    mainCountry: cleanText(input.mainCountry) || "global",
    googleProfile: cleanOptional(input.googleProfile),
    clickupListName: cleanText(input.clickupListName) || client,
    team: cleanOptional(input.team),
    techOwner: cleanOptional(input.techOwner),
    devOwner: cleanOptional(input.devOwner),
    responsiblePeople: cleanStringArray(input.responsiblePeople),
    teamMemberNames: cleanStringArray(input.teamMemberNames),
    dashboardUrl: cleanOptional(input.dashboardUrl),
    dashboardStatus: Array.isArray(input.dashboardStatus) ? input.dashboardStatus : undefined,
    ownerSlackUserIds: cleanStringArray(input.ownerSlackUserIds),
    teamSlackUserIds: cleanStringArray(input.teamSlackUserIds),
    moneyPages: Array.isArray(input.moneyPages) ? input.moneyPages : undefined
  };
}

function stripRuntimeClientFields(client: ClientConfig): ClientConfig {
  const clean = normalizeClientConfig(client);
  const result: ClientConfig = {
    client: clean.client,
    slackChannel: clean.slackChannel,
    gscSite: clean.gscSite,
    ga4PropertyId: clean.ga4PropertyId,
    mainCountry: clean.mainCountry,
    googleProfile: clean.googleProfile,
    clickupListName: clean.clickupListName
  };

  if (clean.team) result.team = clean.team;
  if (clean.techOwner) result.techOwner = clean.techOwner;
  if (clean.devOwner) result.devOwner = clean.devOwner;
  if (clean.responsiblePeople?.length) result.responsiblePeople = clean.responsiblePeople;
  if (clean.teamMemberNames?.length) result.teamMemberNames = clean.teamMemberNames;
  if (clean.dashboardUrl) result.dashboardUrl = clean.dashboardUrl;
  if (clean.ownerSlackUserIds?.length) result.ownerSlackUserIds = clean.ownerSlackUserIds;
  if (clean.teamSlackUserIds?.length) result.teamSlackUserIds = clean.teamSlackUserIds;
  if (clean.moneyPages?.length) result.moneyPages = clean.moneyPages;

  return result;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNullable(value: unknown): string | null {
  const text = cleanText(value);
  return text || null;
}

function cleanOptional(value: unknown): string | undefined {
  return cleanText(value) || undefined;
}

function cleanSlackChannel(value: unknown): string {
  return cleanText(value).replace(/^#/, "");
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value.map(cleanText).filter(Boolean);
  return clean.length ? clean : undefined;
}

export async function formatClientMappings(): Promise<string> {
  const clients = await loadClients();
  const accessByProfile = await discoverAccessByProfile(clients);

  const gaReachability = await Promise.all(
    clients.map(async (client) => {
      const access = accessByProfile.get(client.googleProfile || "default");
      const gaProperties = new Set(
        Array.isArray(access?.gaProperties) ? access.gaProperties.map((property) => property.propertyId) : []
      );
      if (!client.ga4PropertyId) return false;
      if (gaProperties.has(client.ga4PropertyId)) return true;
      return canReadGaProperty(client.ga4PropertyId, client.googleProfile);
    })
  );

  const lines = clients.map((client, index) => {
    const access = accessByProfile.get(client.googleProfile || "default");
    const gscSites = new Set(Array.isArray(access?.gscSites) ? access.gscSites.map((site) => site.siteUrl) : []);
    const gsc = client.gscSite && gscSites.has(client.gscSite) ? "GSC ok" : "GSC check";
    const ga = client.ga4PropertyId && gaReachability[index] ? "GA ok" : "GA missing";
    const country = client.mainCountry || "country missing";
    const profile = client.googleProfile ? `, Google: ${client.googleProfile}` : "";
    const team = client.team ? `, ${client.team}` : "";
    const teamLead = getTeamLeadLabel(client.team);
    const lead = teamLead ? `, Team lead: ${teamLead}` : "";
    return `${index + 1}. ${client.client} - ${gsc}, ${ga}, ${country}${profile}${team}${lead}`;
  });

  return [`Client monitoring mappings (${clients.length}):`, ...lines].join("\n");
}

async function discoverAccessByProfile(clients: ClientConfig[]) {
  const profileNames = [...new Set(clients.map((client) => client.googleProfile || "default"))];
  const entries = await Promise.all(
    profileNames.map(async (profileName) => {
      try {
        return [profileName, await discoverGoogleAccess(profileName)] as const;
      } catch (error) {
        return [
          profileName,
          {
            driveFiles: { error: error instanceof Error ? error.message : String(error) },
            gscSites: { error: error instanceof Error ? error.message : String(error) },
            gaProperties: { error: error instanceof Error ? error.message : String(error) }
          }
        ] as const;
      }
    })
  );
  return new Map(entries);
}

function getTeamLeadLabel(team?: string): string | undefined {
  const normalized = team?.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.includes("team a")) return "Teammate AB 1";
  if (normalized.includes("team b")) return "Teammate AB 2";
  if (normalized.includes("team c")) return "Teammate CD 1";
  if (normalized.includes("team d")) return "Teammate CD 2";
  return undefined;
}

export async function formatLiveSheetMappings(): Promise<string> {
  return formatSheetSyncStatus(await loadClients());
}

async function enrichClientsFromSheets(clients: ClientConfig[]): Promise<ClientConfig[]> {
  const overlays = await loadSheetClientOverlays();
  if (!overlays.length) return clients.map(applyAdminOverrides);

  return clients.map((client) => {
    const clientKey = normalizeKey(client.client);
    const exactOverlay = overlays.find((item) => normalizeKey(item.client) === clientKey);
    const aliasOverlay = overlays.find((item) =>
      clientAliases(client).some((alias) => normalizeKey(alias) === normalizeKey(item.client))
    );
    const overlay = exactOverlay ?? aliasOverlay;

    if (!overlay) return applyAdminOverrides(client);

    return applyAdminOverrides({
      ...client,
      team: client.team ?? overlay.team,
      techOwner: overlay.techOwner ?? client.techOwner,
      devOwner: overlay.devOwner ?? client.devOwner,
      responsiblePeople: overlay.responsiblePeople?.length ? overlay.responsiblePeople : client.responsiblePeople,
      teamMemberNames: overlay.teamMemberNames?.length ? overlay.teamMemberNames : client.teamMemberNames,
      dashboardUrl: overlay.dashboardUrl ?? client.dashboardUrl,
      dashboardStatus: overlay.dashboardStatus?.length ? overlay.dashboardStatus : client.dashboardStatus
    });
  });
}

function applyAdminOverrides(client: ClientConfig): ClientConfig {
  return {
    ...client,
    slackChannel: getClientChannel(client.client) ?? client.slackChannel,
    teamMemberNames: client.team ? getTeamMembers(client.team, client.teamMemberNames) : client.teamMemberNames
  };
}

async function canReadGaProperty(propertyId: string, googleProfile?: string): Promise<boolean> {
  try {
    const auth = await getGoogleAuthClient(googleProfile);
    const analyticsData = google.analyticsdata({ version: "v1beta", auth });
    await analyticsData.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
        metrics: [{ name: "activeUsers" }],
        limit: "1"
      }
    });
    return true;
  } catch {
    return false;
  }
}

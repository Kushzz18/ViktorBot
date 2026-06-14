import { google } from "googleapis";
import { config } from "./config.js";
import { getGoogleAuthClient } from "./googleAuth.js";
import type { ClientConfig } from "./clients.js";

export type SheetClientOverlay = {
  client: string;
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
};

type CachedOverlays = {
  loadedAt: number;
  overlays: SheetClientOverlay[];
};

let cache: CachedOverlays | undefined;

export async function loadSheetClientOverlays(): Promise<SheetClientOverlay[]> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < config.SHEET_SYNC_CACHE_MINUTES * 60 * 1000) {
    return cache.overlays;
  }

  try {
    const overlays = await fetchSheetClientOverlays();
    cache = { loadedAt: now, overlays };
    return overlays;
  } catch {
    return cache?.overlays ?? [];
  }
}

export async function formatSheetSyncStatus(clients: ClientConfig[]): Promise<string> {
  const overlays = await loadSheetClientOverlays();
  const overlayMap = new Map(overlays.map((overlay) => [normalizeKey(overlay.client), overlay]));
  const matched = clients.filter((client) => overlayMap.has(normalizeKey(client.client)));
  const lines = matched.slice(0, 20).map((client) => {
    const overlay = overlayMap.get(normalizeKey(client.client));
    const team = overlay?.team ?? "team missing";
    const teamLead = getTeamLeadLabel(team);
    return `${client.client} - ${team}${teamLead ? ` | Team lead: ${teamLead}` : ""}`;
  });

  return [
    `Sheets sync: ${matched.length}/${clients.length} configured clients matched.`,
    `Team/status rows available from Sheets: ${overlays.length}.`,
    ...lines
  ].join("\n");
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

async function fetchSheetClientOverlays(): Promise<SheetClientOverlay[]> {
  const auth = await getGoogleAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const [projectMaster, responsiblePeople, teamRosters, dashboard] = await Promise.all([
    readValues(sheets, config.TEAM_TRACKER_SHEET_ID, "'📁 Project Master'!A1:Z300"),
    readValues(sheets, config.TEAM_TRACKER_SHEET_ID, "'Log Responsible Person'!A1:Z300"),
    readTeamRosters(sheets),
    readDashboardStatuses(sheets)
  ]);

  const overlays = new Map<string, SheetClientOverlay>();

  for (const overlay of parseProjectMaster(projectMaster)) {
    mergeOverlay(overlays, overlay);
  }

  for (const overlay of parseResponsiblePeople(responsiblePeople)) {
    mergeOverlay(overlays, overlay);
  }

  for (const overlay of dashboard) {
    mergeOverlay(overlays, overlay);
  }

  for (const overlay of overlays.values()) {
    const team = normalizeTeam(overlay.team);
    if (team && teamRosters.has(team)) {
      overlay.team = team;
      overlay.teamMemberNames = teamRosters.get(team);
    }
  }

  return Array.from(overlays.values());
}

async function readValues(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (response.data.values ?? []) as string[][];
}

async function readTeamRosters(sheets: ReturnType<typeof google.sheets>): Promise<Map<string, string[]>> {
  const ranges = [
    { team: "Team A", range: "'🔷 Team A'!A1:E80" },
    { team: "Team B", range: "'🟩 Team B'!A1:E80" },
    { team: "Team C", range: "'🟣 Team C'!A1:E80" },
    { team: "Team D", range: "'🩵 Team D'!A1:E80" }
  ];
  const rosters = new Map<string, string[]>();

  await Promise.all(ranges.map(async ({ team, range }) => {
    const rows = await readValues(sheets, config.TEAM_TRACKER_SHEET_ID, range);
    const names = rows
      .map((row) => row[1]?.trim())
      .filter((name): name is string => Boolean(name) && !/^member$/i.test(name) && !/team .* members/i.test(name) && !/^jyoti$/i.test(name));
    const normalizedTeam = normalizeTeam(team);
    if (!normalizedTeam) return;
    rosters.set(normalizedTeam, unique([...(rosters.get(normalizedTeam) ?? []), ...names]));
  }));

  return rosters;
}

function parseProjectMaster(rows: string[][]): SheetClientOverlay[] {
  const overlays: SheetClientOverlay[] = [];
  let currentTeam = "";

  for (const row of rows.slice(2)) {
    const project = row[0]?.trim();
    const team = row[1]?.trim();
    if (!project) continue;

    const teamHeader = project.match(/\bTeam\s+[A-D]\b/i)?.[0];
    if (teamHeader && !team) {
      currentTeam = normalizeTeam(teamHeader) ?? currentTeam;
      continue;
    }

    const rowTeam = normalizeTeam(team || currentTeam);
    if (!rowTeam || /^team\s+[a-d]\s+/i.test(project)) continue;

    overlays.push({
      client: normalizeClientName(project),
      team: rowTeam,
      techOwner: cleanOwner(row[5]),
      devOwner: cleanOwner(row[6])
    });
  }

  return overlays;
}

function parseResponsiblePeople(rows: string[][]): SheetClientOverlay[] {
  const overlays: SheetClientOverlay[] = [];

  for (const row of rows.slice(1)) {
    const person = row[0]?.trim();
    const client = row[1]?.trim();
    if (!person || !client) continue;
    overlays.push({
      client: normalizeClientName(client),
      responsiblePeople: [person]
    });
  }

  return overlays;
}

async function readDashboardStatuses(sheets: ReturnType<typeof google.sheets>): Promise<SheetClientOverlay[]> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.CLIENT_STATUS_SHEET_ID,
    ranges: ["Dashboard!A1:Z250"],
    includeGridData: true
  });
  const rows = response.data.sheets?.[0]?.data?.[0]?.rowData ?? [];
  const headers = rows[0]?.values?.map((cell) => cell.formattedValue ?? "") ?? [];
  const overlays: SheetClientOverlay[] = [];

  for (const row of rows.slice(1)) {
    const cells = row.values ?? [];
    const url = cells[0]?.formattedValue?.trim();
    const client = cells[1]?.formattedValue?.trim();
    const team = cells[2]?.formattedValue?.trim();
    if (!client) continue;

    const dashboardStatus = cells
      .map((cell, index) => {
        const signal = classifyCellSignal(cell.effectiveFormat?.backgroundColorStyle?.rgbColor ?? cell.effectiveFormat?.backgroundColor);
        const metric = headers[index]?.trim();
        const value = cell.formattedValue?.trim();
        return signal && metric && value ? { metric, value, signal } : undefined;
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    overlays.push({
      client: normalizeClientName(client),
      team: normalizeTeam(team),
      dashboardUrl: url,
      dashboardStatus
    });
  }

  return overlays;
}

function mergeOverlay(map: Map<string, SheetClientOverlay>, overlay: SheetClientOverlay) {
  const key = normalizeKey(overlay.client);
  if (!key) return;

  const existing = map.get(key) ?? { client: overlay.client };
  map.set(key, {
    ...existing,
    ...overlay,
    responsiblePeople: unique([...(existing.responsiblePeople ?? []), ...(overlay.responsiblePeople ?? [])]),
    teamMemberNames: unique([...(existing.teamMemberNames ?? []), ...(overlay.teamMemberNames ?? [])]),
    dashboardStatus: overlay.dashboardStatus?.length ? overlay.dashboardStatus : existing.dashboardStatus
  });
}

function classifyCellSignal(color: { red?: number | null; green?: number | null; blue?: number | null } | null | undefined) {
  if (!color) return undefined;
  const red = color.red ?? 0;
  const green = color.green ?? 0;
  const blue = color.blue ?? 0;
  if (red > 0.85 && green < 0.75 && blue < 0.75) return "negative" as const;
  if (green > red && green > blue && red < 0.85) return "positive" as const;
  return undefined;
}

function cleanOwner(value: string | undefined): string | undefined {
  return value?.replace(/\([^)]*\)/g, "").trim() || undefined;
}

function normalizeTeam(value: string | undefined): string | undefined {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
  if (/^team ab$|^ab$/.test(normalized)) return "Team AB";
  if (/^team cd$|^cd$/.test(normalized)) return "Team CD";
  const match = normalized.match(/\bteam\s+([a-d])\b/) ?? normalized.match(/^([a-d])$/);
  if (!match?.[1]) return undefined;
  return ["a", "b"].includes(match[1]) ? "Team AB" : "Team CD";
}

function normalizeClientName(value: string): string {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/g, "")
    .replace(/\.(com|co|net|org|com\.au|co\.uk|ie)$/i, "")
    .replace(/\s+SEO$/i, "")
    .trim();
}

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

import http from "node:http";
import { config } from "./config.js";
import { loadClients, loadEditableClients, removeClient, upsertClient } from "./clients.js";
import { memoryStats } from "./memory.js";
import { getMonitoringState } from "./monitoringStore.js";
import {
  addAllowedUser,
  addTeamMember,
  approveLearningSuggestion,
  getAdminSettings,
  getFollowupMinAgeMinutes,
  getReportChannel,
  rejectLearningSuggestion,
  removeAllowedUser,
  rememberPreference,
  removeClientChannel,
  removeLearnedRule,
  removePreference,
  removeTeamMember,
  removeThreshold,
  setAccessMode,
  setClientChannel,
  setFollowupMinAgeMinutes,
  setReportChannel,
  setTeamMembers,
  setThreshold
} from "./adminSettings.js";
import { loadSheetClientOverlays, normalizeKey } from "./sheetSync.js";
import { listScheduledWorkflows } from "./scheduledWorkflows.js";

type JsonRecord = Record<string, unknown>;

type DashboardActions = {
  runWorkflow?: (id: string) => Promise<string>;
};

export async function startAdminDashboard(actions: DashboardActions = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowed(req)) {
        sendText(res, 403, "Forbidden");
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, dashboardHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const [clients, editableClients, sheetClients] = await Promise.all([
          loadClients(),
          loadEditableClients(),
          loadSheetClientOverlays()
        ]);
        sendJson(res, {
          settings: getAdminSettings(),
          effective: {
            reportChannel: getReportChannel(),
            followupMinAgeMinutes: getFollowupMinAgeMinutes(),
            monitoringSchedule: {
              checkIntervalMinutes: config.MONITORING_CHECK_INTERVAL_MINUTES,
              dailyHour: config.MONITORING_DAILY_HOUR,
              weeklyDay: config.MONITORING_WEEKLY_DAY,
              weeklyHour: config.MONITORING_WEEKLY_HOUR,
              weeklyFallbackDay: config.MONITORING_WEEKLY_FALLBACK_DAY,
              weeklyFallbackHour: config.MONITORING_WEEKLY_FALLBACK_HOUR,
              monthlyDay: config.MONITORING_MONTHLY_DAY,
              monthlyHour: config.MONITORING_MONTHLY_HOUR
            }
          },
          clients,
          editableClients,
          sheetClients,
          workflows: listScheduledWorkflows(),
          monitoringState: getMonitoringState(),
          memory: memoryStats()
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/import-sheet-clients") {
        const body = await readJson(req);
        const imported = await importSheetClients(optionalString(body.client));
        sendJson(res, { ok: true, imported });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client") {
        const body = await readJson(req);
        const clients = await upsertClient({
          client: String(body.client ?? ""),
          slackChannel: String(body.slackChannel ?? ""),
          gscSite: nullableString(body.gscSite),
          ga4PropertyId: nullableString(body.ga4PropertyId),
          mainCountry: String(body.mainCountry ?? "global"),
          googleProfile: optionalString(body.googleProfile),
          clickupListName: String(body.clickupListName ?? ""),
          team: optionalString(body.team),
          techOwner: optionalString(body.techOwner),
          devOwner: optionalString(body.devOwner),
          dashboardUrl: optionalString(body.dashboardUrl)
        }, optionalString(body.originalClient));
        sendJson(res, { ok: true, clients });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/client") {
        const body = await readJson(req);
        sendJson(res, { ok: await removeClient(String(body.client ?? "")) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/report-channel") {
        const body = await readJson(req);
        await setReportChannel(String(body.channel ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/followup") {
        const body = await readJson(req);
        await setFollowupMinAgeMinutes(Number(body.minutes));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/access-mode") {
        const body = await readJson(req);
        const mode = String(body.mode ?? "");
        if (mode !== "open" && mode !== "restricted") throw new Error("Access mode must be open or restricted.");
        await setAccessMode(mode);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/access-user") {
        const body = await readJson(req);
        await addAllowedUser(String(body.userId ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/access-user") {
        const body = await readJson(req);
        await removeAllowedUser(String(body.userId ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/client-channel") {
        const body = await readJson(req);
        await setClientChannel(String(body.client ?? ""), String(body.channel ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/client-channel") {
        const body = await readJson(req);
        sendJson(res, { ok: await removeClientChannel(String(body.client ?? "")) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/team-members") {
        const body = await readJson(req);
        await setTeamMembers(String(body.team ?? ""), parseMembers(body.members));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/team-member") {
        const body = await readJson(req);
        await addTeamMember(String(body.team ?? ""), String(body.member ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/team-member") {
        const body = await readJson(req);
        sendJson(res, { ok: await removeTeamMember(String(body.team ?? ""), String(body.member ?? "")) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/threshold") {
        const body = await readJson(req);
        await setThreshold(
          String(body.key ?? ""),
          body.pct === "" || body.pct === undefined ? undefined : Number(body.pct),
          body.absolute === "" || body.absolute === undefined ? undefined : Number(body.absolute)
        );
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/threshold") {
        const body = await readJson(req);
        sendJson(res, { ok: await removeThreshold(String(body.key ?? "")) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/preference") {
        const body = await readJson(req);
        await rememberPreference(String(body.text ?? ""));
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/preference") {
        const body = await readJson(req);
        sendJson(res, { ok: Boolean(await removePreference(String(body.text ?? ""))) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/learned/remove") {
        const body = await readJson(req);
        sendJson(res, { ok: Boolean(await removeLearnedRule(String(body.query ?? ""))) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/learning/approve") {
        const body = await readJson(req);
        sendJson(res, { ok: Boolean(await approveLearningSuggestion(String(body.id ?? ""))) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/learning/reject") {
        const body = await readJson(req);
        sendJson(res, { ok: Boolean(await rejectLearningSuggestion(String(body.id ?? ""))) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/workflow/send") {
        const body = await readJson(req);
        if (!actions.runWorkflow) throw new Error("Workflow sender is not available.");
        const message = await actions.runWorkflow(String(body.id ?? ""));
        sendJson(res, { ok: true, message });
        return;
      }

      sendText(res, 404, "Not found");
    } catch (error) {
      sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(config.ADMIN_DASHBOARD_PORT, "127.0.0.1", resolve);
  });
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function nullableString(value: unknown): string | null {
  return optionalString(value) ?? null;
}

function parseMembers(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function importSheetClients(targetClient?: string): Promise<number> {
  const [existingClients, sheetClients] = await Promise.all([loadEditableClients(), loadSheetClientOverlays()]);
  const existingKeys = new Set(existingClients.map((client) => normalizeKey(client.client)));
  const targetKey = targetClient ? normalizeKey(targetClient) : "";
  let imported = 0;

  for (const sheetClient of sheetClients) {
    const key = normalizeKey(sheetClient.client);
    if (!key || existingKeys.has(key)) continue;
    if (targetKey && key !== targetKey) continue;

    await upsertClient({
      client: sheetClient.client,
      slackChannel: "",
      gscSite: null,
      ga4PropertyId: null,
      mainCountry: "global",
      clickupListName: `${sheetClient.client} SEO`,
      team: sheetClient.team,
      techOwner: sheetClient.techOwner,
      devOwner: sheetClient.devOwner,
      responsiblePeople: sheetClient.responsiblePeople,
      teamMemberNames: sheetClient.teamMemberNames,
      dashboardUrl: sheetClient.dashboardUrl
    });
    existingKeys.add(key);
    imported += 1;
  }

  return imported;
}

function isAllowed(req: http.IncomingMessage): boolean {
  if (!config.ADMIN_DASHBOARD_TOKEN) return true;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return url.searchParams.get("token") === config.ADMIN_DASHBOARD_TOKEN ||
    req.headers.authorization === `Bearer ${config.ADMIN_DASHBOARD_TOKEN}`;
}

function readJson(req: http.IncomingMessage): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) as JsonRecord : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendText(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Viktor Admin</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #eef3f8;
      color: #17202a;
      --ink: #12202f;
      --blue: #2563eb;
      --green: #0f766e;
      --line: #d9e3ee;
      --soft: #f7fafc;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .shell { min-height: 100vh; display: grid; grid-template-columns: 268px 1fr; }
    aside {
      background: linear-gradient(180deg, #0f1a27 0%, #142537 58%, #0f1a27 100%);
      color: #d9e2ec;
      padding: 24px 20px;
      border-right: 1px solid rgba(255,255,255,.08);
    }
    .brand { font-size: 23px; font-weight: 800; color: #fff; margin-bottom: 6px; letter-spacing: 0; }
    .subtitle { color: #b7c5d6; font-size: 13px; line-height: 1.5; margin-bottom: 26px; }
    nav { display: grid; gap: 8px; }
    nav a { color: #d9e2ec; text-decoration: none; padding: 11px 13px; border-radius: 8px; font-size: 14px; border: 1px solid transparent; }
    nav a:hover, nav a.active { background: rgba(255,255,255,.1); color: #fff; border-color: rgba(255,255,255,.1); }
    main { min-width: 0; }
    header { position: sticky; top: 0; z-index: 3; background: rgba(255,255,255,.9); backdrop-filter: blur(10px); border-bottom: 1px solid #dce3ea; padding: 16px 26px; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    h2 { margin: 0; font-size: 17px; letter-spacing: 0; }
    h3 { margin: 0 0 10px; font-size: 14px; color: #344054; }
    .content { padding: 24px 26px 48px; display: grid; gap: 18px; }
    .hero { display: grid; grid-template-columns: 1.35fr .65fr; gap: 16px; align-items: stretch; }
    .panel { background: rgba(255,255,255,.96); border: 1px solid var(--line); border-radius: 10px; padding: 18px; min-width: 0; box-shadow: 0 10px 28px rgba(15, 23, 42, .05); }
    .overview-panel {
      background:
        linear-gradient(135deg, rgba(37,99,235,.13), rgba(15,118,110,.1)),
        #fff;
    }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; margin-top: 16px; }
    .stat { border: 1px solid #e5eaf0; border-radius: 9px; padding: 13px; background: #fbfcfd; min-height: 76px; }
    .stat span { display: block; color: #667085; font-size: 12px; margin-bottom: 5px; }
    .stat strong { display: block; font-size: 22px; color: #111827; }
    .readiness { display: grid; gap: 10px; margin-top: 12px; }
    .meter { height: 8px; background: #e8edf2; border-radius: 999px; overflow: hidden; }
    .meter > div { height: 100%; background: #1f6feb; width: 0%; }
    .muted { color: #667085; }
    .small { font-size: 12px; }
    .grid { display: grid; grid-template-columns: minmax(0,1fr) 380px; gap: 16px; align-items: start; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 14px 0; }
    .toolbar input { max-width: 460px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 9px 10px;
      font: inherit;
      background: #fff;
      color: #17202a;
    }
    label { display: block; font-size: 12px; color: #5f6b7a; margin-bottom: 5px; }
    button {
      border: 1px solid var(--blue);
      background: var(--blue);
      color: #fff;
      border-radius: 8px;
      padding: 9px 12px;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    button.secondary { background: #fff; color: var(--blue); }
    button.danger { background: #b42318; border-color: #b42318; }
    button.ghost { background: #fff; color: #344054; border-color: #cbd5e1; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-grid .full { grid-column: 1 / -1; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e7edf3; padding: 11px 8px; text-align: left; vertical-align: top; }
    th { color: #667085; font-size: 12px; font-weight: 700; background: #fbfcfd; position: sticky; top: 0; z-index: 1; }
    tbody tr:hover { background: #f8fbff; }
    .client-name { font-weight: 700; color: #111827; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 12px; border: 1px solid #d4dce5; background: #fff; color: #344054; }
    .badge.ok { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
    .badge.warn { color: #92400e; border-color: #fde68a; background: #fffbeb; }
    .row-actions { display: flex; gap: 6px; justify-content: flex-end; }
    .settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; }
    form.compact { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; margin-bottom: 12px; }
    form.threshold { display: grid; grid-template-columns: 1.2fr .7fr .7fr auto; gap: 8px; margin-bottom: 12px; }
    .list { display: grid; gap: 8px; }
    .item { border: 1px solid #e7edf3; border-radius: 8px; padding: 10px; display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; background: #fff; }
    .client-workspace { max-height: 660px; overflow: hidden; display: grid; grid-template-rows: auto auto auto 1fr; }
    .table-wrap { overflow: auto; border: 1px solid #e7edf3; border-radius: 9px; max-height: 480px; }
    .side-form { position: sticky; top: 84px; }
    .hint { background: #f8fafc; border: 1px solid #e7edf3; border-radius: 8px; padding: 10px 12px; color: #5f6b7a; font-size: 12px; line-height: 1.45; margin-bottom: 12px; }
    .toast { position: fixed; right: 18px; bottom: 18px; background: #101820; color: #fff; padding: 12px 14px; border-radius: 8px; box-shadow: 0 8px 30px rgba(16,24,32,.22); display: none; max-width: 420px; z-index: 4; }
    .error { color: #b42318; }
    @media (max-width: 1120px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; }
      .hero, .grid, .settings-grid { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(2, minmax(0,1fr)); }
      th { position: static; }
    }
    @media (max-width: 720px) {
      .content, header { padding-left: 16px; padding-right: 16px; }
      .summary { grid-template-columns: 1fr; }
      .form-grid, form.threshold { grid-template-columns: 1fr; }
      table { min-width: 920px; }
      .table-wrap { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">Viktor Admin</div>
      <div class="subtitle">Client mapping, reporting rules, and learning controls for the Slack automation bot.</div>
      <nav>
        <a href="#overview" class="active">Overview</a>
        <a href="#clients">Clients</a>
        <a href="#workflows">Workflows</a>
        <a href="#settings">Settings</a>
        <a href="#learning">Learning</a>
      </nav>
    </aside>
    <main>
      <header>
        <div>
          <h1>Workspace Control Center</h1>
          <div class="muted small">Use this page to prepare Viktor for your office workspace.</div>
        </div>
        <div id="status" class="badge warn">Loading</div>
      </header>

      <div class="content">
        <section class="hero" id="overview">
          <div class="panel overview-panel">
            <h2>Deployment Overview</h2>
            <div class="summary" id="stats"></div>
          </div>
          <div class="panel">
            <h2>Office Readiness</h2>
            <div class="readiness" id="readiness"></div>
          </div>
        </section>

        <section class="grid" id="clients">
          <div class="panel client-workspace">
            <h2>Clients</h2>
            <div class="toolbar">
              <input id="clientSearch" placeholder="Search client, website, channel, owner">
              <button id="newClientButton">Add new client</button>
            </div>
            <div class="item" id="trackerImportBox" style="margin-bottom:12px;"></div>
            <div class="table-wrap">
              <table id="clientsTable"></table>
            </div>
          </div>

          <div class="panel side-form">
            <h2 id="clientFormTitle">Add Client</h2>
            <p class="muted small">These fields save to clients.json. Sheet data can still enrich team and owner details automatically.</p>
            <form id="clientForm">
              <input type="hidden" name="originalClient">
              <div class="form-grid">
                <div class="full"><label>Client name</label><input name="client" required placeholder="Client or project name"></div>
                <div><label>Slack channel</label><input name="slackChannel" placeholder="mock-it-co"></div>
                <div><label>Main country</label><input name="mainCountry" placeholder="global, usa, gbr"></div>
                <div class="full"><label>GSC site / website</label><input name="gscSite" placeholder="https://example.com/"></div>
                <div><label>GA4 property ID</label><input name="ga4PropertyId" placeholder="123456789"></div>
                <div><label>Google profile</label><input name="googleProfile" placeholder="default or rankmetop"></div>
                <div><label>ClickUp list name</label><input name="clickupListName" placeholder="Client SEO"></div>
                <div><label>Team</label><input name="team" placeholder="Team AB"></div>
                <div><label>Tech owner</label><input name="techOwner" placeholder="Name"></div>
                <div><label>Dev owner</label><input name="devOwner" placeholder="Name"></div>
                <div class="full"><label>Dashboard / tracker URL</label><input name="dashboardUrl" placeholder="https://docs.google.com/..."></div>
              </div>
              <div class="actions">
                <button type="submit">Save client</button>
                <button type="button" class="ghost" id="resetClientForm">Clear</button>
                <button type="button" class="danger" id="deleteClientButton" disabled>Remove client</button>
              </div>
            </form>
          </div>
        </section>

        <section class="grid" id="workflows">
          <div class="panel">
            <h2>Opt-in Workflows</h2>
            <div class="hint">These are optional schedules layered on top of the current bot. They reuse Viktor's existing report and follow-up formats.</div>
            <div class="item" id="globalScheduleBox" style="margin-bottom:12px;"></div>
            <div class="table-wrap">
              <table id="workflowsTable"></table>
            </div>
          </div>

          <div class="panel">
            <h2>Access Control</h2>
            <div class="hint">Use restricted mode during office rollout. Add management/tester Slack user IDs before switching access to restricted.</div>
            <form class="compact" id="accessModeForm">
              <div>
                <label>Access mode</label>
                <select name="mode">
                  <option value="open">Open</option>
                  <option value="restricted">Restricted</option>
                </select>
              </div>
              <button>Save</button>
            </form>
            <form class="compact" id="accessUserForm">
              <div><label>Allowed Slack user ID</label><input name="userId" placeholder="U012ABCDEF or <@U012ABCDEF>"></div>
              <button>Add</button>
            </form>
            <div class="list" id="allowedUsers"></div>
          </div>
        </section>

        <section class="settings-grid" id="settings">
          <div class="panel">
            <h2>Core Settings</h2>
            <form class="compact" id="reportForm">
              <div><label>Fallback report channel</label><input name="channel" placeholder="data-and-alert"></div>
              <button>Save</button>
            </form>
            <form class="compact" id="followupForm">
              <div><label>Follow-up delay minutes</label><input name="minutes" type="number" min="1"></div>
              <button>Save</button>
            </form>
          </div>

          <div class="panel">
            <h2>Alert Thresholds</h2>
            <form class="threshold" id="thresholdForm">
              <div><label>Metric</label><input name="key" placeholder="GSC clicks"></div>
              <div><label>Percent</label><input name="pct" type="number" placeholder="25"></div>
              <div><label>Minimum</label><input name="absolute" type="number" placeholder="20"></div>
              <button>Set</button>
            </form>
            <div class="list" id="thresholds"></div>
          </div>

          <div class="panel">
            <h2>Team Members</h2>
            <div class="hint">These rosters control ClickUp workload grouping. Shared people can be listed in multiple teams; task counts stay scoped to that team's clients.</div>
            <form class="compact" id="teamMemberForm">
              <div>
                <label>Team</label>
                <select name="team">
                  <option>Team AB</option>
                  <option>Team CD</option>
                </select>
              </div>
              <div><label>Add member</label><input name="member" placeholder="Teammate X"></div>
              <button>Add</button>
            </form>
            <form id="teamMembersForm">
              <label>Replace roster</label>
              <select name="team">
                <option>Team AB</option>
                <option>Team CD</option>
              </select>
              <textarea name="members" rows="8" placeholder="One member per line"></textarea>
              <button>Save roster</button>
            </form>
            <div class="list" id="teamMembers"></div>
          </div>

          <div class="panel">
            <h2>Viktor Instructions</h2>
            <div class="hint">Use this for simple rules Viktor should remember, like report formatting, default comparison periods, or how you want alert wording handled. It is not client data.</div>
            <form class="compact" id="preferenceForm">
              <div><label>Instruction</label><input name="text" placeholder="Use compact tables for GSC reports"></div>
              <button>Add</button>
            </form>
            <div class="list" id="preferences"></div>
          </div>
        </section>

        <section class="settings-grid" id="learning">
          <div class="panel">
            <h2>Client Channel Overrides</h2>
            <form class="compact" id="clientChannelForm">
              <div><label>Client</label><input name="client" placeholder="Example Client X"></div>
              <div><label>Channel</label><input name="channel" placeholder="mock-it-co"></div>
              <button>Map</button>
            </form>
            <div class="list" id="clientChannels"></div>
          </div>
          <div class="panel">
            <h2>Learned Rules</h2>
            <div class="list" id="learnedRules"></div>
          </div>
          <div class="panel">
            <h2>Pending Learning</h2>
            <div class="list" id="pendingLearning"></div>
          </div>
        </section>
      </div>
    </main>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    let state = null;
    let filteredClients = [];

    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const del = (url, body) => fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    function toast(message, isError) {
      const el = document.querySelector('#toast');
      el.textContent = message;
      el.style.background = isError ? '#b42318' : '#101820';
      el.style.display = 'block';
      window.clearTimeout(toast._timer);
      toast._timer = window.setTimeout(() => { el.style.display = 'none'; }, 3200);
    }

    async function refresh() {
      try {
        state = await fetch('/api/state').then((response) => response.json());
        if (state.error) throw new Error(state.error);
        document.querySelector('#status').textContent = 'Connected';
        document.querySelector('#status').className = 'badge ok';
        syncForms();
        renderOverview();
        renderClients();
        renderTrackerImports();
        renderWorkflows();
        renderSettings();
      } catch (error) {
        document.querySelector('#status').textContent = 'Dashboard error';
        document.querySelector('#status').className = 'badge warn';
        toast(error.message || String(error), true);
      }
    }

    function syncForms() {
      document.querySelector('#reportForm [name=channel]').value = state.settings.reportChannel || '';
      document.querySelector('#followupForm [name=minutes]').value = state.effective.followupMinAgeMinutes || '';
      document.querySelector('#accessModeForm [name=mode]').value = state.settings.accessMode || 'open';
    }

    function editableClientMap() {
      const map = new Map();
      (state.editableClients || []).forEach((client) => map.set(norm(client.client), client));
      return map;
    }

    function effectiveClientMap() {
      const map = new Map();
      (state.clients || []).forEach((client) => map.set(norm(client.client), client));
      return map;
    }

    function mergedClients() {
      const editable = editableClientMap();
      return (state.clients || []).map((effective) => {
        const raw = editable.get(norm(effective.client)) || {};
        return Object.assign({}, effective, raw, {
          effectiveSlackChannel: effective.slackChannel || '',
          effectiveTeam: effective.team || '',
          effectiveTechOwner: effective.techOwner || '',
          effectiveDevOwner: effective.devOwner || ''
        });
      }).sort((a, b) => String(a.client || '').localeCompare(String(b.client || '')));
    }

    function renderOverview() {
      const clients = mergedClients();
      const total = clients.length;
      const channelCount = clients.filter((client) => client.effectiveSlackChannel || client.slackChannel).length;
      const gscCount = clients.filter((client) => client.gscSite).length;
      const gaCount = clients.filter((client) => client.ga4PropertyId).length;
      const ownerCount = clients.filter((client) => client.team || leadForClient(client)).length;
      document.querySelector('#stats').innerHTML = [
        ['Clients', total],
        ['Mapped channels', channelCount + ' / ' + total],
        ['GSC configured', gscCount + ' / ' + total],
        ['GA4 configured', gaCount + ' / ' + total]
      ].map((item) => '<div class="stat"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>').join('');

      const rows = [
        ['Slack channels', channelCount, total],
        ['GSC sites', gscCount, total],
        ['GA4 properties', gaCount, total],
        ['Owners or teams', ownerCount, total]
      ];
      document.querySelector('#readiness').innerHTML = rows.map((row) => {
        const pct = row[2] ? Math.round((row[1] / row[2]) * 100) : 0;
        return '<div><div class="small"><strong>' + esc(row[0]) + '</strong> <span class="muted">' + esc(row[1]) + '/' + esc(row[2]) + '</span></div><div class="meter"><div style="width:' + pct + '%"></div></div></div>';
      }).join('') + '<div class="muted small">Fallback alerts: #' + esc(state.effective.reportChannel || 'not set') + '</div>';
    }

    function renderClients() {
      const query = norm(document.querySelector('#clientSearch').value);
      const clients = mergedClients();
      filteredClients = clients.filter((client) => {
        const blob = [client.client, client.slackChannel, client.effectiveSlackChannel, client.gscSite, client.ga4PropertyId, client.googleProfile, client.team, client.effectiveTeam, client.techOwner, client.devOwner, client.clickupListName].join(' ');
        return !query || norm(blob).includes(query);
      });

      document.querySelector('#clientsTable').innerHTML = '<thead><tr><th>Client</th><th>Mapping</th><th>Google</th><th>Ownership</th><th>ClickUp</th><th></th></tr></thead><tbody>' +
        filteredClients.map((client) => {
          const channel = client.effectiveSlackChannel || client.slackChannel || '';
          const channelBadge = channel ? '<span class="badge ok">#' + esc(channel) + '</span>' : '<span class="badge warn">No channel</span>';
          const gscBadge = client.gscSite ? '<span class="badge ok">GSC</span>' : '<span class="badge warn">No GSC</span>';
          const gaBadge = client.ga4PropertyId ? '<span class="badge ok">GA4</span>' : '<span class="badge warn">No GA4</span>';
          const team = client.effectiveTeam || client.team || '';
          const lead = leadForClient(client);
          const owners = [team, lead ? 'Lead: ' + lead : ''].filter(Boolean).join(' / ');
          return '<tr>' +
            '<td><div class="client-name">' + esc(client.client) + '</div><div class="muted small">' + esc(client.mainCountry || 'global') + '</div></td>' +
            '<td>' + channelBadge + '<div class="muted small">' + esc(client.dashboardUrl || '') + '</div></td>' +
            '<td><div>' + gscBadge + ' ' + gaBadge + '</div><div class="muted small">Profile: ' + esc(client.googleProfile || 'default') + '</div><div class="muted small">' + esc(client.gscSite || '') + '</div><div class="muted small">' + esc(client.ga4PropertyId || '') + '</div></td>' +
            '<td>' + esc(owners || 'Not mapped') + '</td>' +
            '<td>' + esc(client.clickupListName || '') + '</td>' +
            '<td><div class="row-actions"><button class="secondary" data-edit-client="' + esc(client.client) + '">Edit</button><button class="danger" data-delete-client="' + esc(client.client) + '">Remove</button></div></td>' +
          '</tr>';
        }).join('') + '</tbody>';
    }

    function leadForClient(client) {
      const explicit = Array.isArray(client.responsiblePeople) && client.responsiblePeople.length ? client.responsiblePeople[0] : '';
      if (explicit) return explicit.replace(/\\s*\\+\\s*/g, ' / ');
      const team = String(client.effectiveTeam || client.team || '').toLowerCase();
      if (team.includes('team a')) return 'Teammate AB 1';
      if (team.includes('team b')) return 'Teammate AB 2';
      if (team.includes('team c')) return 'Teammate CD 1';
      if (team.includes('team d')) return 'Teammate CD 2';
      return '';
    }

    function missingSheetClients() {
      const existing = new Set((state.editableClients || []).map((client) => norm(client.client)));
      return (state.sheetClients || []).filter((client) => client.client && !existing.has(norm(client.client)));
    }

    function renderTrackerImports() {
      const missing = missingSheetClients();
      const box = document.querySelector('#trackerImportBox');
      if (!missing.length) {
        box.innerHTML = '<div><strong>Tracker import</strong><br><span class="muted small">All tracker clients that Viktor can see are already listed here.</span></div>';
        return;
      }

      box.innerHTML = '<div><strong>' + missing.length + ' tracker projects are not active in Viktor</strong><br><span class="muted small">That is expected for old, inactive, or later-account clients. Add them manually when they should enter active monitoring.</span></div>';
    }

    function renderWorkflows() {
      const schedule = state.effective.monitoringSchedule || {};
      document.querySelector('#globalScheduleBox').innerHTML = '<div><strong>On-demand workflow sends</strong><br><span class="muted small">Daily checks run once when Viktor starts, then every ' + esc(schedule.checkIntervalMinutes || 180) + ' minutes while Viktor is online. Slack delivery happens only when you press Send. Weekly reports and ClickUp workload are also sent from here on demand.</span></div>';
      const workflows = [
        {
          id: 'global-daily',
          type: 'daily_monitoring_alerts',
          clientName: 'All clients',
          channelName: 'daily-alert-team-ab/cd',
          scheduleText: 'Background check on startup, then every ' + (schedule.checkIntervalMinutes || 180) + ' minutes',
          status: 'on demand',
          lastRunAt: latestAlertedAt('workflow-run:global-daily:') || latestAlertedAt('monitoring-runtime-slot:')
        },
        {
          id: 'global-weekly',
          type: 'weekly_performance_summary',
          clientName: 'All clients',
          channelName: 'weekly-alert-team-ab/cd',
          scheduleText: 'Manual send',
          status: 'on demand',
          lastRunAt: latestAlertedAt('workflow-run:global-weekly:')
        },
        {
          id: 'global-clickup-workload',
          type: 'clickup_workload_summary',
          clientName: 'All teams',
          channelName: 'clickup-workload-team-ab/cd',
          scheduleText: 'Manual send',
          status: 'on demand',
          lastRunAt: latestAlertedAt('workflow-run:global-clickup-workload:') || latestAlertedAt('clickup-workload:')
        },
        ...(state.workflows || [])
      ];
      document.querySelector('#workflowsTable').innerHTML = '<thead><tr><th>ID</th><th>Type</th><th>Target</th><th>Schedule</th><th>Status</th><th>Last run</th><th>Action</th></tr></thead><tbody>' +
        (workflows.length ? workflows.map((workflow) => {
          const target = [workflow.clientName || '', workflow.channelName ? '#' + workflow.channelName : ''].filter(Boolean).join(' / ') || 'Workspace';
          const schedule = workflow.scheduleText || formatSchedule(workflow.schedule || {});
          const lastRun = workflow.lastRunAt ? formatLastRun(workflow.lastRunAt) : 'Not yet';
          return '<tr>' +
            '<td><span class="badge">' + esc(workflow.id) + '</span></td>' +
            '<td>' + esc(workflow.type) + '</td>' +
            '<td>' + esc(target) + '</td>' +
            '<td>' + esc(schedule) + '</td>' +
            '<td><span class="badge ' + (workflow.status === 'active' ? 'ok' : 'warn') + '">' + esc(workflow.status) + '</span></td>' +
            '<td>' + esc(lastRun) + '</td>' +
            '<td><button class="secondary" data-send-workflow="' + esc(workflow.id) + '">Send</button></td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="7" class="muted">No opt-in workflows yet. Create them from Slack with commands like: enable weekly summary for Client Name in #channel every Monday at 10am</td></tr>') +
        '</tbody>';

      const users = state.settings.allowedUserIds || [];
      document.querySelector('#allowedUsers').innerHTML = users.length ? users.map((id) => {
        return '<div class="item"><div><strong>' + esc(id) + '</strong><br><span class="muted small">Allowed in restricted mode</span></div><button class="danger" data-remove="accessUser" data-key="' + esc(id) + '">Remove</button></div>';
      }).join('') : '<div class="muted small">No dashboard-managed users yet. Environment users may still be allowed.</div>';
    }

    function formatSchedule(schedule) {
      const time = String(schedule.hour ?? 0).padStart(2, '0') + ':' + String(schedule.minute ?? 0).padStart(2, '0');
      if (schedule.frequency === 'weekly') return 'Weekly ' + dayName(schedule.dayOfWeek ?? 1) + ' ' + time;
      if (schedule.frequency === 'monthly') return 'Monthly day ' + (schedule.dayOfMonth || 1) + ' ' + time;
      return 'Daily ' + time;
    }

    function dayName(day) {
      return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day] || 'Monday';
    }

    function formatHour(hour) {
      const value = Number(hour || 0);
      const suffix = value >= 12 ? 'PM' : 'AM';
      const display = value % 12 || 12;
      return display + ':00 ' + suffix;
    }

    function formatLastRun(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function latestAlertedAt(prefix) {
      const alerted = state.monitoringState?.alertedKeys || {};
      return Object.entries(alerted)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value)
        .sort()
        .at(-1);
    }

    function renderSettings() {
      renderMap('#clientChannels', state.settings.clientChannels, 'clientChannel');
      renderThresholds();
      renderTeamMembers();
      renderList('#preferences', state.settings.preferences || [], 'preference');
      renderLearned();
      renderPending();
    }

    function renderTeamMembers() {
      const teams = ['Team AB', 'Team CD'];
      const rosters = state.settings.teamMembers || {};
      document.querySelector('#teamMembers').innerHTML = teams.map((team) => {
        const members = rosters[team] || [];
        const items = members.length ? members.map((member) =>
          '<span class="badge">' + esc(member) + ' <button class="ghost" data-remove-team-member="' + esc(team) + '" data-member="' + esc(member) + '">x</button></span>'
        ).join(' ') : '<span class="muted small">No saved roster yet; code fallback may still apply.</span>';
        return '<div class="item"><div><strong>' + esc(team) + '</strong><br>' + items + '</div></div>';
      }).join('');
      const selected = document.querySelector('#teamMembersForm [name=team]').value || 'Team AB';
      document.querySelector('#teamMembersForm [name=members]').value = (rosters[selected] || []).join('\\n');
    }

    function renderMap(selector, value, type) {
      const entries = Object.entries(value || {});
      document.querySelector(selector).innerHTML = entries.length ? entries.map((entry) => {
        return '<div class="item"><div><strong>' + esc(entry[0]) + '</strong><br><span class="muted">#' + esc(entry[1]) + '</span></div><button class="danger" data-remove="' + type + '" data-key="' + esc(entry[0]) + '">Remove</button></div>';
      }).join('') : '<div class="muted small">No overrides yet.</div>';
    }

    function renderThresholds() {
      const entries = Object.entries(state.settings.thresholds || {});
      document.querySelector('#thresholds').innerHTML = entries.length ? entries.map((entry) => {
        const rule = entry[1] || {};
        return '<div class="item"><div><strong>' + esc(entry[0]) + '</strong><br><span class="muted">' + esc(rule.pct ?? '') + '% change, minimum ' + esc(rule.absolute ?? 'none') + '</span></div><button class="danger" data-remove="threshold" data-key="' + esc(entry[0]) + '">Remove</button></div>';
      }).join('') : '<div class="muted small">Default thresholds are active.</div>';
    }

    function renderList(selector, items, type) {
      document.querySelector(selector).innerHTML = items.length ? items.map((item) => '<div class="item"><div>' + esc(item) + '</div><button class="danger" data-remove="' + type + '" data-key="' + esc(item) + '">Remove</button></div>').join('') : '<div class="muted small">No entries yet.</div>';
    }

    function renderLearned() {
      const rules = state.settings.learnedRules || [];
      document.querySelector('#learnedRules').innerHTML = rules.length ? rules.map((rule) => '<div class="item"><div><strong>' + esc(rule.type) + '</strong><br>' + esc(rule.text) + '<br><span class="muted small">' + esc(rule.id) + '</span></div><button class="danger" data-remove="learned" data-key="' + esc(rule.id) + '">Remove</button></div>').join('') : '<div class="muted small">No approved learned rules yet.</div>';
    }

    function renderPending() {
      const items = Object.values(state.settings.pendingLearning || {});
      document.querySelector('#pendingLearning').innerHTML = items.length ? items.map((item) => '<div class="item"><div>' + esc(item.text) + '<br><span class="muted small">' + esc(item.id) + '</span></div><div><button data-approve="' + esc(item.id) + '">Approve</button> <button class="danger" data-reject="' + esc(item.id) + '">Reject</button></div></div>').join('') : '<div class="muted small">No pending suggestions.</div>';
    }

    function resetClientForm() {
      const form = document.querySelector('#clientForm');
      form.reset();
      form.originalClient.value = '';
      document.querySelector('#clientFormTitle').textContent = 'Add Client';
      document.querySelector('#deleteClientButton').disabled = true;
    }

    function fillClientForm(clientName) {
      const client = mergedClients().find((item) => item.client === clientName);
      if (!client) return;
      const form = document.querySelector('#clientForm');
      form.originalClient.value = client.client || '';
      form.client.value = client.client || '';
      form.slackChannel.value = client.slackChannel || client.effectiveSlackChannel || '';
      form.gscSite.value = client.gscSite || '';
      form.ga4PropertyId.value = client.ga4PropertyId || '';
      form.googleProfile.value = client.googleProfile || '';
      form.mainCountry.value = client.mainCountry || 'global';
      form.clickupListName.value = client.clickupListName || '';
      form.team.value = client.team || client.effectiveTeam || '';
      form.techOwner.value = client.techOwner || client.effectiveTechOwner || '';
      form.devOwner.value = client.devOwner || client.effectiveDevOwner || '';
      form.dashboardUrl.value = client.dashboardUrl || '';
      document.querySelector('#clientFormTitle').textContent = 'Edit Client';
      document.querySelector('#deleteClientButton').disabled = false;
      document.querySelector('#clientForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function submitClientForm(event) {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form).entries());
      const response = await post('/api/client', data);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        toast(result.error || 'Could not save client', true);
        return;
      }
      toast('Client saved');
      resetClientForm();
      await refresh();
    }

    document.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      try {
        if (event.target.id === 'clientForm') {
          await submitClientForm(event);
          return;
        }
        if (event.target.id === 'reportForm') await post('/api/report-channel', data);
        if (event.target.id === 'followupForm') await post('/api/followup', data);
        if (event.target.id === 'accessModeForm') await post('/api/access-mode', data);
        if (event.target.id === 'accessUserForm') await post('/api/access-user', data);
        if (event.target.id === 'clientChannelForm') await post('/api/client-channel', data);
        if (event.target.id === 'teamMemberForm') await post('/api/team-member', data);
        if (event.target.id === 'teamMembersForm') await post('/api/team-members', data);
        if (event.target.id === 'thresholdForm') await post('/api/threshold', data);
        if (event.target.id === 'preferenceForm') await post('/api/preference', data);
        event.target.reset();
        toast('Saved');
        await refresh();
      } catch (error) {
        toast(error.message || String(error), true);
      }
    });

    document.addEventListener('change', (event) => {
      if (event.target && event.target.matches && event.target.matches('#teamMembersForm [name=team]')) {
        renderTeamMembers();
      }
    });

    document.addEventListener('click', async (event) => {
      const target = event.target;
      try {
        if (target.closest && (target.closest('#newClientButton') || target.closest('#resetClientForm'))) {
          event.preventDefault();
          resetClientForm();
          return;
        }
        if (target.id === 'importAllSheetClients') {
          const response = await post('/api/import-sheet-clients', {});
          const result = await response.json();
          toast('Imported ' + (result.imported || 0) + ' clients from tracker');
          await refresh();
        }
        if (target.dataset.editClient) fillClientForm(target.dataset.editClient);
        if (target.dataset.removeTeamMember) {
          await del('/api/team-member', { team: target.dataset.removeTeamMember, member: target.dataset.member });
          toast('Team member removed');
          await refresh();
          return;
        }
        if (target.dataset.sendWorkflow) {
          const originalText = target.textContent;
          target.disabled = true;
          target.textContent = 'Sending...';
          try {
            const response = await post('/api/workflow/send', { id: target.dataset.sendWorkflow });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.error || 'Could not send workflow');
            toast(result.message || 'Workflow sent');
            await refresh();
          } finally {
            target.disabled = false;
            target.textContent = originalText || 'Send';
          }
          return;
        }
        if (target.dataset.deleteClient) {
          if (confirm('Remove ' + target.dataset.deleteClient + ' from Viktor monitoring?')) {
            await del('/api/client', { client: target.dataset.deleteClient });
            toast('Client removed');
            await refresh();
          }
        }
        if (target.id === 'deleteClientButton') {
          const form = document.querySelector('#clientForm');
          if (form.originalClient.value && confirm('Remove ' + form.originalClient.value + ' from Viktor monitoring?')) {
            await del('/api/client', { client: form.originalClient.value });
            resetClientForm();
            toast('Client removed');
            await refresh();
          }
        }
        if (target.dataset.remove === 'clientChannel') await del('/api/client-channel', { client: target.dataset.key });
        if (target.dataset.remove === 'threshold') await del('/api/threshold', { key: target.dataset.key });
        if (target.dataset.remove === 'preference') await del('/api/preference', { text: target.dataset.key });
        if (target.dataset.remove === 'learned') await post('/api/learned/remove', { query: target.dataset.key });
        if (target.dataset.remove === 'accessUser') await del('/api/access-user', { userId: target.dataset.key });
        if (target.dataset.approve) await post('/api/learning/approve', { id: target.dataset.approve });
        if (target.dataset.reject) await post('/api/learning/reject', { id: target.dataset.reject });
        if (target.dataset.remove || target.dataset.approve || target.dataset.reject) {
          toast('Updated');
          await refresh();
        }
      } catch (error) {
        toast(error.message || String(error), true);
      }
    });

    document.querySelector('#clientSearch').addEventListener('input', renderClients);
    refresh();
  </script>
</body>
</html>`;
}

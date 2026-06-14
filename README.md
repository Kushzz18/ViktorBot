# Viktor Slack Operations Bot

Viktor is a TypeScript Slack bot for SEO operations, reporting, follow-ups, ClickUp coordination, Google Drive search, and lightweight team memory. It runs through Slack Socket Mode and can be used from channels, threads, direct mentions, DMs, slash commands, and the local dashboard.

This public repository uses example client and teammate names only. Put real workspace/client mappings in private local configuration files.

## What It Does

- Listens in Slack through Socket Mode and responds to direct mentions, DMs, slash commands, thread commands, and approved message actions.
- Accepts `/viktor-task` commands and natural-language task requests.
- Posts task proposals with Approve and Reject buttons before creating ClickUp tasks.
- Supports approval by reaction, using `:white_check_mark:` by default.
- Creates ClickUp tasks only after approval, then replies in the same Slack thread with the created task link.
- Routes ClickUp tasks into matching client lists using `Client:` or `List:` hints.
- Finds, updates, comments on, closes, and summarizes ClickUp tasks.
- Produces team workload summaries from ClickUp by team, member, status, client list, and current-week task scope.
- Supports shared/global team members while keeping workload scoped to each team's clients.
- Stores Slack messages locally so Viktor has searchable workspace memory.
- Stores important client notes and team notes for later recall.
- Stores priority keywords and priority URLs per client for monitoring and weekly reporting.
- Detects and follows up on unresolved Slack client-message threads where Viktor is tagged or explicitly asked to follow up.
- Supports timed reminders such as later today, tomorrow, specific times, and multi-day reminders.
- Backfills recent reminders and unresolved follow-ups after downtime, while respecting resolved or stopped threads.
- Runs daily monitoring for GSC and GA4 changes, including traffic anomalies and technical checks.
- Creates weekly performance summaries for clients with GSC and GA4 comparisons.
- Compares GSC clicks, impressions, CTR, average position, priority queries, priority URLs, and notable movers.
- Reviews GA4 active users, sessions, key events, source/medium, landing pages, and likely drivers.
- Performs supporting technical checks such as robots.txt changes, sitemap sampling, indexability signals, schema coverage, and PageSpeed metrics.
- Searches Google Drive files and folders connected to configured Google accounts.
- Fetches and summarizes Drive documents, PDFs, spreadsheets, text files, and uploaded Slack files.
- Answers questions from uploaded or linked files when the content can be extracted.
- Can convert supported document/report outputs into PDF-style deliverables where configured.
- Maintains client mappings for Slack channels, ClickUp lists, GSC properties, GA4 properties, Google profiles, owners, teams, priority URLs, and monitoring settings.
- Provides a local dashboard for triggering daily alerts, weekly reports, ClickUp workload reports, and editing team/client mappings.
- Supports Google account discovery for GSC, GA4, Drive, and Sheets.
- Syncs optional client/team metadata from configured Google Sheets.
- Uses model fallback configuration so Viktor can try another configured AI model when the primary model fails.

## Setup

1. Create a Slack app.
2. Import or copy the settings from `slack-app-manifest.yml`.
3. Enable Socket Mode.
4. Add an app-level token with `connections:write`.
5. Add a bot token with these scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:join`
   - `channels:read`
   - `chat:write`
   - `chat:write.public`
   - `commands`
   - `files:read`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `im:write`
   - `mpim:history`
   - `mpim:read`
   - `reactions:read`
   - `users:read`
6. Enable Interactivity in Slack.
7. Create a slash command named `/viktor-task`.
8. Create a ClickUp API token and choose the fallback ClickUp List ID.
9. Copy `.env.example` to `.env` and fill in the private values.
10. Copy `clients.example.json` to `clients.json` and replace the example clients with private workspace mappings.

## Run

```bash
npm install
npm run dev
```

The dashboard runs locally when enabled:

```text
http://localhost:8788/
```

## Usage

Create a ClickUp task:

```text
/viktor-task Add keywords to the backend keyword field | Client: Example Client X | Due: May 9 | Assignees: Kushal, Teammate X | Priority: High
```

Or mention the bot:

```text
@Viktor create task: Audit the new landing page forms | Client: Example Client Y | Due: tomorrow | Priority: normal
```

Send an approved channel message:

```text
go to channel #example-channel and message Please share the final notes today
```

By default, Viktor composes a polished message from the instruction. If exact text is needed, say `exactly` or `verbatim`. Message sends use the same approval flow as task creation.

Memory and follow-up commands:

```text
memory stats
scan followups
add client log for Example Client X: note text
show client log for Example Client X
remember this for Example Client X: note text
@Viktor follow up here tomorrow at 10am
@Viktor resolved
```

Google discovery commands:

```text
google status
list clients
map channel example-client-x
list drive files
list gsc sites
list ga properties
search drive technical checklist
```

File and Drive commands:

```text
summarize the document <Google Drive URL>
find files about Example Topic
summarize this uploaded PDF
answer questions from this spreadsheet
```

Monitoring and reporting commands:

```text
daily monitoring
weekly report
weekly GSC data for Example Client X with comparison
GA4 sessions for Example Client X last 28 days with comparison
GSC performance of page https://example.com/page/ for Example Client X last week
```

ClickUp commands:

```text
task health
task health Example Client X
what's overdue for Kushal?
show Team AB workload
find tasks about Example Client X
what changed on task 86abc123
close task 86abc123
comment task 86abc123: Added follow-up notes from Slack.
update task 86abc123 status: in progress | due: tomorrow | priority: high
```

## Private Client Configuration

Use `clients.example.json` as the public template. Keep the real `clients.json` private and out of Git.

Client ownership can be added in `clients.json`:

```json
{
  "ownerSlackUserIds": ["U0123456789"],
  "teamSlackUserIds": ["U1111111111", "U2222222222"]
}
```

Priority monitoring can be configured per client:

```json
{
  "client": "Example Client X",
  "priorityQueries": ["example service keyword"],
  "priorityUrls": ["https://example.com/service/"]
}
```

Money-page schema monitoring can also be configured:

```json
{
  "client": "Example Client X",
  "moneyPages": [
    {
      "url": "https://example.com/product/example-product/",
      "expectedSchemaTypes": ["Product"]
    }
  ]
}
```

Viktor alerts only when expected schema is missing, schema has parse errors, or schema that was previously present disappears. General schema coverage also samples homepage, service, industry, location, product, and collection pages where available.

## Assignees

ClickUp requires numeric user IDs for assignees. Put a simple name map in `.env`:

```text
ASSIGNEE_MAP_JSON={"Kushal":12345678,"Teammate X":23456789}
```

Then this Slack input:

```text
Assignees: Kushal, Teammate X
```

will become ClickUp assignees `[12345678, 23456789]`.

## Production Notes

For reliable 24/7 operation, run Viktor on an always-on PC or VPS with a process manager such as PM2 or Docker. Keep `.env`, OAuth credentials, local data, and real client mappings private. For production, use a proper database such as SQLite, Postgres, or Redis so approvals, reminders, memory, and follow-up state survive restarts cleanly.

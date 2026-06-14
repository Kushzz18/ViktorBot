import { z } from "zod";

const envSchema = z.object({
  SLACK_BOT_TOKEN: requiredSecret("SLACK_BOT_TOKEN"),
  SLACK_APP_TOKEN: requiredSecret("SLACK_APP_TOKEN"),
  CLICKUP_API_TOKEN: requiredSecret("CLICKUP_API_TOKEN"),
  CLICKUP_LIST_ID: requiredSecret("CLICKUP_LIST_ID"),
  CLICKUP_FOLDER_ID: z.string().optional(),
  APPROVAL_EMOJI: z.string().default("white_check_mark"),
  BOT_NAME: z.string().default("Viktor"),
  BOT_ALLOWED_USER_IDS: z.string().default(""),
  ASSIGNEE_MAP_JSON: z.string().default("{}"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_API_KEYS: z.string().default(""),
  OPENROUTER_MODEL: z.string().optional(),
  AI_CLASSIFIER_MODEL: z.string().optional(),
  AI_REPORT_MODEL: z.string().optional(),
  AI_REASONING_MODEL: z.string().optional(),
  AI_MAX_REPLY_TOKENS: z.coerce.number().int().positive().max(2000).default(350),
  DATA_DIR: z.string().default("data"),
  FOLLOWUP_SCAN_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  FOLLOWUP_MIN_AGE_MINUTES: z.coerce.number().int().positive().default(120),
  SLACK_REPORT_CHANNEL: z.string().optional(),
  MONITORING_CHECK_INTERVAL_MINUTES: z.coerce.number().int().positive().default(180),
  MONITORING_DAILY_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  MONITORING_WEEKLY_DAY: z.coerce.number().int().min(0).max(6).default(5),
  MONITORING_WEEKLY_HOUR: z.coerce.number().int().min(0).max(23).default(21),
  MONITORING_WEEKLY_FALLBACK_DAY: z.coerce.number().int().min(0).max(6).default(1),
  MONITORING_WEEKLY_FALLBACK_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  MONITORING_MONTHLY_DAY: z.union([z.literal("end"), z.coerce.number().int().min(1).max(28)]).default("end"),
  MONITORING_MONTHLY_HOUR: z.coerce.number().int().min(0).max(23).default(21),
  GOOGLE_OAUTH_CLIENT_PATH: z.string().default("google-oauth-client.json"),
  GOOGLE_TOKEN_PATH: z.string().default("google-token.json"),
  GOOGLE_PROFILES_JSON: z.string().default("{}"),
  PAGESPEED_API_KEY: z.string().optional(),
  CLIENTS_CONFIG_PATH: z.string().default("clients.json"),
  TEAM_TRACKER_SHEET_ID: z.string().default("1AAIRrXn6Cn1Oj2ejGZ5HBiOWxW8fwCXW6VtANigPJJ0"),
  CLIENT_STATUS_SHEET_ID: z.string().default("1Gqj6mdC1z-gLGVYI2xZD4s1TdJ-UHHywi1L0u4VFPUc"),
  SHEET_SYNC_CACHE_MINUTES: z.coerce.number().int().positive().default(30),
  ADMIN_DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  ADMIN_DASHBOARD_TOKEN: z.string().optional()
});

const parsedEnvResult = envSchema.safeParse(process.env);

if (!parsedEnvResult.success) {
  const missing = parsedEnvResult.error.issues
    .map((issue) => issue.path.join("."));

  throw new Error(
    [
      "Missing required environment settings.",
      missing.length ? `Add these to .env: ${missing.join(", ")}` : "Check your .env file.",
      "Use .env.example as the template."
    ].join(" ")
  );
}

const parsedEnv = parsedEnvResult.data;

export const config = {
  ...parsedEnv,
  OPENROUTER_KEYS: parseCsv(parsedEnv.OPENROUTER_API_KEYS || parsedEnv.OPENROUTER_API_KEY || ""),
  BOT_ALLOWED_USERS: parseCsv(parsedEnv.BOT_ALLOWED_USER_IDS),
  ASSIGNEE_MAP: parseAssigneeMap(parsedEnv.ASSIGNEE_MAP_JSON),
  GOOGLE_PROFILES: parseGoogleProfiles(
    parsedEnv.GOOGLE_PROFILES_JSON,
    parsedEnv.GOOGLE_OAUTH_CLIENT_PATH,
    parsedEnv.GOOGLE_TOKEN_PATH
  )
};

function parseAssigneeMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, id]) => typeof id === "number")
        .map(([name, id]) => [name.toLowerCase(), id as number])
    );
  } catch {
    return {};
  }
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export type GoogleProfileConfig = {
  oauthClientPath: string;
  tokenPath: string;
};

function parseGoogleProfiles(
  value: string,
  defaultOAuthClientPath: string,
  defaultTokenPath: string
): Record<string, GoogleProfileConfig> {
  const profiles: Record<string, GoogleProfileConfig> = {
    default: {
      oauthClientPath: defaultOAuthClientPath,
      tokenPath: defaultTokenPath
    },
    main: {
      oauthClientPath: defaultOAuthClientPath,
      tokenPath: defaultTokenPath
    }
  };

  try {
    const parsed = JSON.parse(value || "{}") as Record<string, unknown>;
    for (const [rawName, rawProfile] of Object.entries(parsed)) {
      const name = normalizeProfileName(rawName);
      if (!name || !rawProfile || typeof rawProfile !== "object") continue;
      const profile = rawProfile as Record<string, unknown>;
      const oauthClientPath = cleanText(profile.oauthClientPath ?? profile.clientPath ?? profile.oauthPath);
      const tokenPath = cleanText(profile.tokenPath);
      if (!oauthClientPath || !tokenPath) continue;
      profiles[name] = { oauthClientPath, tokenPath };
    }
  } catch {
    // Keep the default profile usable if optional profile JSON is malformed.
  }

  return profiles;
}

function normalizeProfileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredSecret(name: string) {
  return z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("replace_with_"), {
      message: `${name} still has its placeholder value`
    });
}

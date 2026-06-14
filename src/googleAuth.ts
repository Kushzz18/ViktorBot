import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { google, type Auth } from "googleapis";
import open from "open";
import { config } from "./config.js";

const scopes = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly"
];

type OAuthClientFile = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

export async function getGoogleAuthClient(profileName?: string): Promise<Auth.OAuth2Client> {
  const profile = resolveGoogleProfile(profileName);
  const oauth2Client = await createOAuthClient(profile.name);
  const token = JSON.parse(await readFile(profile.tokenPath, "utf8")) as Auth.Credentials;
  oauth2Client.setCredentials(token);
  return oauth2Client;
}

export async function runGoogleOAuthLogin(profileName?: string) {
  const profile = resolveGoogleProfile(profileName);
  const oauth2Client = await createOAuthClient(profile.name, "http://localhost:8787/oauth2callback");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });

  console.log("Opening Google login in your browser...");
  console.log(authUrl);

  const code = await waitForOAuthCode(authUrl);
  const { tokens } = await oauth2Client.getToken(code);
  await writeFile(profile.tokenPath, JSON.stringify(tokens, null, 2));

  console.log(`Google token saved to ${profile.tokenPath} for profile ${profile.name}`);
}

async function createOAuthClient(profileName?: string, redirectUriOverride?: string): Promise<Auth.OAuth2Client> {
  const profile = resolveGoogleProfile(profileName);
  const raw = JSON.parse(await readFile(profile.oauthClientPath, "utf8")) as OAuthClientFile;
  const credentials = raw.installed ?? raw.web;

  if (!credentials) {
    throw new Error("Google OAuth credentials file must contain an installed or web client.");
  }

  const redirectUri = redirectUriOverride ?? credentials.redirect_uris[0];
  return new google.auth.OAuth2(credentials.client_id, credentials.client_secret, redirectUri);
}

function resolveGoogleProfile(profileName?: string): { name: string; oauthClientPath: string; tokenPath: string } {
  const name = normalizeProfileName(profileName || "default") || "default";
  const profile = config.GOOGLE_PROFILES[name];
  if (!profile) {
    throw new Error(`Google profile "${name}" is not configured.`);
  }
  return {
    name,
    oauthClientPath: profile.oauthClientPath,
    tokenPath: profile.tokenPath
  };
}

function normalizeProfileName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function waitForOAuthCode(authUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost:8787");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Google OAuth failed: ${error}`);
          server.close();
          reject(new Error(`Google OAuth failed: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("No OAuth code found.");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Viktor is connected to Google.</h1><p>You can close this tab.</p>");
        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.listen(8787, "localhost", () => {
      void open(authUrl);
    });
  });
}

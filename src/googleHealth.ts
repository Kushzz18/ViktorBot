import { google } from "googleapis";
import { getGoogleAuthClient } from "./googleAuth.js";

export type GoogleHealth = {
  ok: boolean;
  error?: string;
  userAction?: string;
  kind?: "auth" | "network" | "api";
};

export async function checkGoogleApiHealth(): Promise<GoogleHealth> {
  try {
    const auth = await getGoogleAuthClient();
    const searchconsole = google.searchconsole({ version: "v1", auth });
    const analyticsAdmin = google.analyticsadmin({ version: "v1beta", auth });

    await Promise.all([
      searchconsole.sites.list(),
      analyticsAdmin.accountSummaries.list({ pageSize: 1 })
    ]);

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAuth = /invalid_grant|invalid_request|unauthorized/i.test(message);
    const isNetwork = isTransientGoogleNetworkError(message);
    return {
      ok: false,
      error: message,
      kind: isAuth ? "auth" : isNetwork ? "network" : "api",
      userAction: isAuth
        ? "Google OAuth needs to be refreshed. Run `npm run google:auth`, complete the Google login, then restart Viktor."
        : isNetwork
          ? "This looks like a temporary DNS/network issue on the laptop. Check internet/DNS stability and try again; OAuth does not need to be refreshed for this error."
        : "Check Google API access and try again."
    };
  }
}

function isTransientGoogleNetworkError(message: string): boolean {
  return /getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket|network|terminated|temporarily unavailable/i.test(message);
}

import { google } from "googleapis";
import { getGoogleAuthClient } from "./googleAuth.js";

export type GoogleHealth = {
  ok: boolean;
  error?: string;
  userAction?: string;
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
    return {
      ok: false,
      error: message,
      userAction: /invalid_grant|invalid_request|unauthorized/i.test(message)
        ? "Google OAuth needs to be refreshed. Run `npm run google:auth`, complete the Google login, then restart Viktor."
        : "Check Google API access and try again."
    };
  }
}

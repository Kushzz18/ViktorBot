import { google } from "googleapis";
import { getGoogleAuthClient } from "./googleAuth.js";

type GaPropertySummary = {
  account?: string | null;
  property?: string | null;
  propertyId?: string;
};

export async function discoverGoogleAccess(profileName?: string) {
  const auth = await getGoogleAuthClient(profileName);

  const drive = google.drive({ version: "v3", auth });
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const analyticsAdmin = google.analyticsadmin({ version: "v1beta", auth });

  const [driveFiles, gscSites, gaProperties] = await Promise.allSettled([
    drive.files.list({
      pageSize: 10,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
      orderBy: "modifiedTime desc"
    }),
    searchconsole.sites.list(),
    listAllGaProperties(analyticsAdmin)
  ]);

  return {
    driveFiles:
      driveFiles.status === "fulfilled"
        ? driveFiles.value.data.files?.map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            link: file.webViewLink
          })) ?? []
        : { error: driveFiles.reason instanceof Error ? driveFiles.reason.message : String(driveFiles.reason) },
    gscSites:
      gscSites.status === "fulfilled"
        ? gscSites.value.data.siteEntry?.map((site) => ({
            siteUrl: site.siteUrl,
            permissionLevel: site.permissionLevel
          })) ?? []
        : { error: gscSites.reason instanceof Error ? gscSites.reason.message : String(gscSites.reason) },
    gaProperties:
      gaProperties.status === "fulfilled"
        ? gaProperties.value
        : { error: gaProperties.reason instanceof Error ? gaProperties.reason.message : String(gaProperties.reason) }
  };
}

async function listAllGaProperties(
  analyticsAdmin: ReturnType<typeof google.analyticsadmin>
): Promise<GaPropertySummary[]> {
  const properties: GaPropertySummary[] = [];
  let pageToken: string | undefined;

  do {
    const response = await analyticsAdmin.accountSummaries.list({
      pageSize: 200,
      pageToken
    });

    for (const account of response.data.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        properties.push({
          account: account.displayName,
          property: property.displayName,
          propertyId: property.property?.replace("properties/", "")
        });
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return properties;
}

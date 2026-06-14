import { discoverGoogleAccess } from "./googleDiscovery.js";

type GoogleAccess = Awaited<ReturnType<typeof discoverGoogleAccess>>;

export async function formatDriveFiles(limit = 10): Promise<string> {
  const access = await discoverGoogleAccess();

  if (!Array.isArray(access.driveFiles)) {
    return formatError("Drive", access.driveFiles.error);
  }

  if (!access.driveFiles.length) {
    return "I can access Drive, but I did not find recent files.";
  }

  const lines = access.driveFiles.slice(0, limit).map((file, index) => {
    const link = file.link ? `<${file.link}|open>` : "";
    return `${index + 1}. ${file.name} ${link}`.trim();
  });

  return [`Recent Drive files I can access:`, ...lines].join("\n");
}

export async function formatGscSites(limit = 25): Promise<string> {
  const access = await discoverGoogleAccess();

  if (!Array.isArray(access.gscSites)) {
    return formatError("GSC", access.gscSites.error);
  }

  if (!access.gscSites.length) {
    return "I can access Search Console, but I did not find any sites.";
  }

  const lines = access.gscSites.slice(0, limit).map((site, index) => {
    return `${index + 1}. ${site.siteUrl} (${site.permissionLevel})`;
  });

  return [
    `GSC sites I can access (${access.gscSites.length} total):`,
    ...lines,
    access.gscSites.length > limit ? `...and ${access.gscSites.length - limit} more.` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export async function formatGaProperties(limit = 25): Promise<string> {
  const access = await discoverGoogleAccess();

  if (!Array.isArray(access.gaProperties)) {
    return formatError("GA4", access.gaProperties.error);
  }

  if (!access.gaProperties.length) {
    return "I can access GA4, but I did not find any properties.";
  }

  const lines = access.gaProperties.slice(0, limit).map((property, index) => {
    return `${index + 1}. ${property.property} (${property.account}) - ${property.propertyId}`;
  });

  return [
    `GA4 properties I can access (${access.gaProperties.length} total):`,
    ...lines,
    access.gaProperties.length > limit ? `...and ${access.gaProperties.length - limit} more.` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export async function formatGoogleAccessSummary(): Promise<string> {
  const access = await discoverGoogleAccess();
  const driveCount = Array.isArray(access.driveFiles) ? access.driveFiles.length : "error";
  const gscCount = Array.isArray(access.gscSites) ? access.gscSites.length : "error";
  const gaCount = Array.isArray(access.gaProperties) ? access.gaProperties.length : "error";

  return [
    "Google access summary:",
    `Drive recent files: ${driveCount}`,
    `GSC sites: ${gscCount}`,
    `GA4 properties: ${gaCount}`,
    "Try `list drive files`, `list gsc sites`, or `list ga properties`."
  ].join("\n");
}

function formatError(label: string, error: string): string {
  return `${label} access returned an error: ${error}`;
}

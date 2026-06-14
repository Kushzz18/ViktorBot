import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { MessageTarget } from "./proposals.js";

type TrustedMessageRoute = {
  requester: string;
  targetKey: string;
  createdAt: string;
};

const trustPath = join(config.DATA_DIR, "trusted-message-routes.json");
let trustedRoutes: TrustedMessageRoute[] = loadTrustedRoutes();

export function isTrustedMessageRoute(requester: string, targets: MessageTarget[]): boolean {
  const targetKey = routeKey(targets);
  return trustedRoutes.some((route) => route.requester === requester && route.targetKey === targetKey);
}

export function rememberTrustedMessageRoute(requester: string, targets: MessageTarget[]) {
  const targetKey = routeKey(targets);
  if (!trustedRoutes.some((route) => route.requester === requester && route.targetKey === targetKey)) {
    trustedRoutes.push({ requester, targetKey, createdAt: new Date().toISOString() });
    trustedRoutes = trustedRoutes.slice(-250);
    persistTrustedRoutes();
  }
}

function routeKey(targets: MessageTarget[]): string {
  return targets
    .map((target) => `${target.kind ?? "channel"}:${target.channelId}`)
    .sort()
    .join("|");
}

function loadTrustedRoutes(): TrustedMessageRoute[] {
  if (!existsSync(trustPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(trustPath, "utf8")) as TrustedMessageRoute[];
    return Array.isArray(parsed)
      ? parsed.filter((route) => route.requester && route.targetKey)
      : [];
  } catch {
    return [];
  }
}

function persistTrustedRoutes() {
  mkdirSync(config.DATA_DIR, { recursive: true });
  writeFileSync(trustPath, JSON.stringify(trustedRoutes, null, 2));
}

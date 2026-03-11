import { existsSync } from "node:fs";

import { DEFAULT_WEBHOOK_ROUTE_PATH } from "./webhook-route";

export type MahiloCallbackUrlSource =
  | "config"
  | "store"
  | "gateway_remote"
  | "tailscale"
  | "localhost";

export interface MahiloCallbackUrlDetectionResult {
  publicUrl: string;
  publiclyReachable: boolean;
  source: MahiloCallbackUrlSource;
}

export function detectMahiloCallbackUrl(options: {
  callbackPath?: string;
  configuredCallbackUrl?: string;
  rawContext?: unknown;
  storedCallbackUrl?: string;
}): MahiloCallbackUrlDetectionResult {
  const callbackPath = normalizeCallbackPath(options.callbackPath);
  const configuredCallbackUrl = normalizeOptionalUrl(options.configuredCallbackUrl);
  if (configuredCallbackUrl) {
    return {
      publicUrl: configuredCallbackUrl,
      publiclyReachable: isLikelyPublicCallbackUrl(configuredCallbackUrl),
      source: "config",
    };
  }

  const storedCallbackUrl = normalizeOptionalUrl(options.storedCallbackUrl);
  if (storedCallbackUrl) {
    return {
      publicUrl: storedCallbackUrl,
      publiclyReachable: isLikelyPublicCallbackUrl(storedCallbackUrl),
      source: "store",
    };
  }

  const gateway = readGatewayObject(options.rawContext);
  const remoteCallbackUrl = detectGatewayRemoteCallbackUrl(gateway, callbackPath);
  if (remoteCallbackUrl) {
    return {
      publicUrl: remoteCallbackUrl,
      publiclyReachable: isLikelyPublicCallbackUrl(remoteCallbackUrl),
      source: "gateway_remote",
    };
  }

  const tailscaleCallbackUrl = detectTailscaleCallbackUrl(gateway, callbackPath);
  if (tailscaleCallbackUrl) {
    return {
      publicUrl: tailscaleCallbackUrl,
      publiclyReachable: true,
      source: "tailscale",
    };
  }

  const port = readOptionalInteger(gateway?.port) ?? 18789;
  const localhostCallbackUrl = `http://localhost:${port}${callbackPath}`;

  return {
    publicUrl: localhostCallbackUrl,
    publiclyReachable: false,
    source: "localhost",
  };
}

export function isLikelyPublicCallbackUrl(value: string | undefined): boolean {
  const normalized = normalizeOptionalUrl(value);
  if (!normalized) {
    return false;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    ) {
      return false;
    }

    if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function detectGatewayRemoteCallbackUrl(
  gateway: Record<string, unknown> | undefined,
  callbackPath: string,
): string | undefined {
  const remote = readOptionalObject(gateway?.remote);
  const candidate =
    readOptionalString(remote?.url) ??
    readOptionalString(remote?.publicUrl) ??
    readOptionalString(remote?.public_url) ??
    readOptionalString(gateway?.publicUrl) ??
    readOptionalString(gateway?.public_url);

  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    parsed.pathname = callbackPath;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function detectTailscaleCallbackUrl(
  gateway: Record<string, unknown> | undefined,
  callbackPath: string,
): string | undefined {
  const tailscale = readOptionalObject(gateway?.tailscale);
  const mode = readOptionalString(tailscale?.mode)?.toLowerCase();
  if (mode !== "serve" && mode !== "funnel") {
    return undefined;
  }

  const hostname = getTailnetHostname();
  if (!hostname) {
    return undefined;
  }

  return `https://${hostname}${callbackPath}`;
}

function getTailnetHostname(): string | undefined {
  const candidates = [
    process.env.OPENCLAW_TEST_TAILSCALE_BINARY?.trim(),
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) {
      continue;
    }

    const result = Bun.spawnSync([candidate, "status", "--json"], {
      stderr: "pipe",
      stdout: "pipe",
      timeout: 5000,
    });
    const stdout = Buffer.from(result.stdout).toString("utf8");
    if (result.exitCode !== 0 || stdout.trim().length === 0) {
      continue;
    }

    try {
      const parsed = parsePossiblyNoisyJsonObject(stdout);
      const self = readOptionalObject(parsed.Self);
      const dnsName = readOptionalString(self?.DNSName);
      if (dnsName) {
        return dnsName.replace(/\.$/, "");
      }

      const tailscaleIps = Array.isArray(self?.TailscaleIPs)
        ? self.TailscaleIPs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : [];
      if (tailscaleIps.length > 0) {
        return tailscaleIps[0]!;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function parsePossiblyNoisyJsonObject(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }

  return JSON.parse(trimmed) as Record<string, unknown>;
}

function readGatewayObject(rawContext: unknown): Record<string, unknown> | undefined {
  const root = readOptionalObject(rawContext);
  if (!root) {
    return undefined;
  }

  const contextConfig = readOptionalObject(root.config);
  if (contextConfig) {
    const gatewayFromContext = readOptionalObject(contextConfig.gateway);
    if (gatewayFromContext) {
      return gatewayFromContext;
    }

    return contextConfig;
  }

  const gatewayFromRoot = readOptionalObject(root.gateway);
  return gatewayFromRoot ?? root;
}

function normalizeCallbackPath(value: string | undefined): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return DEFAULT_WEBHOOK_ROUTE_PATH;
  }

  return normalized.startsWith("/") ? normalized : DEFAULT_WEBHOOK_ROUTE_PATH;
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  const normalized = readOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).toString();
  } catch {
    return undefined;
  }
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  return undefined;
}

function isPrivateIpv4(hostname: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd");
}

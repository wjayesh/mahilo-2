import { config } from "../config";
import { isIP } from "net";
import { lookup } from "dns/promises";

const LOCALHOST_HOSTNAMES = new Set(["localhost"]);

function isLocalhostHostname(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(hostname);
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return octets;
}

function isLoopbackIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const octets = parseIpv4(ip);
    return !!octets && octets[0] === 127;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      return isLoopbackIp(mapped);
    }
  }
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = parseIpv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return isPrivateIpv4(mapped);
  }
  return false;
}

function isPrivateOrLoopbackIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip) || isLoopbackIp(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip) || isLoopbackIp(ip);
  }
  return false;
}

export async function validateCallbackUrl(
  urlString: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    const isLocalhost = isLocalhostHostname(hostname);
    const isLoopback = isLoopbackIp(hostname);
    const isLocalOrLoopback = isLocalhost || isLoopback;

    // Must be HTTPS (except localhost in dev)
    if (url.protocol !== "https:") {
      if (!isLocalOrLoopback || config.nodeEnv === "production") {
        return {
          valid: false,
          error: "Callback URL must use HTTPS (except localhost in development)",
        };
      }
    }

    // In development mode, allow localhost
    if (config.nodeEnv !== "production" && isLocalOrLoopback) {
      return { valid: true };
    }

    if (!config.allowPrivateIps) {
      // Block localhost and .local domains in production
      if (config.nodeEnv === "production") {
        if (isLocalOrLoopback || hostname.endsWith(".local")) {
          return {
            valid: false,
            error: "Callback URL cannot point to localhost in production",
          };
        }
      }

      // Block private/loopback IP literals
      if (isIP(hostname) && isPrivateOrLoopbackIp(hostname)) {
        return {
          valid: false,
          error: "Callback URL cannot point to private/internal addresses",
        };
      }

      // In production, resolve hostname and block private/loopback targets
      if (config.nodeEnv === "production" && !isIP(hostname)) {
        try {
          const records = await lookup(hostname, { all: true });
          if (records.some((r) => isPrivateOrLoopbackIp(r.address))) {
            return {
              valid: false,
              error: "Callback URL cannot point to private/internal addresses",
            };
          }
        } catch {
          return { valid: false, error: "Callback hostname could not be resolved" };
        }
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

export function normalizeCapabilities(
  input?: string[] | string
): { valid: boolean; value: string; error?: string } {
  if (input === undefined) {
    return { valid: true, value: JSON.stringify([]) };
  }

  if (Array.isArray(input)) {
    return { valid: true, value: JSON.stringify(input) };
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return { valid: true, value: JSON.stringify(parsed) };
      }
    } catch {
      // Fall through to error below.
    }
    return { valid: false, error: "capabilities must be a JSON array of strings" };
  }

  return { valid: false, error: "capabilities must be an array of strings" };
}

export function parseCapabilities(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === "string");
    }
    return [];
  } catch {
    return [];
  }
}

export function validatePayloadSize(payload: string): { valid: boolean; error?: string } {
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > config.maxPayloadSize) {
    return {
      valid: false,
      error: `Payload exceeds maximum size of ${config.maxPayloadSize} bytes`,
    };
  }
  return { valid: true };
}

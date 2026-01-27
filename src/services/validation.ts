import { config } from "../config";

// Private IP ranges to block (except localhost which is handled separately)
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^fc00:/i,
  /^fd00:/i,
  /^fe80:/i,
  /^::1$/,
];

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function validateCallbackUrl(urlString: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    const isLocalhostUrl = isLocalhost(hostname);

    // Must be HTTPS (except localhost in dev)
    if (url.protocol !== "https:") {
      if (!isLocalhostUrl || config.nodeEnv === "production") {
        return {
          valid: false,
          error: "Callback URL must use HTTPS (except localhost in development)",
        };
      }
    }

    // In development mode, allow localhost
    if (config.nodeEnv !== "production" && isLocalhostUrl) {
      return { valid: true };
    }

    // Block private IPs in hosted mode
    if (!config.allowPrivateIps) {
      // Check against private IP patterns
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          return {
            valid: false,
            error: "Callback URL cannot point to private/internal addresses",
          };
        }
      }

      // Block localhost and .local domains in production
      if (config.nodeEnv === "production") {
        if (isLocalhostUrl || hostname.endsWith(".local")) {
          return {
            valid: false,
            error: "Callback URL cannot point to localhost in production",
          };
        }
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
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

import { MahiloContractClient } from "./client";
import type { MahiloClientOptions } from "./client";
import { MAHILO_CONTRACT_VERSION } from "./contract";

export type ReviewMode = "auto" | "ask" | "manual";

export interface MahiloPluginConfig {
  apiKey: string;
  baseUrl: string;
  cacheTtlSeconds: number;
  callbackPath?: string;
  callbackUrl?: string;
  contractVersion: string;
  pluginVersion: string;
  reviewMode: ReviewMode;
}

export interface ParseConfigOptions {
  defaults?: Partial<Pick<MahiloPluginConfig, "cacheTtlSeconds" | "contractVersion" | "pluginVersion" | "reviewMode">>;
}

const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_PLUGIN_VERSION = "0.0.0";
const DEFAULT_REVIEW_MODE: ReviewMode = "ask";
const REVIEW_MODES = new Set<ReviewMode>(["auto", "ask", "manual"]);
const ALLOWED_PLUGIN_CONFIG_KEYS = new Set<string>([
  "apiKey",
  "baseUrl",
  "cacheTtlSeconds",
  "callbackPath",
  "callbackUrl",
  "reviewMode"
]);
const LEGACY_SERVER_OWNED_KEYS = new Set<string>([
  "callbackSecret",
  "contractVersion",
  "pluginVersion"
]);

export class MahiloConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MahiloConfigError";
  }
}

export function parseMahiloPluginConfig(rawConfig: unknown, options: ParseConfigOptions = {}): MahiloPluginConfig {
  const config = readObject(rawConfig);
  assertSupportedConfigKeys(config);
  const defaults = options.defaults ?? {};

  const baseUrl = normalizeBaseUrl(readRequiredString(config, "baseUrl"));
  const apiKey = readRequiredString(config, "apiKey");
  const callbackPath = readOptionalCallbackPath(config.callbackPath);
  const callbackUrl = readOptionalUrl(config.callbackUrl, "callbackUrl");

  const cacheTtlSeconds = parseCacheTtlSeconds(
    config.cacheTtlSeconds,
    defaults.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS
  );
  const reviewMode = parseReviewMode(config.reviewMode, defaults.reviewMode ?? DEFAULT_REVIEW_MODE);
  const contractVersion = defaults.contractVersion ?? MAHILO_CONTRACT_VERSION;
  const pluginVersion = defaults.pluginVersion ?? DEFAULT_PLUGIN_VERSION;

  return {
    apiKey,
    baseUrl,
    cacheTtlSeconds,
    callbackPath,
    callbackUrl,
    contractVersion,
    pluginVersion,
    reviewMode
  };
}

export function createClientOptionsFromConfig(config: MahiloPluginConfig): MahiloClientOptions {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    contractVersion: config.contractVersion,
    pluginVersion: config.pluginVersion
  };
}

export function createMahiloClientFromConfig(config: MahiloPluginConfig): MahiloContractClient {
  return new MahiloContractClient(createClientOptionsFromConfig(config));
}

export function redactSensitiveConfig(config: MahiloPluginConfig): Record<string, unknown> {
  return {
    ...config,
    apiKey: maskSecret(config.apiKey)
  };
}

function assertSupportedConfigKeys(config: Record<string, unknown>): void {
  const unsupportedKeys = Object.keys(config)
    .filter((key) => !ALLOWED_PLUGIN_CONFIG_KEYS.has(key))
    .sort();

  if (unsupportedKeys.length === 0) {
    return;
  }

  const legacyKeys = unsupportedKeys.filter((key) => LEGACY_SERVER_OWNED_KEYS.has(key));
  const baseMessage = `unsupported plugin config key(s): ${unsupportedKeys.join(", ")}`;

  if (legacyKeys.length > 0) {
    throw new MahiloConfigError(
      `${baseMessage}. Server-owned/deprecated keys are not allowed in plugin config: ${legacyKeys.join(", ")}`
    );
  }

  throw new MahiloConfigError(baseMessage);
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MahiloConfigError("plugin config must be an object");
  }

  return value as Record<string, unknown>;
}

function readRequiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MahiloConfigError(`${key} must be a non-empty string`);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readOptionalCallbackPath(value: unknown): string | undefined {
  const callbackPath = readOptionalString(value);
  if (!callbackPath) {
    return undefined;
  }

  if (!callbackPath.startsWith("/")) {
    throw new MahiloConfigError("callbackPath must start with '/'");
  }

  if (/\s/.test(callbackPath)) {
    throw new MahiloConfigError("callbackPath must not contain whitespace");
  }

  return callbackPath;
}

function parseCacheTtlSeconds(value: unknown, fallback: number): number {
  const parsed = Number.isInteger(value) ? Number(value) : fallback;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MahiloConfigError("cacheTtlSeconds must be a non-negative integer");
  }

  return parsed;
}

function parseReviewMode(value: unknown, fallback: ReviewMode): ReviewMode {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase() as ReviewMode;
  if (!REVIEW_MODES.has(normalized)) {
    throw new MahiloConfigError(`reviewMode must be one of: ${Array.from(REVIEW_MODES).join(", ")}`);
  }

  return normalized;
}

function normalizeBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MahiloConfigError("baseUrl must be a valid absolute URL");
  }

  return parsed.toString().replace(/\/$/, "");
}

function readOptionalUrl(value: unknown, key: string): string | undefined {
  const candidate = readOptionalString(value);
  if (!candidate) {
    return undefined;
  }

  try {
    return new URL(candidate).toString();
  } catch {
    throw new MahiloConfigError(`${key} must be a valid absolute URL`);
  }
}

function maskSecret(value: string): string {
  if (value.length <= 4) {
    return "****";
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

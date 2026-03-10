import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BOOTSTRAP_FILE_VERSION = 1;
const BOOTSTRAP_PATH_ENV_KEY = "MAHILO_OPENCLAW_RUNTIME_STATE_PATH";
const DEFAULT_BOOTSTRAP_FILE_NAME = "openclaw-plugin-runtime.json";

export interface MahiloRuntimeBootstrapState {
  apiKey?: string;
  callbackConnectionId?: string;
  callbackSecret?: string;
  callbackUrl?: string;
  updatedAt: string;
  username?: string;
}

export interface MahiloRuntimeBootstrapPatch {
  apiKey?: string | null;
  callbackConnectionId?: string | null;
  callbackSecret?: string | null;
  callbackUrl?: string | null;
  username?: string | null;
}

export interface MahiloRuntimeBootstrapStoreOptions {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  path?: string;
}

interface MahiloRuntimeBootstrapFile {
  servers: Record<string, MahiloRuntimeBootstrapState>;
  version: number;
}

export class MahiloRuntimeBootstrapStore {
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly path: string;

  constructor(options: MahiloRuntimeBootstrapStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.path = options.path ?? resolveMahiloRuntimeBootstrapPath({ env: this.env });
  }

  clear(baseUrl: string): void {
    const normalizedBaseUrl = normalizeBaseUrlKey(baseUrl);
    if (!normalizedBaseUrl) {
      return;
    }

    const file = this.readFile();
    if (!file || !(normalizedBaseUrl in file.servers)) {
      return;
    }

    delete file.servers[normalizedBaseUrl];

    if (Object.keys(file.servers).length === 0) {
      rmSync(this.path, { force: true });
      return;
    }

    this.writeFile(file);
  }

  getPath(): string {
    return this.path;
  }

  read(baseUrl: string): MahiloRuntimeBootstrapState | null {
    const normalizedBaseUrl = normalizeBaseUrlKey(baseUrl);
    if (!normalizedBaseUrl) {
      return null;
    }

    const file = this.readFile();
    if (!file) {
      return null;
    }

    const entry = file.servers[normalizedBaseUrl];
    return entry ? normalizeState(entry) : null;
  }

  write(baseUrl: string, patch: MahiloRuntimeBootstrapPatch): MahiloRuntimeBootstrapState {
    const normalizedBaseUrl = normalizeBaseUrlKey(baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error("baseUrl is required to persist Mahilo runtime bootstrap state");
    }

    const file = this.readFile() ?? {
      servers: {},
      version: BOOTSTRAP_FILE_VERSION,
    };
    const existing = normalizeState(file.servers[normalizedBaseUrl]) ?? null;
    const nextState = normalizeState(mergeRuntimeState(existing, patch, this.now().toISOString()));

    if (!nextState) {
      throw new Error("Mahilo runtime bootstrap state could not be normalized");
    }

    file.servers[normalizedBaseUrl] = nextState;
    this.writeFile(file);
    return nextState;
  }

  private readFile(): MahiloRuntimeBootstrapFile | null {
    let rawText: string;
    try {
      rawText = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      return null;
    }

    const root = readObject(parsed);
    if (!root) {
      return null;
    }

    const servers = readObject(root.servers) ?? {};
    const normalizedServers: Record<string, MahiloRuntimeBootstrapState> = {};

    for (const [serverKey, value] of Object.entries(servers)) {
      const normalizedKey = normalizeBaseUrlKey(serverKey);
      const normalizedState = normalizeState(value);
      if (!normalizedKey || !normalizedState) {
        continue;
      }

      normalizedServers[normalizedKey] = normalizedState;
    }

    return {
      servers: normalizedServers,
      version:
        typeof root.version === "number" && Number.isFinite(root.version)
          ? root.version
          : BOOTSTRAP_FILE_VERSION,
    };
  }

  private writeFile(file: MahiloRuntimeBootstrapFile): void {
    mkdirSync(dirname(this.path), {
      mode: 0o700,
      recursive: true,
    });
    writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export function resolveMahiloRuntimeBootstrapPath(
  options: Pick<MahiloRuntimeBootstrapStoreOptions, "env" | "path"> = {},
): string {
  if (typeof options.path === "string" && options.path.trim().length > 0) {
    return options.path.trim();
  }

  const env = options.env ?? process.env;
  const override = readNonEmptyString(env[BOOTSTRAP_PATH_ENV_KEY]);
  if (override) {
    return override;
  }

  const configHome =
    readNonEmptyString(env.XDG_CONFIG_HOME) ??
    readNonEmptyString(env.APPDATA) ??
    join(homedir(), ".config");

  return join(configHome, "mahilo", DEFAULT_BOOTSTRAP_FILE_NAME);
}

function normalizeBaseUrlKey(value: string): string | undefined {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    return undefined;
  }

  try {
    return new URL(normalized).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function normalizeState(value: unknown): MahiloRuntimeBootstrapState | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  const updatedAt = readNonEmptyString(root.updatedAt) ?? new Date(0).toISOString();
  return {
    apiKey: readNonEmptyString(root.apiKey),
    callbackConnectionId: readNonEmptyString(root.callbackConnectionId),
    callbackSecret: readNonEmptyString(root.callbackSecret),
    callbackUrl: readNonEmptyString(root.callbackUrl),
    updatedAt,
    username: readNonEmptyString(root.username),
  };
}

function mergeRuntimeState(
  existing: MahiloRuntimeBootstrapState | null,
  patch: MahiloRuntimeBootstrapPatch,
  updatedAt: string,
): MahiloRuntimeBootstrapState {
  const nextState: MahiloRuntimeBootstrapState = {
    apiKey: existing?.apiKey,
    callbackConnectionId: existing?.callbackConnectionId,
    callbackSecret: existing?.callbackSecret,
    callbackUrl: existing?.callbackUrl,
    updatedAt,
    username: existing?.username,
  };

  if ("apiKey" in patch) {
    nextState.apiKey = patch.apiKey ?? undefined;
  }
  if ("callbackConnectionId" in patch) {
    nextState.callbackConnectionId = patch.callbackConnectionId ?? undefined;
  }
  if ("callbackSecret" in patch) {
    nextState.callbackSecret = patch.callbackSecret ?? undefined;
  }
  if ("callbackUrl" in patch) {
    nextState.callbackUrl = patch.callbackUrl ?? undefined;
  }
  if ("username" in patch) {
    nextState.username = patch.username ?? undefined;
  }

  return nextState;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

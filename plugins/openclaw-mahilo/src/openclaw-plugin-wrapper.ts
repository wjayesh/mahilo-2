import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  type MahiloPluginConfig,
} from "./config";
import {
  detectMahiloCallbackUrl,
  isLikelyPublicCallbackUrl,
} from "./callback-url";
import {
  MAHILO_RUNTIME_PLUGIN_DESCRIPTION,
  MAHILO_RUNTIME_PLUGIN_ID,
  MAHILO_RUNTIME_PLUGIN_NAME,
} from "./identity";
import {
  registerMahiloOpenClawPlugin as registerLegacyMahiloOpenClawPlugin,
  type MahiloOpenClawPluginDefinition,
  type MahiloOpenClawPluginOptions as LegacyMahiloOpenClawPluginOptions,
} from "./openclaw-plugin";
import { registerMahiloOperatorCommand } from "./commands";
import {
  MahiloContractClient,
  MahiloRequestError,
  type MahiloAgentConnectionSummary,
} from "./client";
import { MahiloRuntimeBootstrapStore } from "./runtime-bootstrap";
import {
  MahiloSenderResolver,
  registerMahiloAgentConnection,
  type MahiloSetupSummary,
} from "./sender-resolution";
import { DEFAULT_WEBHOOK_ROUTE_PATH } from "./webhook-route";

export type { MahiloOpenClawPluginDefinition } from "./openclaw-plugin";

export interface MahiloOpenClawPluginOptions extends LegacyMahiloOpenClawPluginOptions {
  runtimeBootstrapStore?: MahiloRuntimeBootstrapStore;
}

type CommandRegistrationMode =
  | { kind: "object" }
  | {
      kind: "name-description-handler";
      metadataStyle: "definition" | "none" | "schema";
    }
  | {
      kind: "name-handler";
      metadataStyle: "definition" | "none" | "schema";
    };

interface CommandDefinitionLike {
  acceptsArgs?: boolean;
  description: string;
  execute: (...args: unknown[]) => unknown;
  handler?: (...args: unknown[]) => unknown;
  label: string;
  name: string;
  parameters?: unknown;
  requireAuth?: boolean;
  run?: (...args: unknown[]) => unknown;
}

type MahiloCredentialSource = "config" | "fresh_registration" | "store";
type MahiloCallbackSecretSource = "options" | "registration" | "store";

interface MahiloSetupBlocker {
  kind: "callback_readiness" | "identity" | "sender_attachment";
  message: string;
  nextAction: string;
  operatorOwned: boolean;
}

interface MahiloSetupCallbackStatus {
  path: string;
  publicUrl?: string;
  ready: boolean;
  secretAvailable: boolean;
  secretSource?: MahiloCallbackSecretSource;
}

interface MahiloSetupSenderRegistration {
  attempted: boolean;
  callbackSecretStored: boolean;
  callbackUrl?: string;
  connectionId?: string;
  created?: boolean;
  error?: string;
  updated?: boolean;
}

interface MahiloSetupIdentityBootstrap {
  created: boolean;
  registration: unknown;
}

interface MahiloSetupResultDetails {
  blocker: MahiloSetupBlocker | null;
  callback: MahiloSetupCallbackStatus;
  credentialSource: MahiloCredentialSource | null;
  identityBootstrap: MahiloSetupIdentityBootstrap | null;
  notes: string[];
  senderRegistration: MahiloSetupSenderRegistration | null;
  status: "blocked" | "error" | "success";
  summary?: MahiloSetupSummary;
}

interface MahiloCommandRouterState {
  registered: boolean;
  subcommands: Map<string, CommandDefinitionLike>;
}

const AUTO_SENDER_COMMAND_NAMES = new Set<string>();
const AUTO_SENDER_TOOL_NAMES = new Set([
  "ask_network",
  "send_message",
  "set_boundaries",
]);
const MAHILO_OPERATOR_COMMAND_NAME = "mahilo";
const SETUP_MANAGED_SENDER_DESCRIPTION =
  "Default Mahilo sender registered by the OpenClaw plugin for in-product ask-around replies and review flows.";
const SETUP_MANAGED_SENDER_FRAMEWORK = "openclaw";
const SETUP_MANAGED_SENDER_LABEL = "default";

export function createMahiloOpenClawPlugin(
  options: MahiloOpenClawPluginOptions = {},
): MahiloOpenClawPluginDefinition {
  return {
    description: MAHILO_RUNTIME_PLUGIN_DESCRIPTION,
    id: MAHILO_RUNTIME_PLUGIN_ID,
    name: MAHILO_RUNTIME_PLUGIN_NAME,
    register: (api) => {
      registerMahiloOpenClawPlugin(api, options);
    },
  };
}

export function registerMahiloOpenClawPlugin(
  api: OpenClawPluginApi,
  options: MahiloOpenClawPluginOptions = {},
): void {
  const config = parseMahiloPluginConfig(api.pluginConfig ?? {}, {
    defaults: {
      pluginVersion:
        readOptionalString(
          (api as unknown as Record<string, unknown>).version,
        ) ?? "unknown",
    },
    requireApiKey: false,
  });
  const runtimeBootstrapStore =
    options.runtimeBootstrapStore ?? new MahiloRuntimeBootstrapStore();
  const bootstrapState = runtimeBootstrapStore.read(config.baseUrl);
  const credentialSource = resolveCredentialSource(config, bootstrapState);
  const effectiveApiKey = resolveEffectiveApiKey(config, bootstrapState);
  const effectiveConfig = effectiveApiKey
    ? { ...config, apiKey: effectiveApiKey }
    : config;
  const createClient =
    options.createClient ??
    ((nextConfig: MahiloPluginConfig) =>
      nextConfig.apiKey
        ? createMahiloClientFromConfig(nextConfig)
        : createBootstrapSetupClient(nextConfig));
  const senderResolver = new MahiloSenderResolver();
  const registeredCommandNames = new Set<string>();
  const callbackSecretResolver = createCallbackSecretResolver(
    config.baseUrl,
    runtimeBootstrapStore,
    options,
  );
  const activeClient = createRuntimeAwareClient(
    config,
    runtimeBootstrapStore,
    createClient,
  );
  const commandRouterState: MahiloCommandRouterState = {
    registered: false,
    subcommands: new Map(),
  };

  let commandRegistrationMode: CommandRegistrationMode | null = null;
  const originalRegisterCommand =
    typeof (api as unknown as Record<string, unknown>).registerCommand ===
    "function"
      ? ((api as unknown as Record<string, unknown>).registerCommand as (
          ...args: unknown[]
        ) => unknown)
      : null;
  const originalRegisterTool = api.registerTool.bind(api);
  const wrappedRegisterCommand =
    originalRegisterCommand === null
      ? undefined
      : function (
          nameOrDefinition: unknown,
          maybeExecute?: unknown,
          maybeMetadata?: unknown,
          ...rest: unknown[]
        ) {
          const args = [nameOrDefinition, maybeExecute, maybeMetadata, ...rest];
          if (commandRegistrationMode === null) {
            commandRegistrationMode = detectCommandRegistrationMode(args);
          }

          const commandName = readRegisteredCommandName(args);
          if (commandName) {
            registeredCommandNames.add(commandName);
          }

          const patchedArgs = patchCommandRegistrationArgs(
            args,
            activeClient,
            senderResolver,
          );
          if (
            registerObjectModeMahiloCommand(
              api,
              originalRegisterCommand,
              commandRouterState,
              patchedArgs,
            )
          ) {
            return;
          }
          return originalRegisterCommand.apply(api, patchedArgs);
        };

  if (wrappedRegisterCommand && originalRegisterCommand) {
    try {
      Object.defineProperty(wrappedRegisterCommand, "length", {
        configurable: true,
        value: originalRegisterCommand.length,
      });
    } catch {
      // Preserve legacy registration behavior when possible, but do not fail plugin startup if the runtime locks function metadata.
    }

    try {
      Object.defineProperty(wrappedRegisterCommand, "__mahiloObjectStyle", {
        configurable: true,
        value: originalRegisterCommand.length < 2,
      });
    } catch {
      // Best-effort only; command registration still has runtime fallbacks.
    }
  }

  const wrappedApi = Object.create(api) as OpenClawPluginApi;
  wrappedApi.pluginConfig = buildPluginConfigInput(effectiveConfig);
  wrappedApi.registerCommand =
    wrappedRegisterCommand ??
    (api.registerCommand as OpenClawPluginApi["registerCommand"]);
  wrappedApi.registerTool = (tool: AnyAgentTool) =>
    originalRegisterTool(
      patchToolDefinition(tool, activeClient, senderResolver),
    );

  registerLegacyMahiloOpenClawPlugin(wrappedApi, {
    ...options,
    createClient,
    webhookRoute: {
      ...options.webhookRoute,
      getCallbackSecret: callbackSecretResolver,
    },
  });

  const registerService =
    typeof (api as unknown as Record<string, unknown>).registerService ===
    "function"
      ? ((api as unknown as Record<string, unknown>)
          .registerService as (service: {
          id: string;
          start: (ctx: unknown) => Promise<void> | void;
        }) => void)
      : null;

  if (registerService) {
    registerService(
      createStartupBootstrapService({
        callbackSecretResolver,
        config,
        createClient,
        runtimeBootstrapStore,
        senderResolver,
      }),
    );
  }

  if (originalRegisterCommand && !registeredCommandNames.has("mahilo setup")) {
    registerSetupCommand(
      wrappedApi,
      originalRegisterCommand,
      commandRegistrationMode,
      createSetupCommand({
        callbackSecretResolver,
        config,
        createClient,
        credentialSource,
        runtimeContext: (api as unknown as Record<string, unknown>).config,
        runtimeBootstrapStore,
        senderResolver,
      }),
    );
  }
}

const defaultMahiloOpenClawPlugin = createMahiloOpenClawPlugin();

export default defaultMahiloOpenClawPlugin;

function buildCommandMetadata(
  definition: CommandDefinitionLike,
  metadataStyle: "definition" | "none" | "schema",
): unknown {
  if (metadataStyle === "none") {
    return undefined;
  }

  if (metadataStyle === "schema") {
    return definition.parameters;
  }

  return {
    description: definition.description,
    label: definition.label,
    parameters: definition.parameters,
  };
}

function readRegisteredCommandName(args: unknown[]): string | undefined {
  if (args.length === 1 && isRecord(args[0])) {
    return readOptionalString(args[0].name);
  }

  return typeof args[0] === "string" ? args[0] : undefined;
}

interface CreateSetupCommandOptions {
  callbackSecretResolver: () => Promise<string | undefined>;
  config: MahiloPluginConfig;
  createClient: (config: MahiloPluginConfig) => MahiloContractClient;
  credentialSource: MahiloCredentialSource | null;
  runtimeContext?: unknown;
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore;
  senderResolver: MahiloSenderResolver;
}

interface CreateStartupBootstrapServiceOptions {
  callbackSecretResolver: () => Promise<string | undefined>;
  config: MahiloPluginConfig;
  createClient: (config: MahiloPluginConfig) => MahiloContractClient;
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore;
  senderResolver: MahiloSenderResolver;
}

function buildSetupSummaryText(
  details: MahiloSetupResultDetails,
  expectedUsername?: string,
): string {
  const summary = details.summary;
  const username = summary?.identity?.username
    ? `@${summary.identity.username}`
    : "your Mahilo identity";
  const sender = summary?.sender?.connectionId;

  const usernameMismatch =
    expectedUsername &&
    summary?.identity?.username &&
    expectedUsername !== summary.identity.username;
  const mismatchSuffix = usernameMismatch
    ? ` Expected username @${expectedUsername}, but Mahilo reported @${summary?.identity?.username}.`
    : "";
  const lead = details.identityBootstrap?.created
    ? `Mahilo created ${username}`
    : summary?.connectivity.identityOk
      ? `Mahilo setup attached ${username}`
      : "Mahilo setup could not confirm a Mahilo identity";

  if (details.blocker) {
    if (sender) {
      return `${lead} and selected sender ${sender}, but ${details.blocker.message} ${details.blocker.nextAction}${mismatchSuffix}`;
    }

    return `${lead}, but ${details.blocker.message} ${details.blocker.nextAction}${mismatchSuffix}`;
  }

  const bootstrapSuffix = details.identityBootstrap?.created
    ? " The issued API key was saved in the local Mahilo runtime store, so you do not need to copy it into plugin config."
    : "";
  const callbackSuffix =
    details.callback.ready && details.callback.publicUrl
      ? ` Callback readiness passed at ${details.callback.publicUrl}.`
      : "";

  return `${lead}, selected sender ${sender}, and kept ${summary?.defaultBoundaries.reviewMode ?? "ask"} review boundaries in place. Connectivity checks passed.${callbackSuffix}${bootstrapSuffix}${mismatchSuffix}`;
}

function createSetupCommand(
  options: CreateSetupCommandOptions,
): CommandDefinitionLike {
  return {
    description:
      "Attach the current Mahilo identity, choose a default sender connection, and run connectivity checks from inside OpenClaw.",
    execute: async (rawInput?: unknown) => {
      const input = readInputObject(rawInput) ?? {};
      const expectedUsername = readOptionalString(input.username);
      const inviteToken =
        readOptionalString(input.inviteToken) ??
        readOptionalString(input.invite_token);
      const displayName =
        readOptionalString(input.displayName) ??
        readOptionalString(input.display_name);
      const preferredSenderConnectionId = readSenderConnectionId(input);
      const ping = readOptionalBoolean(input.ping) ?? true;
      const runtimeState = options.runtimeBootstrapStore.read(
        options.config.baseUrl,
      );
      const setupConfig = await resolveBootstrapConfig(
        options.config,
        runtimeState,
        options.runtimeContext,
      );

      const details = await runMahiloSetup({
        callbackSecretResolver: options.callbackSecretResolver,
        config: setupConfig,
        createClient: options.createClient,
        credentialSource: options.credentialSource,
        displayName,
        expectedUsername,
        inviteToken,
        ping,
        preferredSenderConnectionId,
        runtimeBootstrapStore: options.runtimeBootstrapStore,
        senderResolver: options.senderResolver,
      });

      const usernameMismatch =
        expectedUsername &&
        details.summary?.identity?.username &&
        expectedUsername !== details.summary.identity.username;

      return toCommandResult(buildSetupSummaryText(details, expectedUsername), {
        blocker: details.blocker,
        callback: details.callback,
        command: "mahilo setup",
        credentialSource: details.credentialSource,
        error: details.status === "error" ? (details.notes[0] ?? null) : null,
        expectedUsername: expectedUsername ?? null,
        identityBootstrap: details.identityBootstrap,
        notes: usernameMismatch
          ? [
              `Expected username @${expectedUsername}, but Mahilo reported @${details.summary?.identity?.username}.`,
              ...details.notes,
            ]
          : details.notes,
        senderRegistration: details.senderRegistration,
        status: details.status,
        summary: details.summary ?? null,
        usernameConfirmed: !usernameMismatch,
      });
    },
    label: "Mahilo Setup",
    name: "mahilo setup",
    parameters: {
      additionalProperties: false,
      properties: {
        ping: {
          default: true,
          description:
            "Run a sender connectivity ping after the default sender is selected.",
          type: "boolean",
        },
        display_name: {
          description:
            "Optional display name used only when Mahilo needs to bootstrap a new identity.",
          type: "string",
        },
        displayName: {
          description:
            "Optional display name used only when Mahilo needs to bootstrap a new identity.",
          type: "string",
        },
        invite_token: {
          description:
            "One-time Mahilo invite token required when setup needs to bootstrap a new identity.",
          type: "string",
        },
        inviteToken: {
          description:
            "One-time Mahilo invite token required when setup needs to bootstrap a new identity.",
          type: "string",
        },
        sender_connection_id: {
          description:
            "Optional sender connection to pin as the plugin default.",
          type: "string",
        },
        senderConnectionId: {
          description:
            "Optional sender connection to pin as the plugin default.",
          type: "string",
        },
        username: {
          description:
            "Username to confirm against the attached Mahilo identity. Required the first time when Mahilo needs to bootstrap a new identity.",
          type: "string",
        },
      },
      type: "object",
    },
  };
}

function createStartupBootstrapService(
  options: CreateStartupBootstrapServiceOptions,
): {
  id: string;
  start: (ctx: unknown) => Promise<void>;
} {
  return {
    id: "mahilo-auto-register",
    start: async (rawContext: unknown) => {
      const runtimeState = options.runtimeBootstrapStore.read(
        options.config.baseUrl,
      );
      const credentialSource = resolveCredentialSource(
        options.config,
        runtimeState,
      );
      const apiKey = resolveEffectiveApiKey(options.config, runtimeState);
      if (!apiKey) {
        return;
      }

      const serviceConfig = await resolveBootstrapConfig(
        {
          ...options.config,
          apiKey,
        },
        runtimeState,
        rawContext,
      );
      const details = await runMahiloSetup({
        callbackSecretResolver: options.callbackSecretResolver,
        config: serviceConfig,
        createClient: options.createClient,
        credentialSource,
        ping: true,
        runtimeBootstrapStore: options.runtimeBootstrapStore,
        senderResolver: options.senderResolver,
      });
      const logger = readOptionalObject(rawContext)?.logger as
        | {
            info?: (message: string) => void;
            warn?: (message: string) => void;
          }
        | undefined;

      if (details.status === "success") {
        logger?.info?.(
          `[Mahilo] Startup bootstrap attached ${details.summary?.identity?.username ? `@${details.summary.identity.username}` : "the current identity"} and sender ${details.summary?.sender?.connectionId ?? "unknown"}.`,
        );
        return;
      }

      if (details.blocker) {
        logger?.warn?.(
          `[Mahilo] Startup bootstrap incomplete: ${details.blocker.message} ${details.blocker.nextAction}`,
        );
        return;
      }

      const note = details.notes[0];
      if (note) {
        logger?.warn?.(`[Mahilo] Startup bootstrap failed: ${note}`);
      }
    },
  };
}

interface RunMahiloSetupOptions {
  callbackSecretResolver: () => Promise<string | undefined>;
  config: MahiloPluginConfig;
  createClient: (config: MahiloPluginConfig) => MahiloContractClient;
  credentialSource: MahiloCredentialSource | null;
  displayName?: string;
  expectedUsername?: string;
  inviteToken?: string;
  ping: boolean;
  preferredSenderConnectionId?: string;
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore;
  senderResolver: MahiloSenderResolver;
}

async function runMahiloSetup(
  options: RunMahiloSetupOptions,
): Promise<MahiloSetupResultDetails> {
  let credentialSource = options.credentialSource;
  let identityBootstrap: MahiloSetupIdentityBootstrap | null = null;
  let senderRegistration: MahiloSetupSenderRegistration | null = null;
  let callback = buildPendingCallbackStatus(
    options.config,
    options.runtimeBootstrapStore.read(options.config.baseUrl),
  );

  let apiKey = resolveEffectiveApiKey(
    options.config,
    options.runtimeBootstrapStore.read(options.config.baseUrl),
  );

  if (!apiKey) {
    if (!options.expectedUsername || !options.inviteToken) {
      const blocker = buildIdentityBootstrapBlocker({
        missingInviteToken: !options.inviteToken,
        missingUsername: !options.expectedUsername,
      });
      return {
        blocker,
        callback,
        credentialSource,
        identityBootstrap,
        notes: [blocker.nextAction],
        senderRegistration,
        status: "blocked",
      };
    }

    try {
      const bootstrapClient = options.createClient({
        ...options.config,
        apiKey: undefined,
      });
      const registration = await bootstrapClient.registerIdentity({
        displayName: options.displayName,
        inviteToken: options.inviteToken,
        username: options.expectedUsername,
      });
      const issuedApiKey = readFirstStringFromUnknown(registration, [
        "api_key",
        "apiKey",
      ]);

      if (!issuedApiKey) {
        throw new Error(
          "Mahilo identity registration did not return an api_key",
        );
      }

      options.runtimeBootstrapStore.write(options.config.baseUrl, {
        apiKey: issuedApiKey,
        username:
          readFirstStringFromUnknown(registration, ["username"]) ??
          options.expectedUsername,
      });
      apiKey = issuedApiKey;
      credentialSource = "fresh_registration";
      identityBootstrap = {
        created: true,
        registration,
      };
    } catch (error) {
      const blocker = buildIdentityRegistrationFailureBlocker(error);
      return {
        blocker,
        callback,
        credentialSource,
        identityBootstrap,
        notes: [blocker.nextAction],
        senderRegistration,
        status: blocker.operatorOwned ? "blocked" : "error",
      };
    }
  }

  const client = options.createClient({
    ...options.config,
    apiKey,
  });

  if (options.preferredSenderConnectionId) {
    options.senderResolver.rememberPreferredSender(
      options.preferredSenderConnectionId,
    );
  }

  try {
    const ensuredSender = await ensureManagedSetupSender({
      callbackSecretResolver: options.callbackSecretResolver,
      client,
      config: options.config,
      preferredSenderConnectionId: options.preferredSenderConnectionId,
      runtimeBootstrapStore: options.runtimeBootstrapStore,
      senderResolver: options.senderResolver,
    });
    senderRegistration = ensuredSender.senderRegistration;
    const summary = await options.senderResolver.runSetup(
      client,
      {
        ...options.config,
        apiKey,
      },
      {
        ping: options.ping,
        preferredSenderConnectionId:
          ensuredSender.preferredSenderConnectionId ??
          options.preferredSenderConnectionId,
      },
    );

    callback = buildCallbackStatus(
      options.config,
      options.runtimeBootstrapStore.read(options.config.baseUrl),
      summary,
      ensuredSender.callbackSecretAvailable,
      ensuredSender.callbackUrl,
    );

    const blocker = determineSetupBlocker({
      callback,
      config: options.config,
      credentialSource,
      senderRegistration,
      summary,
    });

    return {
      blocker,
      callback,
      credentialSource,
      identityBootstrap,
      notes: buildSetupNotes(
        summary,
        callback,
        senderRegistration,
        blocker,
        identityBootstrap,
      ),
      senderRegistration,
      status: blocker ? "blocked" : "success",
      summary,
    };
  } catch (error) {
    const blocker = buildSetupFailureBlocker(error, credentialSource);
    return {
      blocker,
      callback,
      credentialSource,
      identityBootstrap,
      notes: [blocker.nextAction],
      senderRegistration,
      status: "error",
    };
  }
}

interface EnsureManagedSetupSenderOptions {
  callbackSecretResolver: () => Promise<string | undefined>;
  client: MahiloContractClient;
  config: MahiloPluginConfig;
  preferredSenderConnectionId?: string;
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore;
  senderResolver: MahiloSenderResolver;
}

interface EnsureManagedSetupSenderResult {
  callbackSecretAvailable: boolean;
  callbackUrl?: string;
  preferredSenderConnectionId?: string;
  senderRegistration: MahiloSetupSenderRegistration | null;
}

async function ensureManagedSetupSender(
  options: EnsureManagedSetupSenderOptions,
): Promise<EnsureManagedSetupSenderResult> {
  if (options.preferredSenderConnectionId) {
    return {
      callbackSecretAvailable: Boolean(await options.callbackSecretResolver()),
      callbackUrl: resolveStoredOrConfiguredCallbackUrl(
        options.config,
        options.runtimeBootstrapStore.read(options.config.baseUrl),
      ),
      preferredSenderConnectionId: options.preferredSenderConnectionId,
      senderRegistration: null,
    };
  }

  const inspection = await options.senderResolver.inspect(options.client, {
    refresh: true,
  });
  const runtimeState = options.runtimeBootstrapStore.read(
    options.config.baseUrl,
  );
  const managedConnection = findManagedSetupConnection(inspection.connections);
  const callbackUrl = resolveManagedCallbackUrl(
    options.config,
    runtimeState,
    managedConnection,
  );
  const currentSecret = await options.callbackSecretResolver();

  if (managedConnection) {
    options.senderResolver.rememberPreferredSender(managedConnection.id);
  }

  if (!callbackUrl) {
    return {
      callbackSecretAvailable: Boolean(currentSecret),
      callbackUrl,
      preferredSenderConnectionId: managedConnection?.id,
      senderRegistration: null,
    };
  }

  const needsSecretRotation =
    !currentSecret ||
    runtimeState?.callbackConnectionId !== managedConnection?.id ||
    runtimeState?.callbackUrl !== callbackUrl;
  const needsManagedRegistration =
    !managedConnection ||
    !managedConnection.callbackUrl ||
    normalizeOptionalUrl(managedConnection.callbackUrl) !== callbackUrl ||
    needsSecretRotation;

  if (!needsManagedRegistration) {
    return {
      callbackSecretAvailable: Boolean(currentSecret),
      callbackUrl,
      preferredSenderConnectionId: managedConnection?.id,
      senderRegistration: null,
    };
  }

  try {
    const registration = await registerMahiloAgentConnection(options.client, {
      callbackUrl,
      capabilities: ["chat"],
      description: SETUP_MANAGED_SENDER_DESCRIPTION,
      framework: SETUP_MANAGED_SENDER_FRAMEWORK,
      label: SETUP_MANAGED_SENDER_LABEL,
      mode: "webhook",
      rotateSecret: needsSecretRotation,
    });

    options.runtimeBootstrapStore.write(options.config.baseUrl, {
      callbackConnectionId: registration.connectionId,
      callbackUrl,
      ...(registration.callbackSecret
        ? {
            callbackSecret: registration.callbackSecret,
          }
        : {}),
    });
    options.senderResolver.rememberPreferredSender(registration.connectionId);

    return {
      callbackSecretAvailable: Boolean(
        registration.callbackSecret ?? (await options.callbackSecretResolver()),
      ),
      callbackUrl,
      preferredSenderConnectionId: registration.connectionId,
      senderRegistration: {
        attempted: true,
        callbackSecretStored: Boolean(registration.callbackSecret),
        callbackUrl,
        connectionId: registration.connectionId,
        created: registration.updated !== true,
        updated: registration.updated === true,
      },
    };
  } catch (error) {
    return {
      callbackSecretAvailable: Boolean(currentSecret),
      callbackUrl,
      preferredSenderConnectionId: managedConnection?.id,
      senderRegistration: {
        attempted: true,
        callbackSecretStored: false,
        callbackUrl,
        error: toErrorMessage(error),
      },
    };
  }
}

function buildPendingCallbackStatus(
  config: MahiloPluginConfig,
  runtimeState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
): MahiloSetupCallbackStatus {
  return {
    path: config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH,
    publicUrl: resolveStoredOrConfiguredCallbackUrl(config, runtimeState),
    ready: false,
    secretAvailable: Boolean(runtimeState?.callbackSecret),
    secretSource: runtimeState?.callbackSecret ? "store" : undefined,
  };
}

function buildCallbackStatus(
  config: MahiloPluginConfig,
  runtimeState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
  summary: MahiloSetupSummary,
  callbackSecretAvailable: boolean,
  callbackUrl?: string,
): MahiloSetupCallbackStatus {
  const publicUrl =
    callbackUrl ??
    resolveStoredOrConfiguredCallbackUrl(config, runtimeState) ??
    summary.sender?.connection.callbackUrl;

  return {
    path: config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH,
    publicUrl,
    ready:
      Boolean(summary.sender) &&
      callbackSecretAvailable &&
      summary.connectivity.senderPingOk === true,
    secretAvailable: callbackSecretAvailable,
    secretSource: runtimeState?.callbackSecret ? "store" : undefined,
  };
}

function buildSetupNotes(
  summary: MahiloSetupSummary,
  callback: MahiloSetupCallbackStatus,
  senderRegistration: MahiloSetupSenderRegistration | null,
  blocker: MahiloSetupBlocker | null,
  identityBootstrap: MahiloSetupIdentityBootstrap | null,
): string[] {
  const notes = [...summary.notes];

  if (identityBootstrap?.created) {
    notes.unshift(
      "Mahilo saved the newly issued API key in the local runtime bootstrap store so setup can continue without a manual config edit.",
    );
  }

  if (senderRegistration?.created && senderRegistration.connectionId) {
    notes.unshift(
      `Registered the default OpenClaw sender connection ${senderRegistration.connectionId} for callback delivery.`,
    );
  } else if (senderRegistration?.updated && senderRegistration.connectionId) {
    notes.unshift(
      `Updated the default OpenClaw sender connection ${senderRegistration.connectionId} for callback delivery.`,
    );
  }

  if (blocker) {
    notes.push(blocker.nextAction);
  } else if (callback.publicUrl) {
    notes.push(
      `Mahilo callback readiness is anchored to ${callback.publicUrl}.`,
    );
  }

  return dedupeStrings(notes);
}

function determineSetupBlocker(options: {
  callback: MahiloSetupCallbackStatus;
  config: MahiloPluginConfig;
  credentialSource: MahiloCredentialSource | null;
  senderRegistration: MahiloSetupSenderRegistration | null;
  summary: MahiloSetupSummary;
}): MahiloSetupBlocker | null {
  const { callback, config, senderRegistration, summary } = options;
  const sender = summary.sender?.connectionId;

  if (!summary.connectivity.identityOk) {
    return {
      kind: "identity",
      message:
        "Mahilo could not confirm the current API key against the configured server.",
      nextAction:
        options.credentialSource === "config"
          ? "Update the configured apiKey or remove it and rerun `mahilo setup` with a username and invite token so Mahilo can bootstrap fresh credentials."
          : "Rerun `mahilo setup` with a username and invite token to bootstrap fresh credentials for this OpenClaw runtime.",
      operatorOwned: false,
    };
  }

  if (senderRegistration?.error) {
    if (
      !callback.publicUrl ||
      looksLikeCallbackRegistrationFailure(senderRegistration.error)
    ) {
      return buildCallbackOperatorBlocker(config, callback.publicUrl);
    }

    return {
      kind: "sender_attachment",
      message: `Mahilo could not attach the default OpenClaw sender yet (${senderRegistration.error}).`,
      nextAction:
        "Confirm the Mahilo server is reachable and rerun `mahilo setup` so it can finish sender attachment.",
      operatorOwned: false,
    };
  }

  if (!summary.connectivity.senderResolved || !sender) {
    if (!callback.publicUrl) {
      return buildCallbackOperatorBlocker(config, callback.publicUrl);
    }

    return {
      kind: "sender_attachment",
      message:
        "Mahilo still does not have a default OpenClaw sender connection attached.",
      nextAction:
        "Rerun `mahilo setup` after the callback URL is reachable so Mahilo can register the default sender connection.",
      operatorOwned: false,
    };
  }

  if (!callback.secretAvailable) {
    if (!callback.publicUrl) {
      return buildCallbackOperatorBlocker(config, callback.publicUrl);
    }

    return {
      kind: "callback_readiness",
      message: `Mahilo selected sender ${sender}, but the webhook callback secret is still unavailable locally.`,
      nextAction:
        "Rerun `mahilo setup` so Mahilo can rotate and persist the callback secret for this OpenClaw sender.",
      operatorOwned: false,
    };
  }

  if (summary.connectivity.senderPingOk === false) {
    const callbackUrl = callback.publicUrl;
    const callbackPath = config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH;
    return {
      kind: "callback_readiness",
      message: `Mahilo selected sender ${sender}, but the callback readiness probe did not succeed.`,
      nextAction:
        callbackUrl && isLikelyPublicCallbackUrl(callbackUrl)
          ? `Make sure HEAD requests to ${callbackUrl} reach OpenClaw and return 200, then rerun \`mahilo setup\`.`
          : callbackUrl
            ? `OpenClaw is only advertising ${callbackUrl}. Enable gateway remote/Tailscale exposure so ${callbackPath} is reachable from the internet or your tailnet, then rerun \`mahilo setup\`.`
            : `Enable gateway remote/Tailscale exposure so ${callbackPath} is reachable from outside this machine, then rerun \`mahilo setup\`.`,
      operatorOwned: true,
    };
  }

  return null;
}

function buildIdentityBootstrapBlocker(options: {
  missingInviteToken: boolean;
  missingUsername: boolean;
}): MahiloSetupBlocker {
  const missing: string[] = [];
  if (options.missingUsername) {
    missing.push("username");
  }
  if (options.missingInviteToken) {
    missing.push("invite token");
  }

  return {
    kind: "identity",
    message: `Mahilo needs a ${missing.join(" and ")} before it can bootstrap your identity inside OpenClaw.`,
    nextAction:
      'Run `mahilo setup` with `{ "username": "your_handle", "invite_token": "mhinv_..." }` to create the identity and continue setup in one pass.',
    operatorOwned: false,
  };
}

function buildIdentityRegistrationFailureBlocker(
  error: unknown,
): MahiloSetupBlocker {
  return {
    kind: "identity",
    message: `Mahilo could not bootstrap a new identity (${toErrorMessage(error)}).`,
    nextAction:
      "Choose a different username, confirm the invite token is still valid, or point OpenClaw at the correct Mahilo server, then rerun `mahilo setup`.",
    operatorOwned: false,
  };
}

function buildSetupFailureBlocker(
  error: unknown,
  credentialSource: MahiloCredentialSource | null,
): MahiloSetupBlocker {
  if (shouldAttemptIdentityRegistration(error)) {
    return {
      kind: "identity",
      message: `Mahilo rejected the current credentials (${toErrorMessage(error)}).`,
      nextAction:
        credentialSource === "config"
          ? "Update the configured apiKey or remove it and rerun `mahilo setup` with a username and invite token."
          : "Rerun `mahilo setup` with a username and invite token to mint fresh credentials for this runtime.",
      operatorOwned: false,
    };
  }

  return {
    kind: "sender_attachment",
    message: `Mahilo setup hit an unexpected server failure (${toErrorMessage(error)}).`,
    nextAction:
      "Check Mahilo server reachability from the OpenClaw host, then rerun `mahilo setup`.",
    operatorOwned: false,
  };
}

function buildCallbackOperatorBlocker(
  config: MahiloPluginConfig,
  callbackUrl?: string,
): MahiloSetupBlocker {
  const callbackPath = config.callbackPath ?? DEFAULT_WEBHOOK_ROUTE_PATH;
  const publicHint =
    callbackUrl && isLikelyPublicCallbackUrl(callbackUrl)
      ? `Make sure ${callbackUrl} terminates at the OpenClaw route ${callbackPath}, then rerun \`mahilo setup\`.`
      : callbackUrl
        ? `OpenClaw is only advertising ${callbackUrl}. Enable gateway remote/Tailscale exposure so ${callbackPath} is reachable from the internet or your tailnet, then rerun \`mahilo setup\`.`
        : `Enable gateway remote/Tailscale exposure so ${callbackPath} is reachable from outside this machine, then rerun \`mahilo setup\`.`;

  return {
    kind: "callback_readiness",
    message:
      "Mahilo still needs one operator-owned callback step before it can finish default sender attachment.",
    nextAction: publicHint,
    operatorOwned: true,
  };
}

function createBootstrapSetupClient(
  config: MahiloPluginConfig,
): MahiloContractClient {
  return new MahiloContractClient({
    baseUrl: config.baseUrl,
    contractVersion: config.contractVersion,
    pluginVersion: config.pluginVersion,
  });
}

function buildPluginConfigInput(
  config: MahiloPluginConfig,
): Record<string, unknown> {
  return compactObject({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    cacheTtlSeconds: config.cacheTtlSeconds,
    inboundAgentId: config.inboundAgentId,
    inboundSessionKey: config.inboundSessionKey,
    callbackPath: config.callbackPath,
    callbackUrl: config.callbackUrl,
    promptContextEnabled: config.promptContextEnabled,
    reviewMode: config.reviewMode,
  });
}

function createCallbackSecretResolver(
  baseUrl: string,
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore,
  options: MahiloOpenClawPluginOptions,
): () => Promise<string | undefined> {
  return async () => {
    const runtimeSecret = runtimeBootstrapStore.read(baseUrl)?.callbackSecret;
    const callbackSecret = readOptionalString(
      options.webhookRoute?.callbackSecret,
    );

    if (typeof options.webhookRoute?.getCallbackSecret === "function") {
      const explicitSecret = readOptionalString(
        await options.webhookRoute.getCallbackSecret(),
      );
      if (explicitSecret) {
        return explicitSecret;
      }
    }

    return callbackSecret ?? runtimeSecret;
  };
}

function resolveCredentialSource(
  config: MahiloPluginConfig,
  bootstrapState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
): MahiloCredentialSource | null {
  if (config.apiKey) {
    return "config";
  }

  return bootstrapState?.apiKey ? "store" : null;
}

function resolveEffectiveApiKey(
  config: MahiloPluginConfig,
  bootstrapState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
): string | undefined {
  return config.apiKey ?? bootstrapState?.apiKey;
}

function resolveManagedCallbackUrl(
  config: MahiloPluginConfig,
  runtimeState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
  managedConnection: MahiloAgentConnectionSummary | null,
): string | undefined {
  return (
    normalizeOptionalUrl(config.callbackUrl) ??
    normalizeOptionalUrl(runtimeState?.callbackUrl) ??
    normalizeOptionalUrl(managedConnection?.callbackUrl)
  );
}

function resolveStoredOrConfiguredCallbackUrl(
  config: MahiloPluginConfig,
  runtimeState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
): string | undefined {
  return (
    normalizeOptionalUrl(config.callbackUrl) ??
    normalizeOptionalUrl(runtimeState?.callbackUrl)
  );
}

async function resolveBootstrapConfig(
  config: MahiloPluginConfig,
  runtimeState: ReturnType<MahiloRuntimeBootstrapStore["read"]>,
  rawContext: unknown,
): Promise<MahiloPluginConfig> {
  const detectedCallback = detectMahiloCallbackUrl({
    callbackPath: config.callbackPath,
    configuredCallbackUrl: config.callbackUrl,
    rawContext,
    storedCallbackUrl: runtimeState?.callbackUrl,
  });
  return {
    ...config,
    callbackUrl: detectedCallback.publicUrl,
  };
}

function findManagedSetupConnection(
  connections: MahiloAgentConnectionSummary[],
): MahiloAgentConnectionSummary | null {
  return (
    connections.find(
      (connection) =>
        normalizeLowercaseToken(connection.framework) ===
          SETUP_MANAGED_SENDER_FRAMEWORK &&
        normalizeLowercaseToken(connection.label) ===
          SETUP_MANAGED_SENDER_LABEL,
    ) ?? null
  );
}

function looksLikeCallbackRegistrationFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("callback") ||
    normalized.includes("callback_url") ||
    normalized.includes("invalid_callback_url") ||
    normalized.includes("missing_callback_url")
  );
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    if (value.trim().length === 0 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    output.push(value);
  }

  return output;
}

function readOptionalObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizeLowercaseToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : undefined;
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function readFirstStringFromUnknown(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = readOptionalString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(value).filter(
    ([, candidate]) => candidate !== undefined,
  );
  return Object.fromEntries(entries);
}

function detectCommandRegistrationMode(
  args: unknown[],
): CommandRegistrationMode | null {
  if (args.length === 1 && isRecord(args[0])) {
    return { kind: "object" };
  }

  if (typeof args[0] === "string" && typeof args[1] === "function") {
    return {
      kind: "name-handler",
      metadataStyle: detectMetadataStyle(
        args.length >= 3 ? args[2] : undefined,
        args.length >= 3,
      ),
    };
  }

  if (
    typeof args[0] === "string" &&
    typeof args[1] === "string" &&
    typeof args[2] === "function"
  ) {
    return {
      kind: "name-description-handler",
      metadataStyle: detectMetadataStyle(
        args.length >= 4 ? args[3] : undefined,
        args.length >= 4,
      ),
    };
  }

  return null;
}

function detectMetadataStyle(
  metadata: unknown,
  metadataWasPassed: boolean,
): "definition" | "none" | "schema" {
  if (!metadataWasPassed) {
    return "none";
  }

  if (
    isRecord(metadata) &&
    ("parameters" in metadata ||
      "description" in metadata ||
      "label" in metadata)
  ) {
    return "definition";
  }

  return "schema";
}

function patchCommandDefinition(
  definition: CommandDefinitionLike,
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): CommandDefinitionLike {
  if (!AUTO_SENDER_COMMAND_NAMES.has(definition.name)) {
    return definition;
  }

  return {
    ...definition,
    execute: wrapCommandExecute(
      definition.name,
      definition.execute,
      client,
      senderResolver,
    ),
    handler:
      typeof definition.handler === "function"
        ? wrapCommandExecute(
            definition.name,
            definition.handler,
            client,
            senderResolver,
          )
        : definition.handler,
    parameters: patchParameterSchema(definition.parameters),
    run:
      typeof definition.run === "function"
        ? wrapCommandExecute(
            definition.name,
            definition.run,
            client,
            senderResolver,
          )
        : definition.run,
  };
}

function patchCommandRegistrationArgs(
  args: unknown[],
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): unknown[] {
  const mode = detectCommandRegistrationMode(args);
  if (!mode) {
    return args;
  }

  if (mode.kind === "object") {
    const definition = coerceCommandDefinition(args[0]);
    return definition
      ? [patchCommandDefinition(definition, client, senderResolver)]
      : args;
  }

  if (mode.kind === "name-handler") {
    const name = args[0];
    const execute = args[1];
    const metadata = args[2];

    return [
      name,
      AUTO_SENDER_COMMAND_NAMES.has(String(name))
        ? wrapCommandExecute(
            String(name),
            execute as (...args: unknown[]) => unknown,
            client,
            senderResolver,
          )
        : execute,
      patchCommandMetadata(String(name), metadata),
      ...args.slice(3),
    ];
  }

  const name = args[0];
  const description = args[1];
  const execute = args[2];
  const metadata = args[3];

  return [
    name,
    description,
    AUTO_SENDER_COMMAND_NAMES.has(String(name))
      ? wrapCommandExecute(
          String(name),
          execute as (...args: unknown[]) => unknown,
          client,
          senderResolver,
        )
      : execute,
    patchCommandMetadata(String(name), metadata),
    ...args.slice(4),
  ];
}

function patchCommandMetadata(name: string, metadata: unknown): unknown {
  if (!AUTO_SENDER_COMMAND_NAMES.has(name)) {
    return metadata;
  }

  if (isRecord(metadata) && "parameters" in metadata) {
    return {
      ...metadata,
      parameters: patchParameterSchema(metadata.parameters),
    };
  }

  return patchParameterSchema(metadata);
}

function patchParameterSchema(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  const nextSchema: Record<string, unknown> = { ...schema };
  if (Array.isArray(schema.required)) {
    nextSchema.required = schema.required.filter(
      (entry) =>
        entry !== "senderConnectionId" && entry !== "sender_connection_id",
    );
  }

  const properties = isRecord(schema.properties)
    ? { ...schema.properties }
    : null;
  if (properties) {
    if (isRecord(properties.senderConnectionId)) {
      properties.senderConnectionId = annotateSenderProperty(
        properties.senderConnectionId,
      );
    }
    if (isRecord(properties.sender_connection_id)) {
      properties.sender_connection_id = annotateSenderProperty(
        properties.sender_connection_id,
      );
    }
    nextSchema.properties = properties;
  }

  return nextSchema;
}

function patchToolDefinition(
  tool: AnyAgentTool,
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): AnyAgentTool {
  const toolName = typeof tool.name === "string" ? tool.name : "";
  const execute = tool.execute as AnyAgentTool["execute"];

  if (!AUTO_SENDER_TOOL_NAMES.has(toolName) || typeof execute !== "function") {
    return tool;
  }

  return {
    ...tool,
    execute: async (toolCallId: string, rawInput: unknown) => {
      try {
        const nextInput = await ensureSenderInput(
          rawInput,
          client,
          senderResolver,
        );
        return await execute(toolCallId, nextInput);
      } catch (error) {
        return toToolResult(`${toolName} failed: ${toErrorMessage(error)}`, {
          error: toErrorMessage(error),
          errorType: error instanceof MahiloRequestError ? "network" : "input",
          retryable: error instanceof MahiloRequestError,
          status: "error",
          tool: toolName,
        });
      }
    },
    parameters: patchParameterSchema(tool.parameters),
  };
}

function registerSetupCommand(
  api: OpenClawPluginApi,
  originalRegisterCommand: (...args: unknown[]) => unknown,
  mode: CommandRegistrationMode | null,
  definition: CommandDefinitionLike,
): void {
  if (!mode || mode.kind === "object") {
    registerMahiloOperatorCommand(api, {
      description: definition.description,
      execute: async (rawInput?: unknown) => definition.execute(rawInput),
      label: definition.label,
      name: definition.name,
      parameters: isRecord(definition.parameters)
        ? (definition.parameters as Record<string, unknown>)
        : {
            additionalProperties: false,
            type: "object",
          },
    });
    return;
  }

  if (mode.kind === "name-handler") {
    const metadata = buildCommandMetadata(definition, mode.metadataStyle);
    if (metadata === undefined) {
      originalRegisterCommand.call(api, definition.name, definition.execute);
      return;
    }

    originalRegisterCommand.call(
      api,
      definition.name,
      definition.execute,
      metadata,
    );
    return;
  }

  const metadata = buildCommandMetadata(definition, mode.metadataStyle);
  if (metadata === undefined) {
    originalRegisterCommand.call(
      api,
      definition.name,
      definition.description,
      definition.execute,
    );
    return;
  }

  originalRegisterCommand.call(
    api,
    definition.name,
    definition.description,
    definition.execute,
    metadata,
  );
}

function createRuntimeAwareClient(
  config: MahiloPluginConfig,
  runtimeBootstrapStore: MahiloRuntimeBootstrapStore,
  createClient: (config: MahiloPluginConfig) => MahiloContractClient,
): MahiloContractClient {
  return new Proxy({} as MahiloContractClient, {
    get(_target, property) {
      const currentClient = createClient({
        ...config,
        apiKey: resolveEffectiveApiKey(
          config,
          runtimeBootstrapStore.read(config.baseUrl),
        ),
      });
      const value = Reflect.get(currentClient as unknown as object, property);
      return typeof value === "function" ? value.bind(currentClient) : value;
    },
  });
}

function registerObjectModeMahiloCommand(
  api: OpenClawPluginApi,
  originalRegisterCommand: (...args: unknown[]) => unknown,
  routerState: MahiloCommandRouterState,
  args: unknown[],
): boolean {
  const mode = detectCommandRegistrationMode(args);
  if (!mode) {
    return false;
  }

  const currentRuntimeUsesObjectCommands = originalRegisterCommand.length < 2;
  if (!currentRuntimeUsesObjectCommands && mode.kind !== "object") {
    return false;
  }

  const definition = coerceCommandDefinitionFromArgs(args);
  if (!definition) {
    return false;
  }

  const subcommand = readMahiloSubcommand(definition.name);
  if (!subcommand) {
    return false;
  }

  routerState.subcommands.set(subcommand, definition);
  if (routerState.registered) {
    return true;
  }

  originalRegisterCommand.call(api, {
    acceptsArgs: true,
    description:
      "Mahilo setup and diagnostics. Use /mahilo <setup|status|network|review|reconnect> [json].",
    handler: async (ctx: unknown) =>
      executeMahiloCommandRouter(routerState, ctx),
    name: MAHILO_OPERATOR_COMMAND_NAME,
    requireAuth: true,
  });
  routerState.registered = true;
  return true;
}

async function executeMahiloCommandRouter(
  routerState: MahiloCommandRouterState,
  ctx: unknown,
): Promise<Record<string, unknown>> {
  const args = readOptionalString(readRecordValue(ctx, "args")) ?? "";
  const [firstToken, ...restTokens] = args.split(/\s+/).filter(Boolean);
  const subcommand = firstToken?.trim().toLowerCase();

  if (!subcommand) {
    return {
      text: buildMahiloCommandHelp(routerState),
    };
  }

  const definition = routerState.subcommands.get(subcommand);
  if (!definition) {
    return {
      text: `${buildMahiloCommandHelp(routerState)}\n\nUnknown subcommand: ${subcommand}`,
    };
  }

  try {
    const input = parseMahiloCommandArgs(subcommand, restTokens.join(" "));
    const result = await definition.execute(input);
    return normalizeMahiloCommandReply(result);
  } catch (error) {
    return {
      isError: true,
      text: `Mahilo command failed: ${toErrorMessage(error)}`,
    };
  }
}

function buildMahiloCommandHelp(routerState: MahiloCommandRouterState): string {
  const available = Array.from(routerState.subcommands.keys()).sort();
  const base =
    "Usage: /mahilo <setup|status|network|review|reconnect> [json]\n" +
    "Examples:\n" +
    "/mahilo setup bootstrap-user mhinv_example\n" +
    "/mahilo status\n" +
    "/mahilo network\n" +
    '/mahilo review {"status":"open","limit":10}';

  if (available.length === 0) {
    return base;
  }

  return `${base}\nAvailable: ${available.join(", ")}`;
}

function parseMahiloCommandArgs(subcommand: string, rawArgs: string): unknown {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("JSON command arguments must decode to an object");
    }

    return parsed;
  }

  if (subcommand === "setup") {
    const [username, inviteToken] = trimmed.split(/\s+/, 2);
    return {
      invite_token: inviteToken,
      username: username?.replace(/^@+/, ""),
    };
  }

  throw new Error(
    'Pass command arguments as JSON, for example /mahilo review {"status":"open"}',
  );
}

function normalizeMahiloCommandReply(result: unknown): Record<string, unknown> {
  if (isRecord(result) && typeof result.text === "string") {
    return {
      isError: result.isError === true,
      text: result.text,
    };
  }

  const text = extractMahiloCommandText(result);
  const details =
    isRecord(result) && isRecord(result.details) ? result.details : undefined;
  return {
    text:
      details && Object.keys(details).length > 0
        ? `${text}\n\n${JSON.stringify(details, null, 2)}`
        : text,
  };
}

function extractMahiloCommandText(result: unknown): string {
  if (typeof result === "string" && result.trim().length > 0) {
    return result;
  }

  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          isRecord(block) &&
          typeof block.text === "string" &&
          block.text.trim().length > 0
        ) {
          return block.text;
        }
      }
    }
  }

  return "Mahilo command completed.";
}

function readMahiloSubcommand(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized.startsWith(`${MAHILO_OPERATOR_COMMAND_NAME} `)) {
    return null;
  }

  const subcommand = normalized
    .slice(MAHILO_OPERATOR_COMMAND_NAME.length)
    .trim();
  return subcommand.length > 0 ? subcommand : null;
}

async function ensureSenderInput(
  rawInput: unknown,
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): Promise<unknown> {
  const input = readInputObject(rawInput);
  if (!input) {
    return rawInput;
  }

  const explicitSenderConnectionId = readSenderConnectionId(input);
  if (explicitSenderConnectionId) {
    senderResolver.rememberPreferredSender(explicitSenderConnectionId);
    return rawInput;
  }

  const resolved = await senderResolver.resolve(client);
  return {
    ...input,
    sender_connection_id: resolved.connectionId,
    senderConnectionId: resolved.connectionId,
  };
}

function annotateSenderProperty(
  property: Record<string, unknown>,
): Record<string, unknown> {
  const description = readOptionalString(property.description);
  const suffix =
    "Optional after `mahilo setup`; the plugin will auto-select a default sender when omitted.";
  return {
    ...property,
    description: description ? `${description} ${suffix}` : suffix,
  };
}

function coerceCommandDefinition(value: unknown): CommandDefinitionLike | null {
  if (!isRecord(value)) {
    return null;
  }

  const execute =
    typeof value.execute === "function"
      ? (value.execute as (...args: unknown[]) => unknown)
      : typeof value.handler === "function"
        ? (value.handler as (...args: unknown[]) => unknown)
        : typeof value.run === "function"
          ? (value.run as (...args: unknown[]) => unknown)
          : null;
  if (
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    execute === null
  ) {
    return null;
  }

  return {
    acceptsArgs:
      typeof value.acceptsArgs === "boolean" ? value.acceptsArgs : undefined,
    description: value.description,
    execute,
    handler:
      typeof value.handler === "function"
        ? (value.handler as (...args: unknown[]) => unknown)
        : undefined,
    label: typeof value.label === "string" ? value.label : value.name,
    name: value.name,
    parameters: value.parameters,
    requireAuth:
      typeof value.requireAuth === "boolean" ? value.requireAuth : undefined,
    run:
      typeof value.run === "function"
        ? (value.run as (...args: unknown[]) => unknown)
        : undefined,
  };
}

function coerceCommandDefinitionFromArgs(
  args: unknown[],
): CommandDefinitionLike | null {
  const mode = detectCommandRegistrationMode(args);
  if (!mode) {
    return null;
  }

  if (mode.kind === "object") {
    return coerceCommandDefinition(args[0]);
  }

  if (mode.kind === "name-handler") {
    const name = readOptionalString(args[0]);
    const execute =
      typeof args[1] === "function"
        ? (args[1] as (...args: unknown[]) => unknown)
        : null;
    if (!name || !execute) {
      return null;
    }

    const metadata = isRecord(args[2]) ? args[2] : undefined;
    return {
      description: readOptionalString(metadata?.description) ?? name,
      execute,
      handler: execute,
      label: readOptionalString(metadata?.label) ?? name,
      name,
      parameters: metadata?.parameters ?? args[2],
      run: execute,
    };
  }

  const name = readOptionalString(args[0]);
  const description = readOptionalString(args[1]);
  const execute =
    typeof args[2] === "function"
      ? (args[2] as (...args: unknown[]) => unknown)
      : null;
  if (!name || !description || !execute) {
    return null;
  }

  const metadata = isRecord(args[3]) ? args[3] : undefined;
  return {
    description,
    execute,
    handler: execute,
    label: readOptionalString(metadata?.label) ?? name,
    name,
    parameters: metadata?.parameters ?? args[3],
    run: execute,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readInputObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readRecordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readSenderConnectionId(
  input: Record<string, unknown>,
): string | undefined {
  return (
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id)
  );
}

function toCommandResult(
  text: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    content: [
      {
        text,
        type: "text",
      },
    ],
    details,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof MahiloRequestError) {
    return error.bodyText && error.bodyText.trim().length > 0
      ? `${error.message}: ${error.bodyText}`
      : error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unknown Mahilo error";
}

function shouldAttemptIdentityRegistration(error: unknown): boolean {
  return (
    error instanceof MahiloRequestError &&
    (error.status === 401 || error.status === 403)
  );
}

function toToolResult(
  text: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return {
    content: [
      {
        text,
        type: "text",
      },
    ],
    details,
  };
}

function wrapCommandExecute(
  commandName: string,
  execute: (...args: unknown[]) => unknown,
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    try {
      const nextArgs = [...args];
      nextArgs[0] = await ensureSenderInput(
        nextArgs[0],
        client,
        senderResolver,
      );
      return await execute(...nextArgs);
    } catch (error) {
      return toCommandResult(
        `${commandName} failed: ${toErrorMessage(error)}`,
        {
          command: commandName,
          error: toErrorMessage(error),
          notes: [
            "Run `mahilo setup` to attach or confirm the plugin's default sender connection.",
          ],
          status: "error",
        },
      );
    }
  };
}

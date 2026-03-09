import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  type MahiloPluginConfig,
} from "./config";
import { MAHILO_RUNTIME_PLUGIN_DESCRIPTION, MAHILO_RUNTIME_PLUGIN_ID, MAHILO_RUNTIME_PLUGIN_NAME } from "./identity";
import {
  registerMahiloOpenClawPlugin as registerLegacyMahiloOpenClawPlugin,
  type MahiloOpenClawPluginDefinition,
  type MahiloOpenClawPluginOptions,
} from "./openclaw-plugin";
import { MahiloRequestError, type MahiloContractClient } from "./client";
import { MahiloSenderResolver, type MahiloSetupSummary } from "./sender-resolution";

export type { MahiloOpenClawPluginDefinition, MahiloOpenClawPluginOptions } from "./openclaw-plugin";

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
  description: string;
  execute: (...args: unknown[]) => unknown;
  label: string;
  name: string;
  parameters?: unknown;
}

const AUTO_SENDER_COMMAND_NAMES = new Set(["mahilo override"]);
const AUTO_SENDER_TOOL_NAMES = new Set([
  "create_mahilo_override",
  "get_mahilo_context",
  "preview_mahilo_send",
  "talk_to_agent",
  "talk_to_group",
]);

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
      pluginVersion: readOptionalString((api as Record<string, unknown>).version) ?? "unknown",
    },
  });
  const createClient = options.createClient ?? createMahiloClientFromConfig;
  const client = createClient(config);
  const senderResolver = new MahiloSenderResolver();
  const registeredCommandNames = new Set<string>();

  let commandRegistrationMode: CommandRegistrationMode | null = null;
  const originalRegisterCommand =
    typeof (api as Record<string, unknown>).registerCommand === "function"
      ? ((api as Record<string, unknown>).registerCommand as (...args: unknown[]) => unknown)
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

          const patchedArgs = patchCommandRegistrationArgs(args, client, senderResolver);
          return originalRegisterCommand.apply(api, patchedArgs);
        };

  if (wrappedRegisterCommand) {
    try {
      Object.defineProperty(wrappedRegisterCommand, "length", {
        configurable: true,
        value: originalRegisterCommand.length,
      });
    } catch {
      // Preserve legacy registration behavior when possible, but do not fail plugin startup if the runtime locks function metadata.
    }
  }

  const wrappedApi = Object.create(api) as OpenClawPluginApi;
  wrappedApi.registerCommand =
    (wrappedRegisterCommand ?? (api.registerCommand as OpenClawPluginApi["registerCommand"]));
  wrappedApi.registerTool = (tool: AnyAgentTool) =>
    originalRegisterTool(patchToolDefinition(tool, client, senderResolver));

  registerLegacyMahiloOpenClawPlugin(wrappedApi, options);

  if (originalRegisterCommand && !registeredCommandNames.has("mahilo setup")) {
    registerSetupCommand(
      api,
      originalRegisterCommand,
      commandRegistrationMode,
      createSetupCommand(config, client, senderResolver),
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

function buildSetupSummaryText(
  summary: MahiloSetupSummary,
  expectedUsername?: string,
): string {
  const username = summary.identity?.username ? `@${summary.identity.username}` : "the current Mahilo identity";
  const sender = summary.sender?.connectionId;

  const usernameMismatch =
    expectedUsername &&
    summary.identity?.username &&
    expectedUsername !== summary.identity.username;

  if (!summary.connectivity.identityOk) {
    return "Mahilo setup could not confirm the configured identity. Check the API key and server URL, then rerun `mahilo setup`.";
  }

  if (sender && summary.connectivity.senderPingOk !== false) {
    const connectivitySuffix =
      summary.connectivity.senderPingOk === true
        ? "Connectivity checks passed."
        : "Identity attachment succeeded and the default sender was selected.";
    const mismatchSuffix = usernameMismatch
      ? ` Expected username @${expectedUsername}, but the server returned @${summary.identity?.username}.`
      : "";

    return `Mahilo setup attached ${username}, selected sender ${sender}, and kept ${summary.defaultBoundaries.reviewMode} review boundaries in place. ${connectivitySuffix}${mismatchSuffix}`;
  }

  if (sender) {
    return `Mahilo setup attached ${username} and selected sender ${sender}, but the connectivity ping did not complete. Review the setup notes and rerun \`mahilo setup\` once the server is reachable.`;
  }

  return `Mahilo setup attached ${username}, but no default sender connection is available yet. Attach or create a Mahilo agent connection, then rerun \`mahilo setup\`.`;
}

function createSetupCommand(
  config: MahiloPluginConfig,
  client: MahiloContractClient,
  senderResolver: MahiloSenderResolver,
): CommandDefinitionLike {
  return {
    description:
      "Attach the current Mahilo identity, choose a default sender connection, and run connectivity checks from inside OpenClaw.",
    execute: async (rawInput?: unknown) => {
      try {
        const input = readInputObject(rawInput) ?? {};
        const expectedUsername = readOptionalString(input.username);
        const preferredSenderConnectionId = readSenderConnectionId(input);
        const ping = readOptionalBoolean(input.ping) ?? true;

        if (preferredSenderConnectionId) {
          senderResolver.rememberPreferredSender(preferredSenderConnectionId);
        }

        const summary = await senderResolver.runSetup(client, config, {
          ping,
          preferredSenderConnectionId,
        });

        const usernameMismatch =
          expectedUsername &&
          summary.identity?.username &&
          expectedUsername !== summary.identity.username;
        const details = {
          command: "mahilo setup",
          expectedUsername: expectedUsername ?? null,
          ...summary,
          notes: usernameMismatch
            ? [
                `Expected username @${expectedUsername}, but Mahilo reported @${summary.identity?.username}.`,
                ...summary.notes,
              ]
            : summary.notes,
          usernameConfirmed: !usernameMismatch,
        };

        return toCommandResult(buildSetupSummaryText(summary, expectedUsername), details);
      } catch (error) {
        const input = readInputObject(rawInput) ?? {};
        const requestedUsername = readOptionalString(input.username);
        const displayName =
          readOptionalString(input.displayName) ??
          readOptionalString(input.display_name);

        if (requestedUsername && shouldAttemptIdentityRegistration(error)) {
          try {
            const registration = await client.registerIdentity({
              displayName,
              username: requestedUsername,
            });

            return toCommandResult(
              `Mahilo created identity @${requestedUsername}. Add the issued API key to the plugin config, then rerun \`mahilo setup\` to finish sender selection and connectivity checks.`,
              {
                command: "mahilo setup",
                notes: [
                  "Identity creation succeeded, but the plugin cannot keep using the new credentials until the returned API key is saved in the OpenClaw plugin config.",
                  "After updating the config, rerun `mahilo setup` to confirm the username, choose the default sender connection, and run the connectivity check.",
                ],
                registration,
                setupError: toErrorMessage(error),
                status: "identity_created",
              },
            );
          } catch (registrationError) {
            return toCommandResult(
              `Mahilo setup failed: ${toErrorMessage(error)}. Identity bootstrap also failed: ${toErrorMessage(registrationError)}`,
              {
                command: "mahilo setup",
                error: toErrorMessage(error),
                notes: [
                  "Check the configured Mahilo base URL and server availability.",
                  "If you already have a Mahilo API key, set it in the plugin config and rerun `mahilo setup`.",
                ],
                registrationError: toErrorMessage(registrationError),
                status: "error",
              },
            );
          }
        }

        return toCommandResult(
          `Mahilo setup failed: ${toErrorMessage(error)}`,
          {
            command: "mahilo setup",
            error: toErrorMessage(error),
            notes: [
              "Check the configured Mahilo base URL and API key, then rerun `mahilo setup`.",
            ],
            status: "error",
          },
        );
      }
    },
    label: "Mahilo Setup",
    name: "mahilo setup",
    parameters: {
      additionalProperties: false,
      properties: {
        ping: {
          default: true,
          description: "Run a sender connectivity ping after the default sender is selected.",
          type: "boolean",
        },
        sender_connection_id: {
          description: "Optional sender connection to pin as the plugin default.",
          type: "string",
        },
        senderConnectionId: {
          description: "Optional sender connection to pin as the plugin default.",
          type: "string",
        },
        username: {
          description: "Optional username to confirm against the attached Mahilo identity.",
          type: "string",
        },
      },
      type: "object",
    },
  };
}

function detectCommandRegistrationMode(args: unknown[]): CommandRegistrationMode | null {
  if (args.length === 1 && isRecord(args[0])) {
    return { kind: "object" };
  }

  if (typeof args[0] === "string" && typeof args[1] === "function") {
    return {
      kind: "name-handler",
      metadataStyle: detectMetadataStyle(args.length >= 3 ? args[2] : undefined, args.length >= 3),
    };
  }

  if (
    typeof args[0] === "string" &&
    typeof args[1] === "string" &&
    typeof args[2] === "function"
  ) {
    return {
      kind: "name-description-handler",
      metadataStyle: detectMetadataStyle(args.length >= 4 ? args[3] : undefined, args.length >= 4),
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

  if (isRecord(metadata) && ("parameters" in metadata || "description" in metadata || "label" in metadata)) {
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
    execute: wrapCommandExecute(definition.name, definition.execute, client, senderResolver),
    parameters: patchParameterSchema(definition.parameters),
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
    return definition ? [patchCommandDefinition(definition, client, senderResolver)] : args;
  }

  if (mode.kind === "name-handler") {
    const name = args[0];
    const execute = args[1];
    const metadata = args[2];

    return [
      name,
      AUTO_SENDER_COMMAND_NAMES.has(String(name))
        ? wrapCommandExecute(String(name), execute as (...args: unknown[]) => unknown, client, senderResolver)
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
      ? wrapCommandExecute(String(name), execute as (...args: unknown[]) => unknown, client, senderResolver)
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
        entry !== "senderConnectionId" &&
        entry !== "sender_connection_id",
    );
  }

  const properties = isRecord(schema.properties)
    ? { ...schema.properties }
    : null;
  if (properties) {
    if (isRecord(properties.senderConnectionId)) {
      properties.senderConnectionId = annotateSenderProperty(properties.senderConnectionId);
    }
    if (isRecord(properties.sender_connection_id)) {
      properties.sender_connection_id = annotateSenderProperty(properties.sender_connection_id);
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
  if (!AUTO_SENDER_TOOL_NAMES.has(tool.name)) {
    return tool;
  }

  return {
    ...tool,
    execute: async (toolCallId: string, rawInput: unknown) => {
      try {
        const nextInput = await ensureSenderInput(rawInput, client, senderResolver);
        return await tool.execute(toolCallId, nextInput);
      } catch (error) {
        return toToolResult(
          `${tool.name} failed: ${toErrorMessage(error)}`,
          {
            error: toErrorMessage(error),
            errorType: error instanceof MahiloRequestError ? "network" : "input",
            retryable: error instanceof MahiloRequestError,
            status: "error",
            tool: tool.name,
          },
        );
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
    originalRegisterCommand.call(api, definition);
    return;
  }

  if (mode.kind === "name-handler") {
    const metadata = buildCommandMetadata(definition, mode.metadataStyle);
    if (metadata === undefined) {
      originalRegisterCommand.call(api, definition.name, definition.execute);
      return;
    }

    originalRegisterCommand.call(api, definition.name, definition.execute, metadata);
    return;
  }

  const metadata = buildCommandMetadata(definition, mode.metadataStyle);
  if (metadata === undefined) {
    originalRegisterCommand.call(api, definition.name, definition.description, definition.execute);
    return;
  }

  originalRegisterCommand.call(api, definition.name, definition.description, definition.execute, metadata);
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

function annotateSenderProperty(property: Record<string, unknown>): Record<string, unknown> {
  const description = readOptionalString(property.description);
  const suffix = "Optional after `mahilo setup`; the plugin will auto-select a default sender when omitted.";
  return {
    ...property,
    description: description ? `${description} ${suffix}` : suffix,
  };
}

function coerceCommandDefinition(value: unknown): CommandDefinitionLike | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.name !== "string" ||
    typeof value.label !== "string" ||
    typeof value.description !== "string" ||
    typeof value.execute !== "function"
  ) {
    return null;
  }

  return {
    description: value.description,
    execute: value.execute as (...args: unknown[]) => unknown,
    label: value.label,
    name: value.name,
    parameters: value.parameters,
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSenderConnectionId(input: Record<string, unknown>): string | undefined {
  return (
    readOptionalString(input.senderConnectionId) ??
    readOptionalString(input.sender_connection_id)
  );
}

function toCommandResult(text: string, details: Record<string, unknown>): Record<string, unknown> {
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
  return error instanceof MahiloRequestError && (error.status === 401 || error.status === 403);
}

function toToolResult(text: string, details: Record<string, unknown>): Record<string, unknown> {
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
      nextArgs[0] = await ensureSenderInput(nextArgs[0], client, senderResolver);
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

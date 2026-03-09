export * from "./tools";

import type { MahiloContractClient } from "./client";
import type { FetchMahiloPromptContextOptions } from "./prompt-context";
import {
  getMahiloContext as getMahiloContextBase,
  previewMahiloSend as previewMahiloSendBase,
  talkToAgent as talkToAgentBase,
  talkToGroup as talkToGroupBase,
  type GetMahiloContextInput,
  type MahiloSendToolInput,
  type MahiloToolContext,
  type PreviewMahiloSendInput,
  type TalkToGroupInput,
  type ToolExecutionOptions,
} from "./tools";

import { resolveMahiloSenderConnection } from "./sender-resolution";

export async function talkToAgent(
  client: MahiloContractClient,
  input: MahiloSendToolInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions = {}
) {
  return talkToAgentBase(client, input, await resolveToolContext(client, context), options);
}

export async function talkToGroup(
  client: MahiloContractClient,
  input: TalkToGroupInput,
  context: MahiloToolContext,
  options: ToolExecutionOptions = {}
) {
  return talkToGroupBase(client, input, await resolveToolContext(client, context), options);
}

export async function previewMahiloSend(
  client: MahiloContractClient,
  input: PreviewMahiloSendInput,
  context: MahiloToolContext
) {
  return previewMahiloSendBase(client, input, await resolveToolContext(client, context));
}

export async function getMahiloContext(
  client: MahiloContractClient,
  input: GetMahiloContextInput,
  options: FetchMahiloPromptContextOptions = {}
) {
  return getMahiloContextBase(
    client,
    {
      ...input,
      senderConnectionId: await resolveSenderConnectionId(client, input.senderConnectionId),
    },
    options
  );
}

async function resolveToolContext(
  client: MahiloContractClient,
  context: MahiloToolContext
): Promise<MahiloToolContext> {
  return {
    ...context,
    senderConnectionId: await resolveSenderConnectionId(client, context.senderConnectionId),
  };
}

async function resolveSenderConnectionId(
  client: MahiloContractClient,
  explicitSenderConnectionId?: string
): Promise<string> {
  const resolution = await resolveMahiloSenderConnection(client, {
    explicitSenderConnectionId,
  });
  return resolution.connectionId;
}

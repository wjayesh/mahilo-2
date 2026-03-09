import { describe, expect, it } from "bun:test";

import { InMemoryPluginState, registerMahiloDiagnosticsCommands, type MahiloPluginConfig } from "../src";

interface RegisteredCommand {
  execute: (input?: unknown) => Promise<unknown>;
  name: string;
}

function createConfig(): MahiloPluginConfig {
  return {
    apiKey: "mhl_test_secret",
    baseUrl: "https://mahilo.example",
    cacheTtlSeconds: 60,
    callbackPath: undefined,
    callbackUrl: undefined,
    contractVersion: "1.0.0",
    pluginVersion: "1.2.3",
    reviewMode: "ask"
  };
}

function toCommandMap(commands: RegisteredCommand[]): Map<string, RegisteredCommand> {
  return new Map(commands.map((command) => [command.name, command]));
}

function requireCommand(
  commands: Map<string, RegisteredCommand>,
  name: string
): RegisteredCommand {
  const command = commands.get(name);
  if (!command) {
    throw new Error(`expected command ${name} to be registered`);
  }

  return command;
}

describe("registerMahiloDiagnosticsCommands", () => {
  it("supports name/handler registration and lists review queue items", async () => {
    const commands: RegisteredCommand[] = [];
    const api = {
      registerCommand: (name: string, execute: RegisteredCommand["execute"]) => {
        commands.push({ execute, name });
      }
    };
    const client = {
      listBlockedEvents: async () => ({ items: [] }),
      listReviews: async (_params?: { limit?: number; status?: string }) => ({
        items: [
          {
            created_at: "2026-03-08T12:10:00.000Z",
            decision: "ask",
            recipient: "alice",
            review_id: "rev_123",
            selectors: {
              action: "share",
              direction: "outbound",
              resource: "location.current"
            },
            summary: "Current location share requires confirmation."
          }
        ],
        next_cursor: null
      })
    };

    registerMahiloDiagnosticsCommands(
      api as never,
      createConfig(),
      client as never,
      {
        pluginState: new InMemoryPluginState()
      }
    );

    const commandMap = toCommandMap(commands);
    expect(Array.from(commandMap.keys()).sort()).toEqual([
      "mahilo override",
      "mahilo reconnect",
      "mahilo review",
      "mahilo status"
    ]);

    const reviewCommand = requireCommand(commandMap, "mahilo review");
    const reviewResult = await reviewCommand.execute({ limit: 10, status: "open" });

    expect(reviewResult).toMatchObject({
      details: {
        command: "mahilo review",
        items: [
          {
            decision: "ask",
            recipient: "alice",
            reviewId: "rev_123"
          }
        ],
        limit: 10,
        status: "open"
      }
    });
  });

  it("creates user-scoped temporary overrides with recipient auto-resolution", async () => {
    const commands: RegisteredCommand[] = [];
    const overrideCalls: Record<string, unknown>[] = [];
    const promptContextCalls: Record<string, unknown>[] = [];
    const api = {
      registerCommand: (name: string, execute: RegisteredCommand["execute"]) => {
        commands.push({ execute, name });
      }
    };
    const client = {
      createOverride: async (payload: Record<string, unknown>) => {
        overrideCalls.push(payload);
        return {
          created: true,
          kind: "temporary",
          policy_id: "pol_temp_1"
        };
      },
      getPromptContext: async (payload: Record<string, unknown>) => {
        promptContextCalls.push(payload);
        return {
          ...payload,
          recipient: {
            id: "usr_alice",
            username: "alice"
          },
          suggested_selectors: {
            action: "share",
            direction: "outbound",
            resource: "location.current"
          }
        };
      },
      listBlockedEvents: async () => ({ items: [] }),
      listReviews: async () => ({ items: [] })
    };

    registerMahiloDiagnosticsCommands(api as never, createConfig(), client as never);

    const overrideCommand = requireCommand(toCommandMap(commands), "mahilo override");
    const overrideResult = await overrideCommand.execute({
      durationMinutes: 45,
      reason: "User approved sharing this for the next meeting.",
      recipient: "alice",
      selectors: {
        action: "share",
        resource: "location.current"
      },
      senderConnectionId: "conn_sender",
      sourceResolutionId: "res_123"
    });

    expect(overrideResult).toMatchObject({
      content: [
        {
          text: expect.stringContaining("temporary rule for 45 minutes")
        }
      ],
      details: {
        command: "mahilo override",
        created: true,
        kind: "temporary",
        policyId: "pol_temp_1",
        resolvedTargetId: "usr_alice"
      }
    });
    expect(promptContextCalls).toEqual([
      {
        draft_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        },
        include_recent_interactions: false,
        interaction_limit: 1,
        recipient: "alice",
        recipient_type: "user",
        sender_connection_id: "conn_sender"
      }
    ]);
    expect(overrideCalls).toEqual([
      {
        effect: "allow",
        kind: "temporary",
        reason: "User approved sharing this for the next meeting.",
        scope: "user",
        selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current"
        },
        sender_connection_id: "conn_sender",
        source_resolution_id: "res_123",
        target_id: "usr_alice",
        ttl_seconds: 2700
      }
    ]);
  });

  it("reports retry diagnostics when reconnect fails", async () => {
    const commands: RegisteredCommand[] = [];
    const api = {
      registerCommand: (command: {
        execute: RegisteredCommand["execute"];
        name: string;
      }) => {
        commands.push(command);
      }
    };

    let reviewCalls = 0;
    const client = {
      listBlockedEvents: async () => ({ items: [] }),
      listReviews: async () => {
        reviewCalls += 1;
        throw new Error("Mahilo request failed with status 503");
      }
    };

    registerMahiloDiagnosticsCommands(api as never, createConfig(), client as never);

    const reconnectCommand = requireCommand(toCommandMap(commands), "mahilo reconnect");
    const reconnectResult = await reconnectCommand.execute({
      attempts: 2,
      delayMs: 0
    });

    expect(reconnectResult).toMatchObject({
      details: {
        attempts: 2,
        command: "mahilo reconnect",
        connected: false,
        errors: [
          "attempt 1: Mahilo request failed with status 503",
          "attempt 2: Mahilo request failed with status 503"
        ]
      }
    });
    expect(reviewCalls).toBe(2);
  });
});

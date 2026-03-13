import { describe, expect, it } from "bun:test";

import {
  attachMahiloSenderResolutionCache,
  pickDefaultSenderConnection,
  resolveMahiloSenderConnection
} from "../src";

describe("sender resolution", () => {
  it("prefers active openclaw connections before lexical fallback", () => {
    const selection = pickDefaultSenderConnection([
      {
        id: "conn_zeta",
        isActive: true,
        label: "zeta"
      },
      {
        framework: "openclaw",
        id: "conn_openclaw",
        isActive: true,
        label: "primary"
      },
      {
        id: "conn_alpha",
        isActive: true,
        label: "alpha"
      }
    ]);

    expect(selection?.connection.id).toBe("conn_openclaw");
    expect(selection?.reason).toBe("preferred_framework");
  });

  it("uses a cached sender resolution after the first discovery", async () => {
    let listCalls = 0;
    const cache = new Map<string, unknown>();
    const client = {
      listOwnAgentConnections: async () => {
        listCalls += 1;
        return [
          {
            active: true,
            framework: "openclaw",
            id: "conn_sender_default",
            label: "primary"
          }
        ];
      }
    };

    attachMahiloSenderResolutionCache(client as never, {
      getCachedContext: (cacheKey: string) => cache.get(cacheKey),
      setCachedContext: (cacheKey: string, value: unknown) => {
        cache.set(cacheKey, value);
      }
    });

    const first = await resolveMahiloSenderConnection(client as never);
    const second = await resolveMahiloSenderConnection(client as never);

    expect(first.connectionId).toBe("conn_sender_default");
    expect(first.source).toBe("live");
    expect(second.connectionId).toBe("conn_sender_default");
    expect(second.source).toBe("cache");
    expect(listCalls).toBe(1);
  });

  it("keeps explicit sender overrides available for advanced routing", async () => {
    let listCalls = 0;
    const client = {
      listOwnAgentConnections: async () => {
        listCalls += 1;
        return [];
      }
    };

    const resolution = await resolveMahiloSenderConnection(client as never, {
      explicitSenderConnectionId: "conn_manual"
    });

    expect(resolution.connectionId).toBe("conn_manual");
    expect(resolution.selectionReason).toBe("explicit_override");
    expect(resolution.source).toBe("explicit");
    expect(listCalls).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CONTRACT_ENDPOINTS, MAHILO_CONTRACT_VERSION, MahiloContractClient } from "../src";

interface FetchCall {
  init?: RequestInit;
  input: RequestInfo | URL;
}

const nativeFetch = globalThis.fetch;

const fetchCalls: FetchCall[] = [];

describe("MahiloContractClient", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ init, input });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
  });

  it("uses documented context endpoint and required headers", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await client.getPromptContext({
      recipient: "alice",
      recipient_type: "user",
      sender_connection_id: "conn_123"
    });

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.context}`);
    expect(call.init?.method).toBe("POST");

    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer mahilo-key");
    expect(headers.get("x-mahilo-client")).toBe("openclaw-plugin");
    expect(headers.get("x-mahilo-plugin-version")).toBe("0.0.1");
    expect(headers.get("x-mahilo-contract-version")).toBe(MAHILO_CONTRACT_VERSION);
  });

  it("includes idempotency header for send operations", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example/",
      pluginVersion: "0.0.1"
    });

    await client.sendMessage({ message: "hello" }, "idem-123");

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.sendMessage}`);

    const headers = new Headers(call.init?.headers);
    expect(headers.get("idempotency-key")).toBe("idem-123");
  });

  it("supports listing reviews with query params", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await client.listReviews({ limit: 20, status: "open" });

    expect(fetchCalls).toHaveLength(1);

    const call = fetchCalls[0];
    expect(String(call.input)).toBe("https://mahilo.example/api/v1/plugin/reviews?status=open&limit=20");
    expect(call.init?.method).toBe("GET");
  });

  it("throws when Mahilo API returns a non-2xx response", async () => {
    globalThis.fetch = (async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await expect(client.resolveDraft({ message: "hello" })).rejects.toThrow(
      "Mahilo request failed with status 403: forbidden"
    );
  });
});

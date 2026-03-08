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

  it("lists reviews without a query string when params are missing", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await client.listReviews();

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe(`https://mahilo.example${CONTRACT_ENDPOINTS.reviews}`);
  });

  it("encodes review ids for decision endpoints", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await client.decideReview("review/with space", { decision: "approve" });

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe(
      "https://mahilo.example/api/v1/plugin/reviews/review%2Fwith%20space/decision"
    );
    expect(fetchCalls[0].init?.method).toBe("POST");
  });

  it("supports blocked events limit query", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await client.listBlockedEvents(25);

    expect(fetchCalls).toHaveLength(1);
    expect(String(fetchCalls[0].input)).toBe("https://mahilo.example/api/v1/plugin/events/blocked?limit=25");
    expect(fetchCalls[0].init?.method).toBe("GET");
  });

  it("returns undefined for 204 responses", async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    const result = await client.reportOutcome({ outcome: "sent" }, "idem-204");
    expect(result).toBeUndefined();
  });

  it("uses explicit contract version when provided", async () => {
    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      contractVersion: "9.9.9",
      pluginVersion: "0.0.1"
    });

    await client.resolveDraft({ message: "hello" });

    expect(fetchCalls).toHaveLength(1);
    const headers = new Headers(fetchCalls[0].init?.headers);
    expect(headers.get("x-mahilo-contract-version")).toBe("9.9.9");
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

  it("includes status only when error response body is empty", async () => {
    globalThis.fetch = (async () => {
      return new Response("", { status: 500 });
    }) as typeof fetch;

    const client = new MahiloContractClient({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      pluginVersion: "0.0.1"
    });

    await expect(client.resolveDraft({ message: "hello" })).rejects.toThrow(
      "Mahilo request failed with status 500"
    );
  });
});

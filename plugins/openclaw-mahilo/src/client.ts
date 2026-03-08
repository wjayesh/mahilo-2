import { CONTRACT_ENDPOINTS, MAHILO_CONTRACT_VERSION } from "./contract";

export interface MahiloClientOptions {
  apiKey: string;
  baseUrl: string;
  pluginVersion: string;
  contractVersion?: string;
}

export class MahiloContractClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly contractVersion: string;
  private readonly pluginVersion: string;

  constructor(options: MahiloClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.pluginVersion = options.pluginVersion;
    this.contractVersion = options.contractVersion ?? MAHILO_CONTRACT_VERSION;
  }

  async getPromptContext(payload: Record<string, unknown>) {
    return this.postJson(CONTRACT_ENDPOINTS.context, payload);
  }

  async resolveDraft(payload: Record<string, unknown>) {
    return this.postJson(CONTRACT_ENDPOINTS.resolve, payload);
  }

  async sendMessage(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.sendMessage, payload, idempotencyKey);
  }

  async reportOutcome(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.outcomes, payload, idempotencyKey);
  }

  async createOverride(payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.postJson(CONTRACT_ENDPOINTS.overrides, payload, idempotencyKey);
  }

  async listReviews(params?: { limit?: number; status?: string }) {
    const searchParams = new URLSearchParams();

    if (typeof params?.status === "string" && params.status.length > 0) {
      searchParams.set("status", params.status);
    }

    if (typeof params?.limit === "number") {
      searchParams.set("limit", String(params.limit));
    }

    const query = searchParams.toString();
    const endpoint = query.length > 0 ? `${CONTRACT_ENDPOINTS.reviews}?${query}` : CONTRACT_ENDPOINTS.reviews;

    return this.request(endpoint, { method: "GET" });
  }

  async decideReview(reviewId: string, payload: Record<string, unknown>) {
    const encodedReviewId = encodeURIComponent(reviewId);
    const endpoint = `${CONTRACT_ENDPOINTS.reviews}/${encodedReviewId}/decision`;

    return this.postJson(endpoint, payload);
  }

  async listBlockedEvents(limit?: number) {
    const endpoint =
      typeof limit === "number"
        ? `${CONTRACT_ENDPOINTS.blockedEvents}?limit=${encodeURIComponent(String(limit))}`
        : CONTRACT_ENDPOINTS.blockedEvents;

    return this.request(endpoint, { method: "GET" });
  }

  private async postJson(endpoint: string, payload: Record<string, unknown>, idempotencyKey?: string) {
    return this.request(endpoint, {
      body: JSON.stringify(payload),
      headers: this.buildHeaders(idempotencyKey),
      method: "POST"
    });
  }

  private buildHeaders(idempotencyKey?: string) {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Mahilo-Client": "openclaw-plugin",
      "X-Mahilo-Contract-Version": this.contractVersion,
      "X-Mahilo-Plugin-Version": this.pluginVersion
    });

    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      headers.set("Idempotency-Key", idempotencyKey);
    }

    return headers;
  }

  private async request(endpoint: string, init: RequestInit) {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...init,
      headers: init.headers ?? this.buildHeaders()
    });

    if (!response.ok) {
      const body = await response.text();
      const detail = body.length > 0 ? `: ${body}` : "";
      throw new Error(`Mahilo request failed with status ${response.status}${detail}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    return (await response.json()) as unknown;
  }
}

export interface MahiloClientOptions {
  apiKey: string;
  baseUrl: string;
  pluginVersion: string;
  contractVersion?: string;
}
export type MahiloRequestErrorKind = "http" | "network";
export declare class MahiloRequestError extends Error {
  readonly kind: MahiloRequestErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(
    message: string,
    options: {
      kind: MahiloRequestErrorKind;
      status?: number;
    },
  );
}
export declare class MahiloContractClient {
  private readonly apiKey;
  private readonly baseUrl;
  private readonly contractVersion;
  private readonly pluginVersion;
  constructor(options: MahiloClientOptions);
  getPromptContext(payload: Record<string, unknown>): Promise<unknown>;
  resolveDraft(payload: Record<string, unknown>): Promise<unknown>;
  commitLocalDecision(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  sendMessage(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  reportOutcome(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  createOverride(
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown>;
  listReviews(params?: { limit?: number; status?: string }): Promise<unknown>;
  decideReview(
    reviewId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  listBlockedEvents(limit?: number): Promise<unknown>;
  private postJson;
  private buildHeaders;
  private request;
}

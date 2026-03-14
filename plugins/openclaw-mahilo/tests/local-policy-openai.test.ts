import { describe, expect, it } from "bun:test";

import type { CorePolicy } from "@mahilo/policy-core";
import {
  OPENAI_RESPONSES_API_URL,
  createOpenAILocalPolicyEvaluator,
  createOpenAILocalPolicyEvaluatorFactory,
  evaluateDirectSendBundleLocally,
  parseMahiloPluginConfig,
  resolveOpenAILocalPolicyConfig,
  type DirectSendPolicyBundle,
  type ResolvedOpenAILocalPolicyConfig,
} from "../src";

function createPolicy(
  overrides: Partial<CorePolicy> & Pick<CorePolicy, "id">,
): CorePolicy {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "global",
    effect: overrides.effect ?? "deny",
    evaluator: overrides.evaluator ?? "structured",
    policy_content: overrides.policy_content ?? {},
    effective_from: overrides.effective_from ?? null,
    expires_at: overrides.expires_at ?? null,
    max_uses: overrides.max_uses ?? null,
    remaining_uses: overrides.remaining_uses ?? null,
    source: overrides.source ?? "user_created",
    derived_from_message_id: overrides.derived_from_message_id ?? null,
    learning_provenance: overrides.learning_provenance ?? null,
    priority: overrides.priority ?? 1,
    created_at: overrides.created_at ?? null,
  };
}

function createDirectBundle(): DirectSendPolicyBundle {
  return {
    contract_version: "1.0.0",
    bundle_type: "direct_send",
    bundle_metadata: {
      bundle_id: "bundle_direct_openai_1",
      resolution_id: "res_direct_openai_1",
      issued_at: "2026-03-14T10:30:00.000Z",
      expires_at: "2026-03-14T10:35:00.000Z",
    },
    authenticated_identity: {
      sender_user_id: "usr_sender",
      sender_connection_id: "conn_sender",
    },
    selector_context: {
      action: "share",
      direction: "outbound",
      resource: "location.current",
    },
    recipient: {
      id: "usr_alice",
      type: "user",
      username: "alice",
    },
    applicable_policies: [
      createPolicy({
        id: "pol_user_llm",
        scope: "user",
        effect: "deny",
        evaluator: "llm",
        priority: 100,
        policy_content: "Never share exact location without consent.",
      }),
    ],
    llm: {
      subject: "alice",
      provider_defaults: {
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
      },
    },
  };
}

function createResolvedConfig(
  overrides: Partial<ResolvedOpenAILocalPolicyConfig> = {},
): ResolvedOpenAILocalPolicyConfig {
  return {
    apiKey: overrides.apiKey ?? "sk-openai-test",
    apiKeyEnvVar: overrides.apiKeyEnvVar,
    authProfile: overrides.authProfile,
    credentialSource: overrides.credentialSource ?? "inline",
    model: overrides.model ?? "gpt-4o-mini",
    provider: "openai",
    timeout: overrides.timeout ?? 5000,
  };
}

describe("local policy OpenAI adapter", () => {
  it("evaluates applicable LLM policies through OpenAI using the runtime factory", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> | undefined;
    let signalSeen = false;

    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        model: "gpt-4o-mini",
        timeout: 9000,
        apiKey: "sk-local-policy-openai",
      },
    });

    const result = await evaluateDirectSendBundleLocally(
      createDirectBundle(),
      {
        message: "Alice is at home right now.",
        context: "User asked for an exact location update.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async (input, init) => {
              capturedUrl = String(input);
              capturedHeaders = new Headers(init?.headers);
              capturedBody = JSON.parse(
                String(init?.body ?? "{}"),
              ) as Record<string, unknown>;
              signalSeen = init?.signal instanceof AbortSignal;

              return new Response(
                JSON.stringify({
                  output: [
                    {
                      type: "message",
                      content: [
                        {
                          type: "output_text",
                          text: "FAIL\nExact location requires consent.",
                        },
                      ],
                    },
                  ],
                }),
                { status: 200 },
              );
            }) as typeof fetch,
          },
        ),
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      },
    );

    expect(capturedUrl).toBe(OPENAI_RESPONSES_API_URL);
    expect(capturedHeaders.get("authorization")).toBe(
      "Bearer sk-local-policy-openai",
    );
    expect(capturedBody?.model).toBe("gpt-4o-mini");
    const prompt = String(capturedBody?.input ?? "");
    expect(prompt).toContain("Never share exact location without consent.");
    expect(prompt).toContain("Alice is at home right now.");
    expect(signalSeen).toBe(true);
    expect(result.local_decision).toMatchObject({
      decision: "deny",
      delivery_mode: "blocked",
      reason_code: "policy.deny.user.llm",
      summary: "Exact location requires consent.",
      winning_policy_id: "pol_user_llm",
    });
  });

  it("falls back to bundle-provided OpenAI defaults when plugin overrides are absent", () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
    });

    expect(
      resolveOpenAILocalPolicyConfig(runtimeConfig, {
        env: {
          OPENAI_API_KEY: "env-openai-key",
        },
        providerDefaults: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      }),
    ).toEqual({
      apiKey: "env-openai-key",
      apiKeyEnvVar: "OPENAI_API_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: "gpt-4o-mini",
      provider: "openai",
      timeout: 5000,
    });
  });

  it("does not inherit a non-OpenAI bundle model when the plugin forces provider=openai", () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
      },
    });

    expect(
      resolveOpenAILocalPolicyConfig(runtimeConfig, {
        env: {
          OPENAI_API_KEY: "env-openai-key",
        },
        providerDefaults: {
          provider: "anthropic",
          model: "claude-3-haiku-20240307",
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes timeout failures", async () => {
    const evaluator = createOpenAILocalPolicyEvaluator(createResolvedConfig(), {
      fetch: (async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }) as typeof fetch,
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toMatchObject({
      status: "error",
      error_kind: "timeout",
    });
    expect(result.error).toContain("aborted");
  });

  it("normalizes auth failures", async () => {
    const evaluator = createOpenAILocalPolicyEvaluator(createResolvedConfig(), {
      fetch: (async () =>
        new Response("Invalid API key", {
          status: 401,
          statusText: "Unauthorized",
        })) as typeof fetch,
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toMatchObject({
      status: "error",
      error_kind: "provider",
    });
    expect(result.error).toContain("401");
  });

  it("normalizes rate-limit failures", async () => {
    const evaluator = createOpenAILocalPolicyEvaluator(createResolvedConfig(), {
      fetch: (async () =>
        new Response("Rate limit exceeded", {
          status: 429,
          statusText: "Too Many Requests",
        })) as typeof fetch,
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toMatchObject({
      status: "error",
      error_kind: "provider",
    });
    expect(result.error).toContain("429");
  });

  it("normalizes server-side OpenAI failures", async () => {
    const evaluator = createOpenAILocalPolicyEvaluator(createResolvedConfig(), {
      fetch: (async () =>
        new Response("Internal server error", {
          status: 500,
          statusText: "Internal Server Error",
        })) as typeof fetch,
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toMatchObject({
      status: "error",
      error_kind: "provider",
    });
    expect(result.error).toContain("500");
  });

  it("normalizes malformed OpenAI output", async () => {
    const evaluator = createOpenAILocalPolicyEvaluator(createResolvedConfig(), {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toMatchObject({
      status: "error",
      error_kind: "invalid_response",
    });
    expect(result.error).toContain("Malformed response");
  });
});

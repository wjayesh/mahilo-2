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

function createDirectBundle(
  overrides: Partial<DirectSendPolicyBundle> = {},
): DirectSendPolicyBundle {
  const defaultBundle: DirectSendPolicyBundle = {
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

  return {
    ...defaultBundle,
    ...overrides,
    bundle_metadata: {
      ...defaultBundle.bundle_metadata,
      ...overrides.bundle_metadata,
    },
    authenticated_identity: {
      ...defaultBundle.authenticated_identity,
      ...overrides.authenticated_identity,
    },
    selector_context: {
      ...defaultBundle.selector_context,
      ...overrides.selector_context,
    },
    recipient: {
      ...defaultBundle.recipient,
      ...overrides.recipient,
    },
    applicable_policies:
      overrides.applicable_policies ?? defaultBundle.applicable_policies,
    llm: {
      ...defaultBundle.llm,
      ...overrides.llm,
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

function createOpenAIRuntimeConfig(
  localPolicyLLM: Record<string, unknown> = {},
) {
  return parseMahiloPluginConfig({
    apiKey: "mahilo-key",
    baseUrl: "https://mahilo.example",
    localPolicyLLM: {
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-local-policy-openai",
      ...localPolicyLLM,
    },
  });
}

function createOpenAIDirectBundle(
  overrides: Partial<DirectSendPolicyBundle> = {},
): DirectSendPolicyBundle {
  return createDirectBundle({
    ...overrides,
    llm: {
      subject: "alice",
      provider_defaults: {
        provider: "openai",
        model: "gpt-4o-mini",
      },
      ...overrides.llm,
    },
  });
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
              capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
                string,
                unknown
              >;
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

  it("prefers plugin-local OpenAI model and timeout over bundle defaults", () => {
    const runtimeConfig = createOpenAIRuntimeConfig({
      model: "gpt-4.1-mini",
      timeout: 12000,
      apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY",
      apiKey: undefined,
    });

    expect(
      resolveOpenAILocalPolicyConfig(runtimeConfig, {
        defaultTimeout: 1500,
        env: {
          MAHILO_OPENAI_POLICY_KEY: "env-openai-key",
          OPENAI_API_KEY: "provider-default-key",
        },
        providerDefaults: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      }),
    ).toEqual({
      apiKey: "env-openai-key",
      apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: "gpt-4.1-mini",
      provider: "openai",
      timeout: 12000,
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

  it("fails closed when an applicable llm policy has no OpenAI credentials configured", async () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
    });

    const result = await evaluateDirectSendBundleLocally(
      createDirectBundle({
        llm: {
          subject: "alice",
          provider_defaults: {
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      }),
      {
        message: "Alice is at home right now.",
        context: "User asked for an exact location update.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          { env: {} },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.unavailable",
    });
    expect(result.local_decision.summary).toContain(
      "policy.ask.llm.unavailable",
    );
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
    expect(result.commit_payload.local_decision.reason_code).toBe(
      "policy.ask.llm.unavailable",
    );
    expect(result.local_decision.diagnostics).toEqual(
      expect.objectContaining({
        bundle_id: "bundle_direct_openai_1",
        reason_code: "policy.ask.llm.unavailable",
        reason_kind: "degraded_llm_review",
        redaction: {
          context: "omitted",
          credentials: "omitted",
          message: "omitted",
          raw_prompt: "omitted",
        },
        llm: expect.objectContaining({
          applicable_policy_count: 1,
          degraded_cause: "unavailable",
          degraded_reason_code: "policy.ask.llm.unavailable",
          evaluator_invocation_count: 0,
          model: "gpt-4o-mini",
          provider: "openai",
          provider_invocation_count: 0,
        }),
      }),
    );
  });

  it("fails closed on OpenAI timeout errors", async () => {
    const runtimeConfig = createOpenAIRuntimeConfig();

    const result = await evaluateDirectSendBundleLocally(
      createOpenAIDirectBundle(),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () => {
              const error = new Error("The operation was aborted");
              error.name = "AbortError";
              throw error;
            }) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.timeout",
    });
    expect(result.local_decision.summary).toContain("policy.ask.llm.timeout");
    expect(result.local_decision.summary).toContain("aborted");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
  });

  it("fails closed on OpenAI transport errors and exposes degraded review details", async () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-local-policy-openai",
      },
    });

    const result = await evaluateDirectSendBundleLocally(
      createDirectBundle({
        llm: {
          subject: "alice",
          provider_defaults: {
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      }),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () => {
              throw new Error("socket hang up");
            }) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.network",
    });
    expect(result.local_decision.summary).toContain("policy.ask.llm.network");
    expect(result.local_decision.summary).toContain("socket hang up");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
    expect(result.local_decision.diagnostics).toEqual(
      expect.objectContaining({
        reason_code: "policy.ask.llm.network",
        reason_kind: "degraded_llm_review",
        timing_ms: expect.objectContaining({
          evaluation_ms: expect.any(Number),
          llm_evaluator_ms: expect.any(Number),
          provider_ms: expect.any(Number),
          total_ms: expect.any(Number),
        }),
        llm: expect.objectContaining({
          applicable_policy_count: 1,
          degraded_cause: "network",
          degraded_reason_code: "policy.ask.llm.network",
          evaluator_invocation_count: 1,
          model: "gpt-4o-mini",
          provider: "openai",
          provider_invocation_count: 1,
        }),
      }),
    );
    expect(JSON.stringify(result.local_decision.diagnostics)).not.toContain(
      "sk-local-policy-openai",
    );
    expect(JSON.stringify(result.local_decision.diagnostics)).not.toContain(
      "Alice is at home right now.",
    );
  });

  it("fails closed on OpenAI provider failures", async () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-local-policy-openai",
      },
    });

    const result = await evaluateDirectSendBundleLocally(
      createDirectBundle({
        llm: {
          subject: "alice",
          provider_defaults: {
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      }),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () =>
              new Response("Invalid API key", {
                status: 401,
                statusText: "Unauthorized",
              })) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.provider",
    });
    expect(result.local_decision.summary).toContain("policy.ask.llm.provider");
    expect(result.local_decision.summary).toContain("401");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
  });

  it("fails closed on OpenAI rate-limit failures", async () => {
    const runtimeConfig = createOpenAIRuntimeConfig();

    const result = await evaluateDirectSendBundleLocally(
      createOpenAIDirectBundle(),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () =>
              new Response("Rate limit exceeded", {
                status: 429,
                statusText: "Too Many Requests",
              })) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.provider",
    });
    expect(result.local_decision.summary).toContain("policy.ask.llm.provider");
    expect(result.local_decision.summary).toContain("429");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
  });

  it("fails closed on OpenAI server-side failures", async () => {
    const runtimeConfig = createOpenAIRuntimeConfig();

    const result = await evaluateDirectSendBundleLocally(
      createOpenAIDirectBundle(),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () =>
              new Response("Internal server error", {
                status: 503,
                statusText: "Service Unavailable",
              })) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.provider",
    });
    expect(result.local_decision.summary).toContain("policy.ask.llm.provider");
    expect(result.local_decision.summary).toContain("503");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
  });

  it("fails closed on malformed OpenAI output", async () => {
    const runtimeConfig = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-local-policy-openai",
      },
    });

    const result = await evaluateDirectSendBundleLocally(
      createDirectBundle({
        llm: {
          subject: "alice",
          provider_defaults: {
            provider: "openai",
            model: "gpt-4o-mini",
          },
        },
      }),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
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
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.invalid_response",
    });
    expect(result.local_decision.summary).toContain(
      "policy.ask.llm.invalid_response",
    );
    expect(result.local_decision.summary).toContain("Malformed response");
  });

  it("fails closed on invalid JSON from OpenAI", async () => {
    const runtimeConfig = createOpenAIRuntimeConfig();

    const result = await evaluateDirectSendBundleLocally(
      createOpenAIDirectBundle(),
      {
        message: "Alice is at home right now.",
      },
      {
        llmEvaluatorFactory: createOpenAILocalPolicyEvaluatorFactory(
          runtimeConfig,
          {
            fetch: (async () =>
              new Response("this is not json", {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                },
              })) as typeof fetch,
          },
        ),
      },
    );

    expect(result.local_decision).toMatchObject({
      decision: "ask",
      delivery_mode: "review_required",
      reason_code: "policy.ask.llm.invalid_response",
    });
    expect(result.local_decision.summary).toContain(
      "policy.ask.llm.invalid_response",
    );
    expect(result.local_decision.summary).toContain("invalid JSON");
    expect(result.recipient_results[0]).toMatchObject({
      should_send: false,
      transport_action: "hold",
    });
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

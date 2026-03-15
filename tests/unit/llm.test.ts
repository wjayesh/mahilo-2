import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
} from "bun:test";

const mockConfig = {
  llm: {
    apiKey: "test-api-key",
    model: "claude-3-haiku-20240307",
    timeoutMs: 5000,
    enabled: true,
  },
  trustedMode: true,
};

mock.module("../../src/config", () => ({
  config: mockConfig,
}));

import {
  createAnthropicLLMPolicyEvaluator,
  isLLMEnabled,
} from "../../src/services/llm";

describe("Anthropic LLM policy evaluator", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("isLLMEnabled", () => {
    it("returns true when the Anthropic API key is configured", () => {
      expect(isLLMEnabled()).toBe(true);
    });
  });

  describe("createAnthropicLLMPolicyEvaluator", () => {
    it("returns an evaluator when the Anthropic API key is configured", () => {
      expect(createAnthropicLLMPolicyEvaluator()).toBeDefined();
    });

    it("calls Anthropic with the shared policy prompt", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      globalThis.fetch = mock(async (_url: string, options: RequestInit) => {
        capturedBody = JSON.parse(options.body as string) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [
              {
                type: "text",
                text: "PASS\nThe message complies with the policy.",
              },
            ],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Never share credit card numbers",
        message: "Hello, how are you?",
        subject: "alice",
        context: "casual conversation",
      });

      expect(result.status).toBe("pass");
      expect(result.reasoning).toContain("complies");

      const messages = capturedBody?.messages as Array<{
        role: string;
        content: string;
      }>;
      expect(capturedBody?.model).toBe("claude-3-haiku-20240307");
      expect(capturedBody?.max_tokens).toBe(256);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toContain("Never share credit card numbers");
      expect(messages[0]?.content).toContain("Hello, how are you?");
      expect(messages[0]?.content).toContain("alice");
    });

    it("parses PASS responses as non-matches", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [
              {
                type: "text",
                text: "PASS\nThe message is safe and follows the policy.",
              },
            ],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Be polite",
        message: "Thanks for your help!",
        subject: "bob",
      });

      expect(result.status).toBe("pass");
      expect(result.reasoning).toBe(
        "The message is safe and follows the policy.",
      );
    });

    it("parses FAIL responses as policy matches", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [
              {
                type: "text",
                text: "FAIL\nThe message contains a credit card number which violates the policy.",
              },
            ],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Never share credit card numbers",
        message: "My card number is 4111111111111111",
        subject: "alice",
      });

      expect(result.status).toBe("match");
      expect(result.reasoning).toContain("credit card number");
    });

    it("normalizes timeout errors", async () => {
      globalThis.fetch = mock(async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(result.status).toBe("error");
      expect(result.error_kind).toBe("timeout");
      expect(result.error).toBeDefined();
    });

    it("normalizes API errors", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("Rate limit exceeded", { status: 429 });
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(result.status).toBe("error");
      expect(result.error_kind).toBe("provider");
      expect(result.error).toContain("429");
    });

    it("can fail open for the server resolver", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("Rate limit exceeded", { status: 429 });
      });

      const evaluator = createAnthropicLLMPolicyEvaluator({
        onError: "pass",
      });
      const result = await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(result.status).toBe("pass");
      expect(result.error_kind).toBe("provider");
      expect(result.error).toContain("429");
      expect(result.reasoning).toContain("defaulting to PASS");
    });

    it("normalizes empty provider responses as invalid output", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(result.status).toBe("error");
      expect(result.error_kind).toBe("invalid_response");
      expect(result.error).toContain("Empty response");
    });

    it("normalizes unclear model output as invalid output", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [
              { type: "text", text: "I'm not sure about this message..." },
            ],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      const result = await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(result.status).toBe("error");
      expect(result.error_kind).toBe("invalid_response");
      expect(result.error).toContain("Unclear response");
    });

    it("includes context in the Anthropic prompt when provided", async () => {
      let capturedPrompt = "";

      globalThis.fetch = mock(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as {
          messages: Array<{ content: string }>;
        };
        capturedPrompt = body.messages[0]?.content ?? "";
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "PASS\nContext was considered." }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
        context: "This is a reply to a previous message about dinner plans",
      });

      expect(capturedPrompt).toContain("MESSAGE CONTEXT:");
      expect(capturedPrompt).toContain("dinner plans");
    });

    it("omits the context section when no context is provided", async () => {
      let capturedPrompt = "";

      globalThis.fetch = mock(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as {
          messages: Array<{ content: string }>;
        };
        capturedPrompt = body.messages[0]?.content ?? "";
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "PASS\nNo context needed." }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      });

      const evaluator = createAnthropicLLMPolicyEvaluator();
      await evaluator!({
        policyContent: "Test policy",
        message: "Test message",
        subject: "alice",
      });

      expect(capturedPrompt).not.toContain("MESSAGE CONTEXT:");
    });
  });
});

describe("Anthropic LLM policy evaluator when disabled", () => {
  it("returns no evaluator when the Anthropic config is unavailable", async () => {
    const disabledConfig = {
      llm: {
        apiKey: "",
        model: "claude-3-haiku-20240307",
        timeoutMs: 5000,
        enabled: false,
      },
      trustedMode: true,
    };

    mock.module("../../src/config", () => ({
      config: disabledConfig,
    }));

    const { createAnthropicLLMPolicyEvaluator: createDisabledEvaluator } =
      await import("../../src/services/llm");

    expect(createDisabledEvaluator()).toBeUndefined();
  });
});

/**
 * Unit tests for LLM policy evaluation (PERM-025)
 */
import { describe, it, expect, mock, beforeAll, afterAll, afterEach } from "bun:test";

// We need to mock the config before importing the LLM service
const mockConfig = {
  llm: {
    apiKey: "test-api-key",
    model: "claude-3-haiku-20240307",
    timeoutMs: 5000,
    enabled: true,
  },
  trustedMode: true,
};

// Mock the config module
mock.module("../../src/config", () => ({
  config: mockConfig,
}));

// Import after mocking
import { evaluateLLMPolicy, isLLMEnabled } from "../../src/services/llm";

describe("LLM Policy Evaluation Service", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    // Save original fetch
    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    // Restore fetch after each test
    globalThis.fetch = originalFetch;
  });

  describe("isLLMEnabled", () => {
    it("should return true when API key is configured", () => {
      expect(isLLMEnabled()).toBe(true);
    });
  });

  describe("evaluateLLMPolicy", () => {
    it("should call Anthropic API with correct prompt", async () => {
      let capturedBody: any;

      // Mock successful response
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        capturedBody = JSON.parse(options.body as string);
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "PASS\nThe message complies with the policy." }],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      const result = await evaluateLLMPolicy(
        "Never share credit card numbers",
        "Hello, how are you?",
        "alice",
        "casual conversation"
      );

      expect(result.passed).toBe(true);
      expect(result.reasoning).toContain("complies");

      // Verify API was called correctly
      expect(capturedBody.model).toBe("claude-3-haiku-20240307");
      expect(capturedBody.max_tokens).toBe(256);
      expect(capturedBody.messages).toHaveLength(1);
      expect(capturedBody.messages[0].role).toBe("user");
      expect(capturedBody.messages[0].content).toContain("Never share credit card numbers");
      expect(capturedBody.messages[0].content).toContain("Hello, how are you?");
      expect(capturedBody.messages[0].content).toContain("alice");
    });

    it("should parse PASS response correctly", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [
              { type: "text", text: "PASS\nThe message is safe and follows the policy guidelines." },
            ],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      const result = await evaluateLLMPolicy("Be polite", "Thanks for your help!", "bob");

      expect(result.passed).toBe(true);
      expect(result.reasoning).toBe("The message is safe and follows the policy guidelines.");
    });

    it("should parse FAIL response correctly", async () => {
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
          { status: 200 }
        );
      });

      const result = await evaluateLLMPolicy(
        "Never share credit card numbers",
        "My card number is 4111111111111111",
        "alice"
      );

      expect(result.passed).toBe(false);
      expect(result.reasoning).toContain("credit card number");
    });

    it("should handle timeout gracefully", async () => {
      globalThis.fetch = mock(async () => {
        // Simulate a timeout by returning a never-resolving promise
        // But since we can't actually timeout in tests, we'll throw an abort error
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      });

      const result = await evaluateLLMPolicy(
        "Test policy",
        "Test message",
        "alice"
      );

      // Should default to PASS on timeout
      expect(result.passed).toBe(true);
      expect(result.error).toBeDefined();
    });

    it("should handle API errors gracefully", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("Rate limit exceeded", { status: 429 });
      });

      const result = await evaluateLLMPolicy("Test policy", "Test message", "alice");

      // Should default to PASS on API error
      expect(result.passed).toBe(true);
      expect(result.error).toContain("429");
    });

    it("should handle empty response gracefully", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      const result = await evaluateLLMPolicy("Test policy", "Test message", "alice");

      // Should default to PASS on empty response
      expect(result.passed).toBe(true);
      expect(result.error).toContain("Empty response");
    });

    it("should handle unclear response by defaulting to PASS", async () => {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "I'm not sure about this message..." }],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      const result = await evaluateLLMPolicy("Test policy", "Test message", "alice");

      // Should default to PASS when response doesn't start with PASS/FAIL
      expect(result.passed).toBe(true);
      expect(result.reasoning).toContain("Unclear response");
    });

    it("should include context in the prompt when provided", async () => {
      let capturedPrompt = "";

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        capturedPrompt = body.messages[0].content;
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "PASS\nContext was considered." }],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      await evaluateLLMPolicy(
        "Test policy",
        "Test message",
        "alice",
        "This is a reply to a previous message about dinner plans"
      );

      expect(capturedPrompt).toContain("MESSAGE CONTEXT:");
      expect(capturedPrompt).toContain("dinner plans");
    });

    it("should not include context section when context is not provided", async () => {
      let capturedPrompt = "";

      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        capturedPrompt = body.messages[0].content;
        return new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            content: [{ type: "text", text: "PASS\nNo context needed." }],
            stop_reason: "end_turn",
          }),
          { status: 200 }
        );
      });

      await evaluateLLMPolicy("Test policy", "Test message", "alice");

      expect(capturedPrompt).not.toContain("MESSAGE CONTEXT:");
    });
  });
});

describe("LLM Policy Evaluation - Disabled", () => {
  it("should return passed=true when LLM is disabled", async () => {
    // Create a new module instance with LLM disabled
    const disabledConfig = {
      llm: {
        apiKey: "",
        model: "claude-3-haiku-20240307",
        timeoutMs: 5000,
        enabled: false,
      },
      trustedMode: true,
    };

    // Mock the module again with disabled config
    mock.module("../../src/config", () => ({
      config: disabledConfig,
    }));

    // Re-import to get the new mock
    const { evaluateLLMPolicy: evaluateDisabled } = await import("../../src/services/llm");

    const result = await evaluateDisabled("Test policy", "Test message", "alice");

    expect(result.passed).toBe(true);
    expect(result.reasoning).toContain("not configured");
  });
});

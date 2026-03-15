import { describe, expect, it } from "bun:test";

import {
  buildLLMPolicyEvaluationPrompt,
  createLLMPolicyEvaluator,
  parseLLMPolicyEvaluationResponse,
} from "@mahilo/policy-core";

describe("policy core llm helpers", () => {
  it("builds a prompt with policy, subject, message, and context", () => {
    const prompt = buildLLMPolicyEvaluationPrompt({
      policyContent: "Never share home addresses",
      message: "Alice lives on Main Street",
      subject: "alice",
      context: "The sender is answering a direct question",
    });

    expect(prompt).toContain("POLICY: Never share home addresses");
    expect(prompt).toContain("MESSAGE TO: alice");
    expect(prompt).toContain("MESSAGE CONTENT: Alice lives on Main Street");
    expect(prompt).toContain(
      "MESSAGE CONTEXT: The sender is answering a direct question",
    );
    expect(prompt).toContain("Answer with PASS or FAIL on the first line");
  });

  it("omits the context section when the input has no context", () => {
    const prompt = buildLLMPolicyEvaluationPrompt({
      policyContent: "Never share home addresses",
      message: "Alice lives on Main Street",
      subject: "alice",
    });

    expect(prompt).not.toContain("MESSAGE CONTEXT:");
  });

  it("parses PASS responses into non-match results", () => {
    expect(
      parseLLMPolicyEvaluationResponse(
        "PASS\nThe message complies with the policy.",
      ),
    ).toEqual({
      status: "pass",
      reasoning: "The message complies with the policy.",
    });
  });

  it("parses FAIL responses into match results", () => {
    expect(
      parseLLMPolicyEvaluationResponse(
        "FAIL\nThe message exposes protected details.",
      ),
    ).toEqual({
      status: "match",
      reasoning: "The message exposes protected details.",
    });
  });

  it("treats empty responses as invalid output", () => {
    expect(parseLLMPolicyEvaluationResponse("   ")).toEqual({
      status: "error",
      reasoning: "Empty response from LLM provider",
      error: "Empty response from LLM provider",
      error_kind: "invalid_response",
    });
  });

  it("treats unclear responses as invalid output", () => {
    expect(
      parseLLMPolicyEvaluationResponse("I cannot determine compliance."),
    ).toEqual({
      status: "error",
      reasoning: "Unclear response: I cannot determine compliance.",
      error: "Unclear response: I cannot determine compliance.",
      error_kind: "invalid_response",
    });
  });

  it("creates a provider-neutral evaluator from an injected adapter", async () => {
    let capturedPrompt = "";

    const evaluator = createLLMPolicyEvaluator({
      providerAdapter: async ({ prompt }) => {
        capturedPrompt = prompt;
        return {
          text: "FAIL\nThe message should be blocked.",
          provider: "test-provider",
          model: "test-model",
        };
      },
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(capturedPrompt).toContain("Never share secrets");
    expect(result).toEqual({
      status: "match",
      reasoning: "The message should be blocked.",
    });
  });

  it("normalizes provider adapter errors", async () => {
    const evaluator = createLLMPolicyEvaluator({
      providerAdapter: async () => {
        throw new Error("socket hang up");
      },
      normalizeError: () => ({
        kind: "network",
        message: "Provider transport failed",
      }),
    });

    const result = await evaluator({
      policyContent: "Never share secrets",
      message: "The password is hunter2",
      subject: "alice",
    });

    expect(result).toEqual({
      status: "error",
      reasoning: "Provider transport failed",
      error: "Provider transport failed",
      error_kind: "network",
    });
  });
});

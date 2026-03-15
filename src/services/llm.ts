/**
 * Anthropic provider adapter for policy evaluation.
 *
 * Prompt construction and PASS/FAIL parsing live in the shared policy core.
 */

import { config } from "../config";
import {
  createLLMPolicyEvaluator,
  normalizeLLMPolicyEvaluationError,
  type LLMPolicyEvaluationError,
  type LLMPolicyEvaluationResult,
  type LLMPolicyEvaluator,
  type LLMProviderAdapter,
} from "@mahilo/policy-core";

interface MessageContent {
  type: "text";
  text: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | MessageContent[];
}

interface AnthropicResponse {
  id: string;
  type: "message";
  content: Array<{ type: "text"; text: string }>;
  stop_reason: string;
}

export interface CreateAnthropicLLMPolicyEvaluatorOptions {
  onError?: "error" | "pass";
}

/**
 * Check if LLM evaluation is available
 */
export function isLLMEnabled(): boolean {
  return config.llm.enabled && !!config.llm.apiKey;
}

export function createAnthropicLLMPolicyEvaluator(
  options: CreateAnthropicLLMPolicyEvaluatorOptions = {},
): LLMPolicyEvaluator | undefined {
  const providerAdapter = createAnthropicProviderAdapter();
  if (!providerAdapter) {
    return undefined;
  }

  return createLLMPolicyEvaluator({
    providerAdapter,
    normalizeError: normalizeAnthropicError,
    onError:
      options.onError === "pass"
        ? (error, _input): LLMPolicyEvaluationResult => ({
            status: "pass",
            reasoning: "LLM evaluation failed, defaulting to PASS",
            error: error.message,
            error_kind: error.kind,
          })
        : undefined,
  });
}

function createAnthropicProviderAdapter(): LLMProviderAdapter | undefined {
  if (!isLLMEnabled()) {
    return undefined;
  }

  return async ({ prompt }) => ({
    text: await callAnthropic(prompt),
    provider: "anthropic",
    model: config.llm.model,
  });
}

function normalizeAnthropicError(error: unknown): LLMPolicyEvaluationError {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /timed?\s*out/iu.test(error.message)) {
      return {
        kind: "timeout",
        message: error.message || "Anthropic request timed out",
      };
    }

    if (/empty response/iu.test(error.message)) {
      return {
        kind: "invalid_response",
        message: error.message,
      };
    }

    if (/anthropic api error/iu.test(error.message)) {
      return {
        kind: "provider",
        message: error.message,
      };
    }

    if (
      /network|fetch|enotfound|econnrefused|econnreset|eai_again/iu.test(
        error.message,
      )
    ) {
      return {
        kind: "network",
        message: error.message,
      };
    }
  }

  return normalizeLLMPolicyEvaluationError(error, "provider");
}

/**
 * Call Anthropic API
 */
async function callAnthropic(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.llm.timeoutMs);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.llm.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ] as AnthropicMessage[],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    if (!data.content || data.content.length === 0) {
      throw new Error("Empty response from Anthropic API");
    }

    return data.content[0].text;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * LLM client for policy evaluation (PERM-015, PERM-016)
 *
 * Uses Anthropic's Claude API to evaluate LLM-based policies.
 */

import { config } from "../config";
import {
  buildLLMPolicyEvaluationPrompt,
  parseLLMPolicyEvaluationResponse,
} from "../policy/core";

interface LLMEvaluationResult {
  passed: boolean;
  reasoning: string;
  error?: string;
}

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

/**
 * Check if LLM evaluation is available
 */
export function isLLMEnabled(): boolean {
  return config.llm.enabled && !!config.llm.apiKey;
}

/**
 * Evaluate a message against an LLM policy
 *
 * @param policyContent - The policy description/prompt
 * @param message - The message content to evaluate
 * @param recipientUsername - The recipient's username
 * @param context - Optional context about the message
 * @returns Evaluation result with pass/fail and reasoning
 */
export async function evaluateLLMPolicy(
  policyContent: string,
  message: string,
  recipientUsername: string,
  context?: string
): Promise<LLMEvaluationResult> {
  if (!isLLMEnabled()) {
    console.warn("LLM evaluation not configured, defaulting to PASS");
    return {
      passed: true,
      reasoning: "LLM evaluation not configured (no ANTHROPIC_API_KEY)",
    };
  }

  const prompt = buildLLMPolicyEvaluationPrompt({
    policyContent,
    message,
    subject: recipientUsername,
    context,
  });

  try {
    const response = await callAnthropic(prompt);
    return parseLLMPolicyEvaluationResponse(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("LLM policy evaluation failed:", errorMessage);

    // Default to PASS on error to avoid blocking messages unnecessarily
    return {
      passed: true,
      reasoning: "LLM evaluation failed, defaulting to PASS",
      error: errorMessage,
    };
  }
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

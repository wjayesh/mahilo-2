import type {
  CreateLLMPolicyEvaluatorOptions,
  LLMPolicyEvaluationError,
  LLMPolicyEvaluationErrorKind,
  LLMPolicyEvaluationInput,
  LLMPolicyEvaluationResult,
  LLMPolicyEvaluator,
  ParsedLLMPolicyEvaluation,
} from "./types";

function extractReasoning(
  lines: string[],
  firstLine: string,
  prefix: "PASS" | "FAIL",
): string {
  const inlineReasoning = firstLine
    .slice(prefix.length)
    .replace(/^[:\-\s]+/u, "")
    .trim();

  if (inlineReasoning.length > 0) {
    return inlineReasoning;
  }

  return lines.slice(1).join("\n").trim() || "No reasoning provided";
}

function toErrorResult(
  kind: LLMPolicyEvaluationErrorKind,
  message: string,
): ParsedLLMPolicyEvaluation {
  return {
    status: "error",
    reasoning: message,
    error: message,
    error_kind: kind,
  };
}

export function buildLLMPolicyEvaluationPrompt(
  input: LLMPolicyEvaluationInput,
): string {
  let prompt = `You are evaluating if a message complies with a policy.

POLICY: ${input.policyContent}

MESSAGE TO: ${input.subject}
MESSAGE CONTENT: ${input.message}`;

  if (input.context) {
    prompt += `\nMESSAGE CONTEXT: ${input.context}`;
  }

  prompt += `

Does this message comply with the policy?
Answer with PASS or FAIL on the first line, followed by brief reasoning on the next line.
Do not include any other text before PASS or FAIL.`;

  return prompt;
}

export function parseLLMPolicyEvaluationResponse(
  response: string,
): ParsedLLMPolicyEvaluation {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return toErrorResult(
      "invalid_response",
      "Empty response from LLM provider",
    );
  }

  const lines = trimmed.split(/\r?\n/u);
  const rawFirstLine = lines[0]?.trim() || "";
  const firstLine = rawFirstLine.toUpperCase();

  if (firstLine.startsWith("PASS")) {
    return {
      status: "pass",
      reasoning: extractReasoning(lines, rawFirstLine, "PASS"),
    };
  }

  if (firstLine.startsWith("FAIL")) {
    return {
      status: "match",
      reasoning: extractReasoning(lines, rawFirstLine, "FAIL"),
    };
  }

  return toErrorResult("invalid_response", `Unclear response: ${response}`);
}

export function normalizeLLMPolicyEvaluationError(
  error: unknown,
  fallbackKind: LLMPolicyEvaluationErrorKind = "unknown",
): LLMPolicyEvaluationError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error &&
    typeof error.kind === "string" &&
    typeof error.message === "string"
  ) {
    return {
      kind: error.kind as LLMPolicyEvaluationErrorKind,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return {
        kind: "timeout",
        message: error.message || "LLM request timed out",
      };
    }

    return {
      kind: fallbackKind,
      message: error.message || "LLM evaluation failed",
    };
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return {
      kind: fallbackKind,
      message: error,
    };
  }

  return {
    kind: fallbackKind,
    message: "LLM evaluation failed",
  };
}

function toErrorEvaluationResult(
  error: LLMPolicyEvaluationError,
): LLMPolicyEvaluationResult {
  return {
    status: "error",
    reasoning: error.message,
    error: error.message,
    error_kind: error.kind,
  };
}

function withProviderMetadata(
  result: LLMPolicyEvaluationResult,
  metadata: {
    model?: string;
    provider?: string;
    provider_duration_ms?: number;
  },
): LLMPolicyEvaluationResult {
  return {
    ...result,
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(typeof metadata.provider_duration_ms === "number"
      ? { provider_duration_ms: metadata.provider_duration_ms }
      : {}),
  };
}

export function createLLMPolicyEvaluator(
  options: CreateLLMPolicyEvaluatorOptions,
): LLMPolicyEvaluator {
  return async (input) => {
    const prompt = buildLLMPolicyEvaluationPrompt(input);
    const providerStart = performance.now();

    try {
      const response = await options.providerAdapter({
        input,
        prompt,
      });
      const providerDuration = Math.max(0, performance.now() - providerStart);
      const parsed = parseLLMPolicyEvaluationResponse(response.text);
      const providerMetadata = {
        model: response.model,
        provider: response.provider,
        provider_duration_ms: providerDuration,
      };

      if (parsed.status !== "error") {
        return withProviderMetadata(parsed, providerMetadata);
      }

      const normalizedError: LLMPolicyEvaluationError = {
        kind: parsed.error_kind ?? "invalid_response",
        message: parsed.error || parsed.reasoning || "LLM evaluation failed",
      };

      if (options.onError) {
        return withProviderMetadata(
          await options.onError(normalizedError, input),
          providerMetadata,
        );
      }

      return withProviderMetadata(parsed, providerMetadata);
    } catch (error) {
      const providerDuration = Math.max(0, performance.now() - providerStart);
      const normalizedError =
        options.normalizeError?.(error) ||
        normalizeLLMPolicyEvaluationError(error);

      if (options.onError) {
        return withProviderMetadata(
          await options.onError(normalizedError, input),
          {
            provider_duration_ms: providerDuration,
          },
        );
      }

      return withProviderMetadata(toErrorEvaluationResult(normalizedError), {
        provider_duration_ms: providerDuration,
      });
    }
  };
}

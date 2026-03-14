import type {
  LLMPolicyEvaluationInput,
  ParsedLLMPolicyEvaluation,
} from "./types";

export function buildLLMPolicyEvaluationPrompt(
  input: LLMPolicyEvaluationInput
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
  response: string
): ParsedLLMPolicyEvaluation {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return {
      passed: true,
      reasoning: "Unclear response: ",
    };
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0]?.trim().toUpperCase() || "";

  if (firstLine.startsWith("PASS")) {
    return {
      passed: true,
      reasoning: lines.slice(1).join("\n").trim() || "No reasoning provided",
    };
  }

  if (firstLine.startsWith("FAIL")) {
    return {
      passed: false,
      reasoning: lines.slice(1).join("\n").trim() || "No reasoning provided",
    };
  }

  return {
    passed: true,
    reasoning: `Unclear response: ${response}`,
  };
}

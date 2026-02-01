/**
 * Policy summary generation (PERM-013)
 *
 * Generates human-readable summaries of policies to help agents understand
 * what's allowed and what's blocked before crafting a response.
 */

import { config } from "../config";
import { isLLMEnabled } from "./llm";

interface PolicyInfo {
  id: string;
  scope: string;
  target_id?: string | null;
  policy_type: string;
  policy_content: string;
  priority: number;
}

interface HeuristicRules {
  maxLength?: number;
  minLength?: number;
  blockedPatterns?: string[];
  requiredPatterns?: string[];
  requireContext?: boolean;
  trustedRecipients?: string[];
  blockedRecipients?: string[];
}

/**
 * Generate a human-readable summary of applicable policies
 *
 * @param policies - List of policies to summarize
 * @param roles - List of roles the recipient has
 * @returns A concise summary string
 */
export async function generatePolicySummary(
  policies: PolicyInfo[],
  roles: string[]
): Promise<string> {
  if (policies.length === 0) {
    return "No specific policies apply. Standard communication guidelines apply.";
  }

  // For MVP, generate a simple rule-based summary
  // Later, this could use LLM for more natural summaries
  const summaryParts: string[] = [];

  // Group policies by type
  const heuristicPolicies = policies.filter((p) => p.policy_type === "heuristic");
  const llmPolicies = policies.filter((p) => p.policy_type === "llm");

  // Summarize heuristic rules
  if (heuristicPolicies.length > 0) {
    const heuristicSummary = summarizeHeuristicPolicies(heuristicPolicies);
    if (heuristicSummary) {
      summaryParts.push(heuristicSummary);
    }
  }

  // Summarize LLM policies (extract key topics)
  if (llmPolicies.length > 0) {
    const llmSummary = summarizeLLMPolicies(llmPolicies);
    if (llmSummary) {
      summaryParts.push(llmSummary);
    }
  }

  // Add role context
  if (roles.length > 0) {
    summaryParts.push(`Recipient has roles: ${roles.join(", ")}.`);
  }

  return summaryParts.join(" ") || "Standard communication guidelines apply.";
}

/**
 * Summarize heuristic policies into readable rules
 */
function summarizeHeuristicPolicies(policies: PolicyInfo[]): string {
  const restrictions: string[] = [];

  for (const policy of policies) {
    try {
      const rules = JSON.parse(policy.policy_content) as HeuristicRules;

      if (rules.maxLength) {
        restrictions.push(`max ${rules.maxLength} characters`);
      }

      if (rules.minLength) {
        restrictions.push(`min ${rules.minLength} characters`);
      }

      if (rules.blockedPatterns && rules.blockedPatterns.length > 0) {
        // Detect common patterns
        const hasSSN = rules.blockedPatterns.some((p) =>
          p.toLowerCase().includes("ssn") || p.includes("\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{4}")
        );
        const hasCreditCard = rules.blockedPatterns.some((p) =>
          p.includes("\\d{16}") || p.includes("\\d{4}")
        );
        const hasPassword = rules.blockedPatterns.some((p) =>
          p.toLowerCase().includes("password") || p.toLowerCase().includes("secret")
        );
        const hasApiKey = rules.blockedPatterns.some((p) =>
          p.toLowerCase().includes("api") && p.toLowerCase().includes("key")
        );

        if (hasCreditCard) restrictions.push("no credit card numbers");
        if (hasSSN) restrictions.push("no SSN or social security numbers");
        if (hasPassword) restrictions.push("no passwords or secrets");
        if (hasApiKey) restrictions.push("no API keys");
      }

      if (rules.requireContext) {
        restrictions.push("context required for messages");
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (restrictions.length === 0) {
    return "";
  }

  return `Restrictions: ${restrictions.join(", ")}.`;
}

/**
 * Summarize LLM policies by extracting key topics
 */
function summarizeLLMPolicies(policies: PolicyInfo[]): string {
  const topics: string[] = [];

  for (const policy of policies) {
    const content = policy.policy_content.toLowerCase();

    // Extract common topics
    if (content.includes("address") || content.includes("location")) {
      if (content.includes("never") || content.includes("block") || content.includes("exact")) {
        topics.push("no exact addresses/locations");
      } else if (content.includes("city") || content.includes("general")) {
        topics.push("city-level location only");
      }
    }

    if (content.includes("calendar")) {
      if (content.includes("availability") || content.includes("free/busy")) {
        topics.push("calendar availability OK");
      }
      if (content.includes("close friend") && content.includes("detail")) {
        topics.push("event details for close friends only");
      }
    }

    if (content.includes("personal") || content.includes("private")) {
      topics.push("be careful with personal info");
    }

    if (content.includes("professional") || content.includes("work")) {
      topics.push("maintain professional tone");
    }
  }

  // Deduplicate
  const uniqueTopics = [...new Set(topics)];

  if (uniqueTopics.length === 0) {
    return `${policies.length} content policies apply.`;
  }

  return `Guidelines: ${uniqueTopics.join("; ")}.`;
}

/**
 * Generate a more detailed summary using LLM (optional, for enhanced mode)
 * This can be enabled in the future for higher-quality summaries.
 */
export async function generateLLMSummary(
  policies: PolicyInfo[],
  roles: string[],
  recipientName: string
): Promise<string | null> {
  if (!isLLMEnabled() || !config.trustedMode) {
    return null;
  }

  // For now, return null to use the rule-based summary
  // This can be implemented later if needed
  return null;
}

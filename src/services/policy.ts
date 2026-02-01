import { eq, and, or, desc, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getRolesForFriend } from "./roles";
import { evaluateLLMPolicy, isLLMEnabled } from "./llm";
import { config } from "../config";

interface HeuristicRules {
  maxLength?: number;
  minLength?: number;
  blockedPatterns?: string[];
  requiredPatterns?: string[];
  requireContext?: boolean;
  trustedRecipients?: string[];
  blockedRecipients?: string[];
}

interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

export function validatePolicyContent(
  policyType: string,
  content: string
): { valid: boolean; error?: string } {
  if (policyType === "heuristic") {
    try {
      const rules = JSON.parse(content) as HeuristicRules;

      // Validate rule types
      if (rules.maxLength !== undefined && typeof rules.maxLength !== "number") {
        return { valid: false, error: "maxLength must be a number" };
      }
      if (rules.minLength !== undefined && typeof rules.minLength !== "number") {
        return { valid: false, error: "minLength must be a number" };
      }
      if (rules.blockedPatterns !== undefined && !Array.isArray(rules.blockedPatterns)) {
        return { valid: false, error: "blockedPatterns must be an array" };
      }
      if (rules.requiredPatterns !== undefined && !Array.isArray(rules.requiredPatterns)) {
        return { valid: false, error: "requiredPatterns must be an array" };
      }

      // Validate regex patterns are valid
      if (rules.blockedPatterns) {
        for (const pattern of rules.blockedPatterns) {
          try {
            new RegExp(pattern);
          } catch {
            return { valid: false, error: `Invalid regex pattern: ${pattern}` };
          }
        }
      }

      if (rules.requiredPatterns) {
        for (const pattern of rules.requiredPatterns) {
          try {
            new RegExp(pattern);
          } catch {
            return { valid: false, error: `Invalid regex pattern: ${pattern}` };
          }
        }
      }

      return { valid: true };
    } catch {
      return { valid: false, error: "Policy content must be valid JSON" };
    }
  }

  if (policyType === "llm") {
    // LLM policies are just prompts
    if (typeof content !== "string" || content.trim().length === 0) {
      return { valid: false, error: "LLM policy must have a non-empty prompt" };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown policy type: ${policyType}` };
}

function evaluateHeuristicPolicy(
  rules: HeuristicRules,
  message: string,
  recipientUsername?: string
): PolicyResult {
  // Check length constraints
  if (rules.maxLength !== undefined && message.length > rules.maxLength) {
    return { allowed: false, reason: `Message exceeds maximum length of ${rules.maxLength}` };
  }

  if (rules.minLength !== undefined && message.length < rules.minLength) {
    return { allowed: false, reason: `Message is shorter than minimum length of ${rules.minLength}` };
  }

  // Check blocked patterns
  if (rules.blockedPatterns) {
    for (const pattern of rules.blockedPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(message)) {
        return { allowed: false, reason: `Message contains blocked pattern` };
      }
    }
  }

  // Check required patterns
  if (rules.requiredPatterns) {
    for (const pattern of rules.requiredPatterns) {
      const regex = new RegExp(pattern, "i");
      if (!regex.test(message)) {
        return { allowed: false, reason: `Message missing required pattern` };
      }
    }
  }

  // Check recipient restrictions
  if (recipientUsername) {
    if (rules.blockedRecipients?.includes(recipientUsername)) {
      return { allowed: false, reason: `Recipient is blocked by policy` };
    }

    if (rules.trustedRecipients && !rules.trustedRecipients.includes(recipientUsername)) {
      return { allowed: false, reason: `Recipient not in trusted list` };
    }
  }

  return { allowed: true };
}

export async function evaluatePolicies(
  senderUserId: string,
  recipientUserId: string,
  message: string,
  context?: string
): Promise<PolicyResult> {
  const db = getDb();

  // Get roles the sender has assigned to the recipient
  const recipientRoles = await getRolesForFriend(senderUserId, recipientUserId);

  // Build policy query conditions
  const policyConditions = [
    // Global policies
    eq(schema.policies.scope, "global"),
    // Per-user policies for this recipient
    and(
      eq(schema.policies.scope, "user"),
      eq(schema.policies.targetId, recipientUserId)
    ),
  ];

  // Add role-scoped policies if recipient has roles
  if (recipientRoles.length > 0) {
    policyConditions.push(
      and(
        eq(schema.policies.scope, "role"),
        sql`${schema.policies.targetId} IN ${recipientRoles}`
      )
    );
  }

  // Get sender's policies
  const policies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, senderUserId),
        eq(schema.policies.enabled, true),
        or(...policyConditions)
      )
    )
    .orderBy(desc(schema.policies.priority));

  if (policies.length === 0) {
    return { allowed: true };
  }

  // Get recipient username for policy evaluation
  const [recipient] = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, recipientUserId))
    .limit(1);

  const recipientUsername = recipient?.username;

  // Evaluate policies in priority order
  for (const policy of policies) {
    if (policy.policyType === "heuristic") {
      try {
        const rules = JSON.parse(policy.policyContent) as HeuristicRules;

        // Check context requirement
        if (rules.requireContext && !context) {
          return { allowed: false, reason: "Context is required for this message" };
        }

        const result = evaluateHeuristicPolicy(rules, message, recipientUsername);
        if (!result.allowed) {
          return result;
        }
      } catch (e) {
        console.error(`Error evaluating policy ${policy.id}:`, e);
        // Continue to next policy on error
      }
    } else if (policy.policyType === "llm") {
      // LLM policy evaluation (PERM-016)
      // Only evaluate in trusted mode with LLM configured
      if (config.trustedMode && isLLMEnabled()) {
        try {
          const llmResult = await evaluateLLMPolicy(
            policy.policyContent,
            message,
            recipientUsername || "unknown",
            context
          );

          if (!llmResult.passed) {
            return {
              allowed: false,
              reason: llmResult.reasoning || "Message blocked by LLM policy",
            };
          }
        } catch (e) {
          console.error(`Error evaluating LLM policy ${policy.id}:`, e);
          // Continue to next policy on error (default to PASS)
        }
      } else {
        // Skip LLM policies when not in trusted mode or LLM not configured
        console.log(
          `Skipping LLM policy ${policy.id} (trustedMode=${config.trustedMode}, llmEnabled=${isLLMEnabled()})`
        );
      }
    }
  }

  return { allowed: true };
}

// Evaluate policies for group messages (REG-044)
export async function evaluateGroupPolicies(
  senderUserId: string,
  groupId: string,
  message: string,
  context?: string
): Promise<PolicyResult> {
  const db = getDb();

  // Evaluation order:
  // 1. Sender's global policies (highest priority first)
  // 2. Group policies (highest priority first)

  // Get sender's global policies
  const senderPolicies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.userId, senderUserId),
        eq(schema.policies.enabled, true),
        eq(schema.policies.scope, "global")
      )
    )
    .orderBy(desc(schema.policies.priority));

  // Get group policies (from all users who created policies for this group)
  const groupPolicies = await db
    .select()
    .from(schema.policies)
    .where(
      and(
        eq(schema.policies.enabled, true),
        eq(schema.policies.scope, "group"),
        eq(schema.policies.targetId, groupId)
      )
    )
    .orderBy(desc(schema.policies.priority));

  // Combine policies: sender global first, then group policies
  const allPolicies = [...senderPolicies, ...groupPolicies];

  if (allPolicies.length === 0) {
    return { allowed: true };
  }

  // Get group name for logging/errors
  const [group] = await db
    .select({ name: schema.groups.name })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);

  // Evaluate all policies
  for (const policy of allPolicies) {
    if (policy.policyType === "heuristic") {
      try {
        const rules = JSON.parse(policy.policyContent) as HeuristicRules;

        // Check context requirement
        if (rules.requireContext && !context) {
          return {
            allowed: false,
            reason: `Context is required for messages to group '${group?.name || groupId}'`,
          };
        }

        // Evaluate heuristic rules (without recipient username for groups)
        const result = evaluateHeuristicPolicy(rules, message);
        if (!result.allowed) {
          return {
            allowed: false,
            reason: `${result.reason} (group policy)`,
          };
        }
      } catch (e) {
        console.error(`Error evaluating group policy ${policy.id}:`, e);
        // Continue to next policy on error
      }
    } else if (policy.policyType === "llm") {
      // LLM policy evaluation (PERM-016)
      if (config.trustedMode && isLLMEnabled()) {
        try {
          const llmResult = await evaluateLLMPolicy(
            policy.policyContent,
            message,
            group?.name || groupId,
            context
          );

          if (!llmResult.passed) {
            return {
              allowed: false,
              reason: `${llmResult.reasoning || "Message blocked by LLM policy"} (group policy)`,
            };
          }
        } catch (e) {
          console.error(`Error evaluating LLM group policy ${policy.id}:`, e);
          // Continue to next policy on error (default to PASS)
        }
      } else {
        console.log(
          `Skipping LLM policy ${policy.id} (trustedMode=${config.trustedMode}, llmEnabled=${isLLMEnabled()})`
        );
      }
    }
  }

  return { allowed: true };
}

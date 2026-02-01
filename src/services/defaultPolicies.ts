/**
 * Default policy templates for new users (PERM-018, PERM-019)
 *
 * These policies are created automatically when a new user registers.
 * They provide sensible defaults for privacy and security.
 */

import { nanoid } from "nanoid";
import { getDb, schema } from "../db";

export interface DefaultPolicyTemplate {
  scope: "global" | "role" | "user" | "group";
  targetId: string | null;
  policyType: "heuristic" | "llm";
  policyContent: string;
  priority: number;
  enabled: boolean;
  description: string; // For documentation purposes
}

/**
 * Default policies that are created for every new user.
 *
 * These cover:
 * 1. Sensitive data patterns (credit cards, SSN, passwords)
 * 2. Location privacy (no exact addresses)
 * 3. Calendar event details (share availability, not details)
 */
export const defaultPolicies: DefaultPolicyTemplate[] = [
  // Block sensitive patterns (highest priority) - heuristic for speed
  {
    scope: "global",
    targetId: null,
    policyType: "heuristic",
    policyContent: JSON.stringify({
      blockedPatterns: [
        "\\b\\d{16}\\b", // Credit card numbers (16 digits)
        "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b", // Credit card with separators
        "\\bSSN[:\\s]*\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{4}\\b", // SSN patterns
        "\\bsocial\\s*security[:\\s]*\\d{3}[\\s-]?\\d{2}[\\s-]?\\d{4}\\b", // SSN spelled out
        "\\bpassword[:\\s]*\\S{4,}\\b", // Passwords being shared
        "\\bsecret\\s*key[:\\s]*\\S{8,}\\b", // Secret keys
        "\\bapi[_\\s-]?key[:\\s]*\\S{8,}\\b", // API keys
      ],
    }),
    priority: 100,
    enabled: true,
    description: "Block messages containing sensitive data patterns (credit cards, SSN, passwords)",
  },

  // Location privacy - LLM for nuanced understanding
  {
    scope: "global",
    targetId: null,
    policyType: "llm",
    policyContent:
      "Never share exact addresses, home location, or real-time coordinates. City-level location (e.g., 'in San Francisco' or 'visiting New York') is acceptable. General regions and countries are fine. Block any street addresses, apartment numbers, or GPS coordinates.",
    priority: 90,
    enabled: true,
    description: "Protect location privacy - allow city-level, block exact addresses",
  },

  // Calendar event details - LLM for context understanding
  {
    scope: "global",
    targetId: null,
    policyType: "llm",
    policyContent:
      "Share calendar availability (free/busy times) freely with friends. For specific event details (meeting names, attendees, descriptions), only share with close friends or when the user has explicitly approved. For example, saying 'I have a meeting at 3pm' is fine, but 'I have a doctor appointment at 3pm at Medical Center' needs more discretion.",
    priority: 80,
    enabled: true,
    description: "Control calendar detail sharing based on relationship",
  },
];

/**
 * Create default policies for a new user
 *
 * @param userId - The user ID to create policies for
 * @returns Number of policies created
 */
export async function createDefaultPoliciesForUser(userId: string): Promise<number> {
  const db = getDb();

  const policiesToInsert = defaultPolicies.map((template) => ({
    id: `pol_${nanoid()}`,
    userId,
    scope: template.scope,
    targetId: template.targetId,
    policyType: template.policyType,
    policyContent: template.policyContent,
    priority: template.priority,
    enabled: template.enabled,
  }));

  try {
    await db.insert(schema.policies).values(policiesToInsert);
    console.log(`Created ${policiesToInsert.length} default policies for user ${userId}`);
    return policiesToInsert.length;
  } catch (error) {
    // Log but don't fail registration if policy creation fails
    console.error(`Failed to create default policies for user ${userId}:`, error);
    return 0;
  }
}

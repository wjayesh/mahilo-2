import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  evaluatePolicies,
  evaluateGroupPolicies,
  validatePolicyContent,
  POLICY_RESOLVER_ORDER,
} from "../../src/services/policy";
import { canonicalToStorage } from "../../src/services/policySchema";
import {
  cleanupTestDatabase,
  createTestUser,
  createFriendship,
  createAgentConnection,
  getTestDb,
  setupTestDatabase,
  seedTestSystemRoles,
  addRoleToFriendship,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";
import { nanoid } from "nanoid";

describe("Policy Service", () => {
  describe("validatePolicyContent", () => {
    describe("heuristic policies", () => {
      it("should accept valid heuristic policy", () => {
        const content = JSON.stringify({
          maxLength: 1000,
          blockedPatterns: ["\\bcredit card\\b"],
        });
        expect(validatePolicyContent("heuristic", content).valid).toBe(true);
      });

      it("should reject invalid JSON", () => {
        const result = validatePolicyContent("heuristic", "not json");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("valid JSON");
      });

      it("should reject invalid maxLength type", () => {
        const content = JSON.stringify({ maxLength: "not a number" });
        const result = validatePolicyContent("heuristic", content);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("maxLength must be a number");
      });

      it("should reject invalid regex patterns", () => {
        const content = JSON.stringify({ blockedPatterns: ["[invalid(regex"] });
        const result = validatePolicyContent("heuristic", content);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Invalid regex");
      });

      it("should accept valid regex patterns", () => {
        const content = JSON.stringify({
          blockedPatterns: ["\\b\\d{16}\\b", "password", "ssn"],
          requiredPatterns: ["^[A-Z]"],
        });
        expect(validatePolicyContent("heuristic", content).valid).toBe(true);
      });
    });

    describe("llm policies", () => {
      it("should accept valid LLM policy prompt", () => {
        const prompt = "Analyze this message for safety: {message}";
        expect(validatePolicyContent("llm", prompt).valid).toBe(true);
      });

      it("should reject empty LLM policy", () => {
        const result = validatePolicyContent("llm", "");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("non-empty prompt");
      });

      it("should reject whitespace-only LLM policy", () => {
        const result = validatePolicyContent("llm", "   ");
        expect(result.valid).toBe(false);
      });
    });

    describe("unknown policy types", () => {
      it("should reject unknown policy types", () => {
        const result = validatePolicyContent("unknown", "content");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("Unknown policy evaluator");
      });
    });
  });

  describe("evaluatePolicies", () => {
    beforeAll(async () => {
      await setupTestDatabase();
    });

    afterAll(() => {
      cleanupTestDatabase();
    });

    it("should reject messages that violate heuristic policies", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("policy_sender");
      const { user: recipient } = await createTestUser("policy_recipient");

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["secret"] }),
        priority: 10,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "this is a secret");
      expect(result.allowed).toBe(false);
      expect(result.effect).toBe("deny");
      expect(result.reason_code).toBe("policy.deny.global.heuristic");
      expect(result.evaluated_policies).toHaveLength(1);
      expect(result.evaluated_policies[0]?.phase).toBe("deterministic");
      expect(result.evaluated_policies[0]?.matched).toBe(true);
      expect(result.winning_policy?.policy_id).toBe(result.winning_policy_id);
      expect(result.winning_policy?.evaluator).toBe("heuristic");
      expect(result.resolution_explanation.length).toBeGreaterThan(0);
    });

    it("should allow messages when policies pass", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("policy_sender_ok");
      const { user: recipient } = await createTestUser("policy_recipient_ok");

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ maxLength: 100 }),
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "hello");
      expect(result.allowed).toBe(true);
      expect(result.effect).toBe("allow");
      expect(result.reason_code).toBe("policy.allow.no_match");
      expect(result.evaluated_policies).toHaveLength(1);
      expect(result.evaluated_policies[0]?.matched).toBe(false);
    });

    it("should evaluate deterministic policies before contextual llm policies", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("phase_sender");
      const { user: recipient } = await createTestUser("phase_recipient");

      const deterministicPolicy = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 10,
        enabled: true,
      });
      const llmPolicy = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "ask",
        evaluator: "llm",
        policy_content: "Ask before sharing any message",
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });

      const deterministicPolicyId = nanoid();
      const llmPolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: deterministicPolicyId,
          userId: sender.id,
          scope: "global",
          policyType: deterministicPolicy.policyType,
          policyContent: deterministicPolicy.policyContent,
          direction: deterministicPolicy.direction,
          resource: deterministicPolicy.resource,
          action: deterministicPolicy.action,
          effect: deterministicPolicy.effect,
          evaluator: deterministicPolicy.evaluator,
          effectiveFrom: deterministicPolicy.effectiveFrom,
          expiresAt: deterministicPolicy.expiresAt,
          maxUses: deterministicPolicy.maxUses,
          remainingUses: deterministicPolicy.remainingUses,
          source: deterministicPolicy.source,
          derivedFromMessageId: deterministicPolicy.derivedFromMessageId,
          priority: 10,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: llmPolicyId,
          userId: sender.id,
          scope: "global",
          policyType: llmPolicy.policyType,
          policyContent: llmPolicy.policyContent,
          direction: llmPolicy.direction,
          resource: llmPolicy.resource,
          action: llmPolicy.action,
          effect: llmPolicy.effect,
          evaluator: llmPolicy.evaluator,
          effectiveFrom: llmPolicy.effectiveFrom,
          expiresAt: llmPolicy.expiresAt,
          maxUses: llmPolicy.maxUses,
          remainingUses: llmPolicy.remainingUses,
          source: llmPolicy.source,
          derivedFromMessageId: llmPolicy.derivedFromMessageId,
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(result.effect).toBe("deny");
      expect(result.reason_code).toBe("policy.deny.global.structured");
      expect(result.winning_policy_id).toBe(deterministicPolicyId);
      expect(result.winning_policy).toEqual(
        expect.objectContaining({
          policy_id: deterministicPolicyId,
          scope: "global",
          evaluator: "structured",
          effect: "deny",
          created_by_user_id: sender.id,
          source: "user_created",
          derived_from_message_id: null,
          max_uses: null,
          remaining_uses: null,
          priority: 10,
          phase: "deterministic",
          reason: "Policy has no constraints and applies to all messages",
        })
      );
      expect(result.evaluated_policies.map((policy) => policy.policy_id)).toEqual([
        deterministicPolicyId,
        llmPolicyId,
      ]);
      expect(result.evaluated_policies[0]?.phase).toBe("deterministic");
      expect(result.evaluated_policies[1]?.phase).toBe("contextual_llm");
      expect(result.evaluated_policies[0]?.created_by_user_id).toBe(sender.id);
      expect(result.evaluated_policies[0]?.source).toBe("user_created");
      expect(result.evaluated_policies[0]?.derived_from_message_id).toBeNull();
    });

    it("should expose resolver order with platform guardrails first", () => {
      expect(POLICY_RESOLVER_ORDER).toEqual(["platform_guardrails", "user_policies"]);
    });

    it("should include authenticated identity context when provided", async () => {
      const { user: sender } = await createTestUser("identity_sender_ok");
      const { user: recipient } = await createTestUser("identity_recipient_ok");
      const senderConnection = await createAgentConnection(sender.id, {
        callbackUrl: "polling://identity-sender-ok",
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message", undefined, {
        sender_user_id: sender.id,
        sender_connection_id: senderConnection.id,
      });

      expect(result.authenticated_identity).toEqual({
        sender_user_id: sender.id,
        sender_connection_id: senderConnection.id,
      });
    });

    it("should reject invalid authenticated sender connections before policy evaluation", async () => {
      const { user: sender } = await createTestUser("identity_sender_invalid");
      const { user: recipient } = await createTestUser("identity_recipient_invalid");

      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "neutral message",
        undefined,
        {
          sender_user_id: sender.id,
          sender_connection_id: "conn_missing_identity",
        }
      );

      expect(result.effect).toBe("deny");
      expect(result.reason_code).toBe("auth.sender_connection.invalid");
      expect(result.resolver_layer).toBe("platform_guardrails");
      expect(result.evaluated_policies).toHaveLength(0);
    });

    it("should reject authenticated identity mismatches before policy evaluation", async () => {
      const { user: sender } = await createTestUser("identity_sender_mismatch");
      const { user: recipient } = await createTestUser("identity_recipient_mismatch");
      const { user: otherUser } = await createTestUser("identity_other_user");
      const senderConnection = await createAgentConnection(sender.id, {
        callbackUrl: "polling://identity-mismatch",
      });

      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "neutral message",
        undefined,
        {
          sender_user_id: otherUser.id,
          sender_connection_id: senderConnection.id,
        }
      );

      expect(result.effect).toBe("deny");
      expect(result.reason_code).toBe("auth.sender_identity.mismatch");
      expect(result.resolver_layer).toBe("platform_guardrails");
      expect(result.evaluated_policies).toHaveLength(0);
    });

    it("should apply platform guardrails before user policies", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("guardrail_sender_order");
      const { user: recipient } = await createTestUser("guardrail_recipient_order");

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: "heuristic",
        policyContent: JSON.stringify({ requireContext: true }),
        priority: 100,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "Bearer verySecretToken123456789"
      );

      expect(result.allowed).toBe(false);
      expect(result.effect).toBe("deny");
      expect(result.resolver_layer).toBe("platform_guardrails");
      expect(result.reason).toContain("platform guardrail");
      expect(result.reason_code).toMatch(/^guardrail\./);
      expect(result.evaluated_policies).toHaveLength(0);
      expect(result.reason).not.toContain("Context is required");
    });

    it("should not allow user allow policy to override a platform deny", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("guardrail_sender_allow");
      const { user: recipient } = await createTestUser("guardrail_recipient_allow");

      const allowStorage = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 1,
        enabled: true,
      });

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: allowStorage.policyType,
        policyContent: allowStorage.policyContent,
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "password: hunter2"
      );

      expect(result.allowed).toBe(false);
      expect(result.effect).toBe("deny");
      expect(result.resolver_layer).toBe("platform_guardrails");
      expect(result.reason).toContain("platform guardrail");
      expect(result.reason_code).toMatch(/^guardrail\./);
    });

    it("should never evaluate expired policies", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("expired_sender");
      const { user: recipient } = await createTestUser("expired_recipient");

      const expiredDeny = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: new Date(Date.now() - 3_600_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });
      const activeAllow = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 1,
        enabled: true,
      });

      const expiredPolicyId = nanoid();
      const activePolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: expiredPolicyId,
          userId: sender.id,
          scope: "global",
          policyType: expiredDeny.policyType,
          policyContent: expiredDeny.policyContent,
          direction: expiredDeny.direction,
          resource: expiredDeny.resource,
          action: expiredDeny.action,
          effect: expiredDeny.effect,
          evaluator: expiredDeny.evaluator,
          effectiveFrom: expiredDeny.effectiveFrom,
          expiresAt: expiredDeny.expiresAt,
          maxUses: expiredDeny.maxUses,
          remainingUses: expiredDeny.remainingUses,
          source: expiredDeny.source,
          derivedFromMessageId: expiredDeny.derivedFromMessageId,
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: activePolicyId,
          userId: sender.id,
          scope: "global",
          policyType: activeAllow.policyType,
          policyContent: activeAllow.policyContent,
          direction: activeAllow.direction,
          resource: activeAllow.resource,
          action: activeAllow.action,
          effect: activeAllow.effect,
          evaluator: activeAllow.evaluator,
          effectiveFrom: activeAllow.effectiveFrom,
          expiresAt: activeAllow.expiresAt,
          maxUses: activeAllow.maxUses,
          remainingUses: activeAllow.remainingUses,
          source: activeAllow.source,
          derivedFromMessageId: activeAllow.derivedFromMessageId,
          priority: 1,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(result.allowed).toBe(true);
      expect(result.effect).toBe("allow");
      expect(result.winning_policy_id).toBe(activePolicyId);
      expect(result.matched_policy_ids).not.toContain(expiredPolicyId);
    });

    it("should never evaluate spent one-time overrides", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("spent_sender");
      const { user: recipient } = await createTestUser("spent_recipient");

      const spentDeny = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: 1,
        remaining_uses: 0,
        source: "override",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });
      const activeAllow = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 1,
        enabled: true,
      });

      const spentPolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: spentPolicyId,
          userId: sender.id,
          scope: "global",
          policyType: spentDeny.policyType,
          policyContent: spentDeny.policyContent,
          direction: spentDeny.direction,
          resource: spentDeny.resource,
          action: spentDeny.action,
          effect: spentDeny.effect,
          evaluator: spentDeny.evaluator,
          effectiveFrom: spentDeny.effectiveFrom,
          expiresAt: spentDeny.expiresAt,
          maxUses: spentDeny.maxUses,
          remainingUses: spentDeny.remainingUses,
          source: spentDeny.source,
          derivedFromMessageId: spentDeny.derivedFromMessageId,
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: nanoid(),
          userId: sender.id,
          scope: "global",
          policyType: activeAllow.policyType,
          policyContent: activeAllow.policyContent,
          direction: activeAllow.direction,
          resource: activeAllow.resource,
          action: activeAllow.action,
          effect: activeAllow.effect,
          evaluator: activeAllow.evaluator,
          effectiveFrom: activeAllow.effectiveFrom,
          expiresAt: activeAllow.expiresAt,
          maxUses: activeAllow.maxUses,
          remainingUses: activeAllow.remainingUses,
          source: activeAllow.source,
          derivedFromMessageId: activeAllow.derivedFromMessageId,
          priority: 1,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(result.allowed).toBe(true);
      expect(result.effect).toBe("allow");
      expect(result.matched_policy_ids).not.toContain(spentPolicyId);
    });

    it("should enforce lifecycle boundaries around effective windows", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("lifecycle_sender");
      const { user: recipient } = await createTestUser("lifecycle_recipient");

      const now = Date.now();
      const notYetEffectiveDeny = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: new Date(now + 60_000).toISOString(),
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });
      const activeAsk = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: {},
        effective_from: new Date(now - 60_000).toISOString(),
        expires_at: new Date(now + 60_000).toISOString(),
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 50,
        enabled: true,
      });
      const justExpiredDeny = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: new Date(now - 120_000).toISOString(),
        expires_at: new Date(now - 60_000).toISOString(),
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });

      const activePolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: nanoid(),
          userId: sender.id,
          scope: "global",
          policyType: notYetEffectiveDeny.policyType,
          policyContent: notYetEffectiveDeny.policyContent,
          direction: notYetEffectiveDeny.direction,
          resource: notYetEffectiveDeny.resource,
          action: notYetEffectiveDeny.action,
          effect: notYetEffectiveDeny.effect,
          evaluator: notYetEffectiveDeny.evaluator,
          effectiveFrom: notYetEffectiveDeny.effectiveFrom,
          expiresAt: notYetEffectiveDeny.expiresAt,
          maxUses: notYetEffectiveDeny.maxUses,
          remainingUses: notYetEffectiveDeny.remainingUses,
          source: notYetEffectiveDeny.source,
          derivedFromMessageId: notYetEffectiveDeny.derivedFromMessageId,
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: activePolicyId,
          userId: sender.id,
          scope: "global",
          policyType: activeAsk.policyType,
          policyContent: activeAsk.policyContent,
          direction: activeAsk.direction,
          resource: activeAsk.resource,
          action: activeAsk.action,
          effect: activeAsk.effect,
          evaluator: activeAsk.evaluator,
          effectiveFrom: activeAsk.effectiveFrom,
          expiresAt: activeAsk.expiresAt,
          maxUses: activeAsk.maxUses,
          remainingUses: activeAsk.remainingUses,
          source: activeAsk.source,
          derivedFromMessageId: activeAsk.derivedFromMessageId,
          priority: 50,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: nanoid(),
          userId: sender.id,
          scope: "global",
          policyType: justExpiredDeny.policyType,
          policyContent: justExpiredDeny.policyContent,
          direction: justExpiredDeny.direction,
          resource: justExpiredDeny.resource,
          action: justExpiredDeny.action,
          effect: justExpiredDeny.effect,
          evaluator: justExpiredDeny.evaluator,
          effectiveFrom: justExpiredDeny.effectiveFrom,
          expiresAt: justExpiredDeny.expiresAt,
          maxUses: justExpiredDeny.maxUses,
          remainingUses: justExpiredDeny.remainingUses,
          source: justExpiredDeny.source,
          derivedFromMessageId: justExpiredDeny.derivedFromMessageId,
          priority: 100,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(result.allowed).toBe(false);
      expect(result.effect).toBe("ask");
      expect(result.winning_policy_id).toBe(activePolicyId);
      expect(result.matched_policy_ids).toEqual([activePolicyId]);
    });
  });

  describe("evaluatePolicies with role-scoped policies", () => {
    beforeAll(async () => {
      await setupTestDatabase();
      await seedTestSystemRoles();
    });

    afterAll(() => {
      cleanupTestDatabase();
    });

    it("should include role-scoped policy when recipient has the role", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender1");
      const { user: recipient } = await createTestUser("role_recipient1");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");

      // Assign close_friends role to recipient
      await addRoleToFriendship(friendship.id, "close_friends");

      // Create a role-scoped policy that blocks "confidential"
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["confidential"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Message with "confidential" should be rejected
      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "This is confidential information"
      );
      expect(result.allowed).toBe(false);
    });

    it("should NOT include role-scoped policy when recipient lacks the role", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender2");
      const { user: recipient } = await createTestUser("role_recipient2");
      await createFriendship(sender.id, recipient.id, "accepted");
      // Note: No role assigned to this friendship

      // Create a role-scoped policy for work_contacts
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "work_contacts",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["personal"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Message with "personal" should be ALLOWED because recipient doesn't have the role
      const result = await evaluatePolicies(
        sender.id,
        recipient.id,
        "This is personal information"
      );
      expect(result.allowed).toBe(true);
    });

    it("should evaluate multiple role-scoped policies when recipient has multiple roles", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender3");
      const { user: recipient } = await createTestUser("role_recipient3");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");

      // Assign multiple roles
      await addRoleToFriendship(friendship.id, "close_friends");
      await addRoleToFriendship(friendship.id, "work_contacts");

      // Create policy for close_friends
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "close_friends",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["pattern_a"] }),
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      // Create policy for work_contacts
      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "work_contacts",
        policyType: "heuristic",
        policyContent: JSON.stringify({ blockedPatterns: ["pattern_b"] }),
        priority: 40,
        enabled: true,
        createdAt: new Date(),
      });

      // Both patterns should be blocked
      const resultA = await evaluatePolicies(sender.id, recipient.id, "contains pattern_a");
      expect(resultA.allowed).toBe(false);

      const resultB = await evaluatePolicies(sender.id, recipient.id, "contains pattern_b");
      expect(resultB.allowed).toBe(false);

      // Allowed message
      const resultOk = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(resultOk.allowed).toBe(true);
    });

    it("should resolve specificity by user > role > global regardless of numeric priority", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender4");
      const { user: recipient } = await createTestUser("role_recipient4");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");
      await addRoleToFriendship(friendship.id, "friends");

      const globalStorage = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 100,
        enabled: true,
      });

      const roleStorage = canonicalToStorage({
        scope: "role",
        target_id: "friends",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 50,
        enabled: true,
      });

      const userStorage = canonicalToStorage({
        scope: "user",
        target_id: recipient.id,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 1,
        enabled: true,
      });

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "global",
        policyType: globalStorage.policyType,
        policyContent: globalStorage.policyContent,
        priority: 100,
        enabled: true,
        createdAt: new Date(),
      });

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "role",
        targetId: "friends",
        policyType: roleStorage.policyType,
        policyContent: roleStorage.policyContent,
        priority: 50,
        enabled: true,
        createdAt: new Date(),
      });

      await db.insert(schema.policies).values({
        id: nanoid(),
        userId: sender.id,
        scope: "user",
        targetId: recipient.id,
        policyType: userStorage.policyType,
        policyContent: userStorage.policyContent,
        priority: 1,
        enabled: true,
        createdAt: new Date(),
      });

      const result = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(result.allowed).toBe(true);
      expect(result.effect).toBe("allow");
      expect(result.winning_policy_id).toBeDefined();
      expect(result.resolution_explanation).toContain("Final effect: 'allow'");
    });

    it("should resolve same-scope conflicts deterministically via deny > ask > allow", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("role_sender5");
      const { user: recipient } = await createTestUser("role_recipient5");
      const friendship = await createFriendship(sender.id, recipient.id, "accepted");
      await addRoleToFriendship(friendship.id, "close_friends");
      await addRoleToFriendship(friendship.id, "friends");
      await addRoleToFriendship(friendship.id, "work_contacts");

      const allowRole = canonicalToStorage({
        scope: "role",
        target_id: "close_friends",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 10,
        enabled: true,
      });
      const askRole = canonicalToStorage({
        scope: "role",
        target_id: "friends",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "ask",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 10,
        enabled: true,
      });
      const denyRole = canonicalToStorage({
        scope: "role",
        target_id: "work_contacts",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 10,
        enabled: true,
      });

      const denyPolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: nanoid(),
          userId: sender.id,
          scope: "role",
          targetId: "close_friends",
          policyType: allowRole.policyType,
          policyContent: allowRole.policyContent,
          priority: 10,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: nanoid(),
          userId: sender.id,
          scope: "role",
          targetId: "friends",
          policyType: askRole.policyType,
          policyContent: askRole.policyContent,
          priority: 10,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: denyPolicyId,
          userId: sender.id,
          scope: "role",
          targetId: "work_contacts",
          policyType: denyRole.policyType,
          policyContent: denyRole.policyContent,
          priority: 10,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const first = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      const second = await evaluatePolicies(sender.id, recipient.id, "neutral message");

      expect(first.effect).toBe("deny");
      expect(second.effect).toBe("deny");
      expect(first.winning_policy_id).toBe(denyPolicyId);
      expect(second.winning_policy_id).toBe(denyPolicyId);
      expect(first.resolution_explanation).toContain("deny > ask > allow");
      expect(first.matched_policy_ids.length).toBe(3);
    });

    it("should apply group overlay constraints when group context is provided", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("group_overlay_sender");
      const { user: recipient } = await createTestUser("group_overlay_recipient");

      const userAllow = canonicalToStorage({
        scope: "user",
        target_id: recipient.id,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 50,
        enabled: true,
      });
      const groupDeny = canonicalToStorage({
        scope: "group",
        target_id: "grp_fanout_overlay",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 60,
        enabled: true,
      });

      const userPolicyId = nanoid();
      const groupPolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: userPolicyId,
          userId: sender.id,
          scope: "user",
          targetId: recipient.id,
          policyType: userAllow.policyType,
          policyContent: userAllow.policyContent,
          direction: userAllow.direction,
          resource: userAllow.resource,
          action: userAllow.action,
          effect: userAllow.effect,
          evaluator: userAllow.evaluator,
          effectiveFrom: userAllow.effectiveFrom,
          expiresAt: userAllow.expiresAt,
          maxUses: userAllow.maxUses,
          remainingUses: userAllow.remainingUses,
          source: userAllow.source,
          derivedFromMessageId: userAllow.derivedFromMessageId,
          priority: userAllow.priority,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: groupPolicyId,
          userId: sender.id,
          scope: "group",
          targetId: "grp_fanout_overlay",
          policyType: groupDeny.policyType,
          policyContent: groupDeny.policyContent,
          direction: groupDeny.direction,
          resource: groupDeny.resource,
          action: groupDeny.action,
          effect: groupDeny.effect,
          evaluator: groupDeny.evaluator,
          effectiveFrom: groupDeny.effectiveFrom,
          expiresAt: groupDeny.expiresAt,
          maxUses: groupDeny.maxUses,
          remainingUses: groupDeny.remainingUses,
          source: groupDeny.source,
          derivedFromMessageId: groupDeny.derivedFromMessageId,
          priority: groupDeny.priority,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const directResult = await evaluatePolicies(sender.id, recipient.id, "neutral message");
      expect(directResult.effect).toBe("allow");
      expect(directResult.winning_policy_id).toBe(userPolicyId);

      const groupResult = await evaluatePolicies(
        sender.id,
        recipient.id,
        "neutral message",
        undefined,
        undefined,
        {
          direction: "outbound",
          resource: "message.general",
          action: "share",
        },
        "grp_fanout_overlay"
      );
      expect(groupResult.effect).toBe("deny");
      expect(groupResult.winning_policy_id).toBe(groupPolicyId);
      expect(groupResult.resolution_explanation).toContain("additional constraint");
    });
  });

  describe("evaluateGroupPolicies", () => {
    beforeAll(async () => {
      await setupTestDatabase();
    });

    afterAll(() => {
      cleanupTestDatabase();
    });

    it("should apply group overlay as an additional constraint", async () => {
      const db = getTestDb();
      const { user: sender } = await createTestUser("group_sender1");

      const globalAllow = canonicalToStorage({
        scope: "global",
        target_id: null,
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "allow",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 5,
        enabled: true,
      });
      const groupDeny = canonicalToStorage({
        scope: "group",
        target_id: "grp_overlay",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        effect: "deny",
        evaluator: "structured",
        policy_content: {},
        effective_from: null,
        expires_at: null,
        max_uses: null,
        remaining_uses: null,
        source: "user_created",
        derived_from_message_id: null,
        priority: 5,
        enabled: true,
      });

      const groupPolicyId = nanoid();
      await db.insert(schema.policies).values([
        {
          id: nanoid(),
          userId: sender.id,
          scope: "global",
          policyType: globalAllow.policyType,
          policyContent: globalAllow.policyContent,
          priority: 5,
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: groupPolicyId,
          userId: sender.id,
          scope: "group",
          targetId: "grp_overlay",
          policyType: groupDeny.policyType,
          policyContent: groupDeny.policyContent,
          priority: 5,
          enabled: true,
          createdAt: new Date(),
        },
      ]);

      const result = await evaluateGroupPolicies(sender.id, "grp_overlay", "neutral message");
      expect(result.allowed).toBe(false);
      expect(result.effect).toBe("deny");
      expect(result.winning_policy_id).toBe(groupPolicyId);
      expect(result.resolution_explanation).toContain("additional constraint");
    });
  });
});

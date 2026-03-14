import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { nanoid } from "nanoid";
import { resolvePolicySet } from "@mahilo/policy-core";
import {
  evaluatePolicies,
  loadApplicablePolicies,
} from "../../src/services/policy";
import { canonicalToStorage } from "../../src/services/policySchema";
import * as schema from "../../src/db/schema";
import {
  addRoleToFriendship,
  cleanupTestDatabase,
  createFriendship,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";

const defaultSelectors = {
  action: "share",
  direction: "outbound" as const,
  resource: "message.general",
};

describe("shared deterministic resolver parity", () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("matches server behavior for no-match cases", async () => {
    const { user: sender } = await createTestUser("parity_no_match_sender");
    const { user: recipient } = await createTestUser(
      "parity_no_match_recipient",
    );
    await createFriendship(sender.id, recipient.id, "accepted");

    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "global",
      target_id: null,
      effect: "deny",
      priority: 80,
      policy_content: {
        maxLength: 100,
      },
    });

    const result = await expectServerCoreParity({
      senderId: sender.id,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      message: "short message",
      roles: [],
    });

    expect(result.effect).toBe("allow");
    expect(result.reason_code).toBe("policy.allow.no_match");
  });

  it("matches server behavior for same-scope conflict resolution", async () => {
    const { user: sender } = await createTestUser("parity_conflict_sender");
    const { user: recipient } = await createTestUser(
      "parity_conflict_recipient",
    );
    await createFriendship(sender.id, recipient.id, "accepted");

    const allowPolicyId = await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: recipient.id,
      effect: "allow",
      priority: 500,
      policy_content: {},
    });
    const denyPolicyId = await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: recipient.id,
      effect: "deny",
      priority: 1,
      policy_content: {},
    });

    const result = await expectServerCoreParity({
      senderId: sender.id,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      message: "neutral message",
      roles: [],
    });

    expect(result.effect).toBe("deny");
    expect(result.winning_policy_id).toBe(denyPolicyId);
    expect(result.matched_policy_ids).toEqual(
      expect.arrayContaining([allowPolicyId, denyPolicyId]),
    );
  });

  it("matches server behavior for scope specificity", async () => {
    const { user: sender } = await createTestUser("parity_specificity_sender");
    const { user: recipient } = await createTestUser(
      "parity_specificity_recipient",
    );
    const friendship = await createFriendship(
      sender.id,
      recipient.id,
      "accepted",
    );
    await addRoleToFriendship(friendship.id, "close_friends");

    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "global",
      target_id: null,
      effect: "deny",
      priority: 100,
      policy_content: {},
    });
    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "role",
      target_id: "close_friends",
      effect: "ask",
      priority: 1,
      policy_content: {},
    });

    const result = await expectServerCoreParity({
      senderId: sender.id,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      message: "neutral message",
      roles: ["close_friends"],
    });

    expect(result.effect).toBe("ask");
    expect(result.reason_code).toBe("policy.ask.role.structured");
  });

  it("matches server behavior for group overlay constraints", async () => {
    const { user: sender } = await createTestUser("parity_group_sender");
    const { user: recipient } = await createTestUser("parity_group_recipient");
    await createFriendship(sender.id, recipient.id, "accepted");

    await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "user",
      target_id: recipient.id,
      effect: "allow",
      priority: 40,
      policy_content: {},
    });
    const groupPolicyId = await insertCanonicalPolicy({
      user_id: sender.id,
      scope: "group",
      target_id: "grp_overlay_parity",
      effect: "deny",
      priority: 60,
      policy_content: {},
    });

    const result = await expectServerCoreParity({
      senderId: sender.id,
      recipientId: recipient.id,
      recipientUsername: recipient.username,
      message: "neutral message",
      roles: [],
      groupId: "grp_overlay_parity",
    });

    expect(result.effect).toBe("deny");
    expect(result.winning_policy_id).toBe(groupPolicyId);
    expect(result.resolution_explanation).toContain("additional constraint");
  });
});

async function expectServerCoreParity(input: {
  senderId: string;
  recipientId: string;
  recipientUsername: string;
  message: string;
  roles: string[];
  groupId?: string;
}) {
  const policies = await loadApplicablePolicies(
    input.senderId,
    input.recipientId,
    input.roles,
    input.groupId,
    defaultSelectors,
  );

  const sharedResult = await resolvePolicySet({
    policies,
    ownerUserId: input.senderId,
    message: input.message,
    recipientUsername: input.recipientUsername,
    llmSubject: input.recipientUsername,
    authenticatedIdentity: {
      sender_user_id: input.senderId,
      sender_connection_id: "unknown",
    },
    resolverLayer: "user_policies",
  });

  const serverResult = await evaluatePolicies(
    input.senderId,
    input.recipientId,
    input.message,
    undefined,
    undefined,
    defaultSelectors,
    input.groupId,
  );

  expect(sharedResult).toEqual(serverResult);
  return serverResult;
}

async function insertCanonicalPolicy(input: {
  user_id: string;
  scope: "global" | "user" | "role" | "group";
  target_id: string | null;
  effect: "allow" | "ask" | "deny";
  priority: number;
  policy_content: unknown;
}) {
  const db = getTestDb();
  const storage = canonicalToStorage({
    scope: input.scope,
    target_id: input.target_id,
    direction: defaultSelectors.direction,
    resource: defaultSelectors.resource,
    action: defaultSelectors.action,
    effect: input.effect,
    evaluator: "structured",
    policy_content: input.policy_content,
    effective_from: null,
    expires_at: null,
    max_uses: null,
    remaining_uses: null,
    source: "user_created",
    derived_from_message_id: null,
    priority: input.priority,
    enabled: true,
  });
  const policyId = nanoid();

  await db.insert(schema.policies).values({
    id: policyId,
    userId: input.user_id,
    scope: input.scope,
    targetId: input.target_id,
    policyType: storage.policyType,
    policyContent: storage.policyContent,
    direction: storage.direction,
    resource: storage.resource,
    action: storage.action,
    effect: storage.effect,
    evaluator: storage.evaluator,
    effectiveFrom: storage.effectiveFrom,
    expiresAt: storage.expiresAt,
    maxUses: storage.maxUses,
    remainingUses: storage.remainingUses,
    source: storage.source,
    derivedFromMessageId: storage.derivedFromMessageId,
    priority: input.priority,
    enabled: true,
    createdAt: new Date(),
  });

  return policyId;
}

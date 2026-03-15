import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  resolvePolicySet,
  type CorePolicy,
  type PolicyDirection,
  type PolicyEffect,
} from "@mahilo/policy-core";
import { createApp } from "../../src/server";
import { config } from "../../src/config";
import { canonicalToStorage } from "../../src/services/policySchema";
import * as schema from "../../src/db/schema";
import {
  cleanupTestDatabase,
  createAgentConnection,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import {
  evaluateGroupFanoutBundleLocally,
  type GroupFanoutPolicyBundle,
} from "../../plugins/openclaw-mahilo/src";

let app: ReturnType<typeof createApp>;
let originalTrustedMode: boolean;

interface GroupFanoutBundleMember {
  recipient: {
    id: string;
    type: "user";
    username: string;
  };
  roles: string[];
  resolution_id: string;
  member_applicable_policies: CorePolicy[];
  llm: {
    subject: string;
    provider_defaults: {
      provider: string;
      model: string;
    } | null;
  };
}

interface GroupFanoutBundleResponse {
  contract_version: string;
  bundle_type: "group_fanout";
  bundle_metadata: {
    bundle_id: string;
    resolution_id: string;
    issued_at: string;
    expires_at: string;
  };
  authenticated_identity: {
    sender_user_id: string;
    sender_connection_id: string;
  };
  selector_context: {
    action: string;
    direction: PolicyDirection;
    resource: string;
  };
  group: {
    id: string;
    member_count: number;
    name: string;
    type: "group";
  };
  aggregate_metadata: {
    fanout_mode: "per_recipient";
    mixed_decision_priority: PolicyEffect[];
    partial_reason_code: string;
    empty_group_summary: string;
    partial_summary_template: string;
    policy_evaluation_mode: "group_outbound_fanout";
  };
  group_overlay_policies: CorePolicy[];
  members: GroupFanoutBundleMember[];
}

interface LocalGroupAggregateResult {
  decision: PolicyEffect;
  partial_delivery: boolean;
  reason_code: string;
  summary: string;
  counts: {
    delivered: number;
    pending: number;
    denied: number;
    review_required: number;
    failed: number;
  };
}

function setTrustedMode(value: boolean) {
  (config as unknown as { trustedMode: boolean }).trustedMode = value;
}

beforeEach(async () => {
  await setupTestDatabase();
  originalTrustedMode = config.trustedMode;
  setTrustedMode(true);
  app = createApp();
});

afterEach(() => {
  setTrustedMode(originalTrustedMode);
  cleanupTestDatabase();
});

describe("Plugin group fanout policy bundle endpoint (LPE-011)", () => {
  it("requires authentication", async () => {
    const response = await app.request("/api/v1/plugin/bundles/group-fanout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: "grp_missing",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects users who are not active members of the requested group", async () => {
    const { user: sender, apiKey: senderKey } = await createTestUser(
      "group_bundle_not_member_sender",
    );
    const { user: owner } = await createTestUser("group_bundle_not_member_owner");
    const { user: peer } = await createTestUser("group_bundle_not_member_peer");

    await activateUsers([sender.id, owner.id, peer.id]);

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://group_bundle_not_member_sender",
      framework: "openclaw",
      label: "group-bundle-not-member",
    });
    const group = await createGroup(owner.id, [peer.id]);

    const response = await app.request("/api/v1/plugin/bundles/group-fanout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: group.id,
        sender_connection_id: senderConnection.id,
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("NOT_MEMBER");
  });

  it("returns a canonical group fanout bundle that reproduces mixed allow/ask/deny group results locally", async () => {
    const db = getTestDb();
    const { user: sender, apiKey: senderKey } = await createTestUser(
      "group_bundle_sender",
    );
    const { user: deniedRecipient } = await createTestUser(
      "group_bundle_denied",
    );
    const { user: askRecipient } = await createTestUser("group_bundle_ask");
    const { user: allowedRecipient } = await createTestUser(
      "group_bundle_allowed",
    );

    await activateUsers([
      sender.id,
      deniedRecipient.id,
      askRecipient.id,
      allowedRecipient.id,
    ]);

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://group_bundle_sender",
      framework: "openclaw",
      label: "group-bundle-sender",
    });
    await createAgentConnection(allowedRecipient.id, {
      callbackUrl: "polling://group_bundle_allowed",
      framework: "openclaw",
      label: "group-bundle-allowed",
    });

    const group = await createGroup(sender.id, [
      deniedRecipient.id,
      askRecipient.id,
      allowedRecipient.id,
    ]);

    const groupAllowPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "allow",
      evaluator: "structured",
      policy_content: {},
      priority: 10,
      resource: "message.general",
      scope: "group",
      target_id: group.id,
      user_id: sender.id,
    });
    const denyPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 100,
      resource: "message.general",
      scope: "user",
      target_id: deniedRecipient.id,
      user_id: sender.id,
    });
    const askPolicyId = await insertCanonicalPolicy({
      action: "share",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: { intent: "manual_review" },
      priority: 100,
      resource: "message.general",
      scope: "user",
      target_id: askRecipient.id,
      user_id: sender.id,
    });

    const bundleResponse = await app.request(
      "/api/v1/plugin/bundles/group-fanout",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: group.id,
          sender_connection_id: senderConnection.id,
          declared_selectors: {
            action: "SHARE",
            direction: "outbound",
            resource: "MESSAGE.GENERAL",
          },
        }),
      },
    );

    expect(bundleResponse.status).toBe(200);
    const bundle = (await bundleResponse.json()) as GroupFanoutPolicyBundle;

    expect(bundle.contract_version).toBe("1.0.0");
    expect(bundle.bundle_type).toBe("group_fanout");
    expect(bundle.bundle_metadata).toEqual(
      expect.objectContaining({
        bundle_id: expect.any(String),
        resolution_id: expect.any(String),
        issued_at: expect.any(String),
        expires_at: expect.any(String),
      }),
    );
    expect(bundle.authenticated_identity).toEqual({
      sender_user_id: sender.id,
      sender_connection_id: senderConnection.id,
    });
    expect(bundle.selector_context).toEqual({
      action: "share",
      direction: "outbound",
      resource: "message.general",
    });
    expect(bundle.group).toEqual({
      id: group.id,
      member_count: 3,
      name: group.name,
      type: "group",
    });
    expect(bundle.aggregate_metadata).toEqual({
      fanout_mode: "per_recipient",
      mixed_decision_priority: ["allow", "ask", "deny"],
      partial_reason_code: "policy.partial.group_fanout",
      empty_group_summary: "No active recipients in group.",
      partial_summary_template:
        "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.",
      policy_evaluation_mode: "group_outbound_fanout",
    });
    expect(
      bundle.group_overlay_policies.map((policy) => policy.id),
    ).toEqual([groupAllowPolicyId]);
    expect(bundle.group_overlay_policies.every((policy) => policy.scope === "group")).toBe(
      true,
    );
    expect(bundle.members).toHaveLength(3);
    expect(
      bundle.members.every((member) =>
        member.resolution_id.startsWith(`${bundle.bundle_metadata.resolution_id}_`),
      ),
    ).toBe(true);
    expect(
      bundle.members.every((member) =>
        member.member_applicable_policies.every((policy) => policy.scope !== "group"),
      ),
    ).toBe(true);
    expect(bundle.members.every((member) => Array.isArray(member.roles))).toBe(true);

    const storedMessagesBeforeSend = await db
      .select({ id: schema.messages.id })
      .from(schema.messages);
    expect(storedMessagesBeforeSend).toHaveLength(0);

    const localResult = await evaluateGroupFanoutBundleLocally(
      bundle,
      { message: "Mixed team update" },
      {
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      },
    );
    expect(localResult.aggregate).toEqual(
      expect.objectContaining({
        decision: "allow",
        partial_delivery: true,
        reason_code: "policy.partial.group_fanout",
        summary:
          "Partial group delivery: 1 delivered, 0 pending, 1 denied, 1 review-required, 0 failed.",
        counts: {
          delivered: 1,
          pending: 0,
          denied: 1,
          review_required: 1,
          failed: 0,
        },
      }),
    );

    const localDecisionByRecipient = new Map(
      localResult.recipient_results.map((entry) => [
        entry.recipient,
        entry.local_decision.decision,
      ]),
    );
    expect(localDecisionByRecipient.get(deniedRecipient.username)).toBe("deny");
    expect(localDecisionByRecipient.get(askRecipient.username)).toBe("ask");
    expect(localDecisionByRecipient.get(allowedRecipient.username)).toBe("allow");

    const sendResponse = await app.request("/api/v1/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: group.id,
        recipient_type: "group",
        sender_connection_id: senderConnection.id,
        message: "Mixed team update",
        declared_selectors: {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        },
      }),
    });

    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();

    expect(sendBody.delivered).toBe(localResult.aggregate.counts.delivered);
    expect(sendBody.pending).toBe(localResult.aggregate.counts.pending);
    expect(sendBody.denied).toBe(localResult.aggregate.counts.denied);
    expect(sendBody.review_required).toBe(
      localResult.aggregate.counts.review_required,
    );
    expect(sendBody.failed).toBe(localResult.aggregate.counts.failed);
    expect(sendBody.resolution.decision).toBe(localResult.aggregate.decision);
    expect(sendBody.resolution.reason_code).toBe(
      localResult.aggregate.reason_code,
    );

    const trustedDecisionByRecipient = new Map(
      sendBody.recipient_results.map(
        (entry: { recipient: string; decision: PolicyEffect }) => [
          entry.recipient,
          entry.decision,
        ],
      ),
    );
    expect(trustedDecisionByRecipient.get(deniedRecipient.username)).toBe(
      localDecisionByRecipient.get(deniedRecipient.username),
    );
    expect(trustedDecisionByRecipient.get(askRecipient.username)).toBe(
      localDecisionByRecipient.get(askRecipient.username),
    );
    expect(trustedDecisionByRecipient.get(allowedRecipient.username)).toBe(
      localDecisionByRecipient.get(allowedRecipient.username),
    );

    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, sendBody.message_id))
      .limit(1);
    expect(storedMessage?.outcomeDetails).toBe(localResult.aggregate.summary);

    const fanoutAudit = JSON.parse(storedMessage!.policiesEvaluated!);
    expect(fanoutAudit.decision_counts).toEqual({
      allow: 1,
      ask: 1,
      deny: 1,
    });
    expect(
      bundle.members
        .flatMap((member) => member.member_applicable_policies.map((policy) => policy.id))
        .sort(),
    ).toEqual(
      [askPolicyId, denyPolicyId].sort(),
    );
  });

  it("supports ask_network-style group asks and reproduces group overlay constraints without extra lookups", async () => {
    const { user: sender, apiKey: senderKey } = await createTestUser(
      "group_bundle_ask_sender",
    );
    const { user: deniedRecipient } = await createTestUser(
      "group_bundle_ask_denied",
    );
    const { user: neutralRecipient } = await createTestUser(
      "group_bundle_ask_neutral",
    );

    await activateUsers([sender.id, deniedRecipient.id, neutralRecipient.id]);

    const senderConnection = await createAgentConnection(sender.id, {
      callbackUrl: "polling://group_bundle_ask_sender",
      framework: "openclaw",
      label: "group-bundle-ask-sender",
    });

    const group = await createGroup(sender.id, [
      deniedRecipient.id,
      neutralRecipient.id,
    ]);

    const groupAskPolicyId = await insertCanonicalPolicy({
      action: "ask_around",
      direction: "outbound",
      effect: "ask",
      evaluator: "structured",
      policy_content: { intent: "group_review" },
      priority: 70,
      resource: "message.general",
      scope: "group",
      target_id: group.id,
      user_id: sender.id,
    });
    const denyPolicyId = await insertCanonicalPolicy({
      action: "ask_around",
      direction: "outbound",
      effect: "deny",
      evaluator: "structured",
      policy_content: {},
      priority: 100,
      resource: "message.general",
      scope: "user",
      target_id: deniedRecipient.id,
      user_id: sender.id,
    });

    const bundleResponse = await app.request(
      "/api/v1/plugin/bundles/group-fanout",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${senderKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipient: group.id,
          sender_connection_id: senderConnection.id,
          declared_selectors: {
            action: "ASK_AROUND",
            direction: "outbound",
            resource: "message.general",
          },
        }),
      },
    );

    expect(bundleResponse.status).toBe(200);
    const bundle = (await bundleResponse.json()) as GroupFanoutPolicyBundle;

    expect(bundle.selector_context).toEqual({
      action: "ask_around",
      direction: "outbound",
      resource: "message.general",
    });
    expect(
      bundle.group_overlay_policies.map((policy) => policy.id),
    ).toEqual([groupAskPolicyId]);
    expect(bundle.members).toHaveLength(2);

    const deniedMember = bundle.members.find(
      (member) => member.recipient.id === deniedRecipient.id,
    );
    const neutralMember = bundle.members.find(
      (member) => member.recipient.id === neutralRecipient.id,
    );
    expect(deniedMember).toBeDefined();
    expect(neutralMember).toBeDefined();

    const neutralWithoutOverlay = await resolvePolicySet({
      policies: neutralMember!.member_applicable_policies,
      ownerUserId: bundle.authenticated_identity.sender_user_id,
      message: "Who can answer this group question?",
      recipientUsername: neutralMember!.recipient.username,
      llmSubject: neutralMember!.llm.subject,
      authenticatedIdentity: bundle.authenticated_identity,
      llmErrorMode: "ask",
      llmUnavailableMode: "ask",
    });
    expect(neutralWithoutOverlay.effect).toBe("allow");

    const localResult = await evaluateGroupFanoutBundleLocally(
      bundle,
      { message: "Who can answer this group question?" },
      {
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      },
    );
    const localDecisionByRecipient = new Map(
      localResult.recipient_results.map((entry) => [
        entry.recipient,
        entry.local_decision.decision,
      ]),
    );
    expect(localDecisionByRecipient.get(neutralRecipient.username)).toBe("ask");
    expect(localDecisionByRecipient.get(deniedRecipient.username)).toBe("deny");
    expect(localResult.aggregate.reason_code).toBe(
      bundle.aggregate_metadata.partial_reason_code,
    );
    expect(
      deniedMember!.member_applicable_policies.map((policy) => policy.id),
    ).toEqual([denyPolicyId]);
  });
});

async function activateUsers(userIds: string[]) {
  const db = getTestDb();

  for (const userId of userIds) {
    await db
      .update(schema.users)
      .set({ status: "active", verifiedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }
}

async function createGroup(ownerUserId: string, memberUserIds: string[]) {
  const db = getTestDb();
  const group = {
    id: `grp_${nanoid(10)}`,
    name: `group-${nanoid(6)}`,
  };

  await db.insert(schema.groups).values({
    id: group.id,
    name: group.name,
    ownerUserId,
    inviteOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(schema.groupMemberships).values([
    {
      id: nanoid(),
      groupId: group.id,
      userId: ownerUserId,
      role: "owner",
      status: "active",
      invitedByUserId: ownerUserId,
      createdAt: new Date(),
    },
    ...memberUserIds.map((userId) => ({
      id: nanoid(),
      groupId: group.id,
      userId,
      role: "member",
      status: "active" as const,
      invitedByUserId: ownerUserId,
      createdAt: new Date(),
    })),
  ]);

  return group;
}

async function insertCanonicalPolicy(input: {
  action: string;
  direction: PolicyDirection;
  effect: PolicyEffect;
  evaluator: "structured" | "heuristic" | "llm";
  policy_content: unknown;
  priority: number;
  resource: string;
  scope: "global" | "user" | "role" | "group";
  target_id: string | null;
  user_id: string;
}) {
  const db = getTestDb();
  const stored = canonicalToStorage({
    action: input.action,
    derived_from_message_id: null,
    direction: input.direction,
    effective_from: null,
    effect: input.effect,
    enabled: true,
    evaluator: input.evaluator,
    expires_at: null,
    learning_provenance: null,
    max_uses: null,
    policy_content: input.policy_content,
    priority: input.priority,
    remaining_uses: null,
    resource: input.resource,
    scope: input.scope,
    source: "user_created",
    target_id: input.target_id,
    updated_at: null,
    user_id: input.user_id,
  });
  const policyId = `pol_${input.scope}_${input.effect}_${nanoid(8)}`;

  await db.insert(schema.policies).values({
    action: stored.action,
    derivedFromMessageId: stored.derivedFromMessageId,
    direction: stored.direction,
    effect: stored.effect,
    effectiveFrom: stored.effectiveFrom,
    enabled: true,
    evaluator: stored.evaluator,
    expiresAt: stored.expiresAt,
    id: policyId,
    maxUses: stored.maxUses,
    policyContent: stored.policyContent,
    policyType: stored.policyType,
    priority: input.priority,
    remainingUses: stored.remainingUses,
    resource: stored.resource,
    scope: input.scope,
    source: stored.source,
    targetId: input.target_id,
    userId: input.user_id,
  });

  return policyId;
}

async function evaluateLocalGroupBundle(
  bundle: GroupFanoutBundleResponse,
  message: string,
): Promise<{
  memberResults: Array<{ recipient: string; decision: PolicyEffect }>;
  aggregate: LocalGroupAggregateResult;
}> {
  const memberResults = await Promise.all(
    bundle.members.map(async (member) => {
      const result = await resolvePolicySet({
        policies: [
          ...member.member_applicable_policies,
          ...bundle.group_overlay_policies,
        ],
        ownerUserId: bundle.authenticated_identity.sender_user_id,
        message,
        recipientUsername: member.recipient.username,
        llmSubject: member.llm.subject,
        authenticatedIdentity: bundle.authenticated_identity,
        llmErrorMode: "ask",
        llmUnavailableMode: "ask",
      });

      return {
        recipient: member.recipient.username,
        decision: result.effect,
        reason_code: result.reason_code,
      };
    }),
  );

  const counts = {
    delivered: memberResults.filter((entry) => entry.decision === "allow").length,
    pending: 0,
    denied: memberResults.filter((entry) => entry.decision === "deny").length,
    review_required: memberResults.filter((entry) => entry.decision === "ask")
      .length,
    failed: 0,
  };
  const distinctDecisions = new Set(memberResults.map((entry) => entry.decision));
  const partialDelivery = memberResults.length > 0 && distinctDecisions.size > 1;
  const aggregateDecision =
    memberResults.length === 0
      ? "allow"
      : distinctDecisions.size === 1
        ? memberResults[0].decision
        : bundle.aggregate_metadata.mixed_decision_priority.find((candidate) =>
            distinctDecisions.has(candidate),
          ) || "allow";
  const aggregateReasonCode = partialDelivery
    ? bundle.aggregate_metadata.partial_reason_code
    : memberResults.find((entry) => entry.decision === aggregateDecision)
        ?.reason_code || defaultReasonCode(aggregateDecision);
  const summary =
    memberResults.length === 0
      ? bundle.aggregate_metadata.empty_group_summary
      : partialDelivery
        ? formatAggregateSummary(
            bundle.aggregate_metadata.partial_summary_template,
            counts,
          )
        : defaultAggregateSummary(aggregateDecision);

  return {
    memberResults: memberResults.map(({ reason_code: _reasonCode, ...entry }) => entry),
    aggregate: {
      decision: aggregateDecision,
      partial_delivery: partialDelivery,
      reason_code: aggregateReasonCode,
      summary,
      counts,
    },
  };
}

function formatAggregateSummary(
  template: string,
  counts: LocalGroupAggregateResult["counts"],
): string {
  return template
    .replace("{delivered}", String(counts.delivered))
    .replace("{pending}", String(counts.pending))
    .replace("{denied}", String(counts.denied))
    .replace("{review_required}", String(counts.review_required))
    .replace("{failed}", String(counts.failed));
}

function defaultAggregateSummary(decision: PolicyEffect): string {
  if (decision === "ask") {
    return "Message requires review before delivery.";
  }
  if (decision === "deny") {
    return "Message blocked by policy.";
  }
  return "Message allowed by policy.";
}

function defaultReasonCode(decision: PolicyEffect): string {
  if (decision === "ask") {
    return "policy.ask.resolved";
  }
  if (decision === "deny") {
    return "policy.deny.resolved";
  }
  return "policy.allow.resolved";
}

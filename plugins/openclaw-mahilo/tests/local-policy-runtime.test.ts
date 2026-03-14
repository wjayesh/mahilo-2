import { describe, expect, it } from "bun:test";

import {
  createMahiloLocalPolicyRuntime,
  type DirectSendPolicyBundle,
  type GroupFanoutPolicyBundle,
} from "../src";
import type { CorePolicy } from "@mahilo/policy-core";

function createPolicy(
  overrides: Partial<CorePolicy> & Pick<CorePolicy, "id">,
): CorePolicy {
  return {
    id: overrides.id,
    scope: overrides.scope ?? "global",
    effect: overrides.effect ?? "deny",
    evaluator: overrides.evaluator ?? "structured",
    policy_content: overrides.policy_content ?? {},
    effective_from: overrides.effective_from ?? null,
    expires_at: overrides.expires_at ?? null,
    max_uses: overrides.max_uses ?? null,
    remaining_uses: overrides.remaining_uses ?? null,
    source: overrides.source ?? "user_created",
    derived_from_message_id: overrides.derived_from_message_id ?? null,
    learning_provenance: overrides.learning_provenance ?? null,
    priority: overrides.priority ?? 1,
    created_at: overrides.created_at ?? null,
  };
}

describe("MahiloLocalPolicyRuntime", () => {
  it("fetches a direct-send bundle, evaluates locally, and returns commit-ready metadata", async () => {
    const directBundle: DirectSendPolicyBundle = {
      contract_version: "1.0.0",
      bundle_type: "direct_send",
      bundle_metadata: {
        bundle_id: "bundle_direct_1",
        resolution_id: "res_direct_1",
        issued_at: "2026-03-14T10:30:00.000Z",
        expires_at: "2026-03-14T10:35:00.000Z",
      },
      authenticated_identity: {
        sender_user_id: "usr_sender",
        sender_connection_id: "conn_sender",
      },
      selector_context: {
        action: "share",
        direction: "outbound",
        resource: "location.current",
      },
      recipient: {
        id: "usr_alice",
        type: "user",
        username: "alice",
      },
      applicable_policies: [
        createPolicy({
          id: "pol_role_ask",
          scope: "role",
          effect: "ask",
          evaluator: "structured",
          priority: 80,
          policy_content: { intent: "manual_review" },
        }),
        createPolicy({
          id: "pol_user_llm",
          scope: "user",
          effect: "deny",
          evaluator: "llm",
          priority: 100,
          policy_content: "Never share exact location without consent.",
        }),
      ],
      llm: {
        subject: "alice",
        provider_defaults: {
          provider: "openai",
          model: "gpt-4o-mini",
        },
      },
    };
    const directBundleCalls: Record<string, unknown>[] = [];

    const runtime = createMahiloLocalPolicyRuntime({
      client: {
        getDirectSendPolicyBundle: async (payload) => {
          directBundleCalls.push(payload);
          return directBundle;
        },
        getGroupFanoutPolicyBundle: async () => {
          throw new Error("unexpected group bundle request");
        },
      },
      llmProviderAdapter: async ({ input, prompt }) => {
        expect(prompt).toContain("Never share exact location without consent.");
        expect(input.message).toContain("home");
        expect(input.subject).toBe("alice");
        return {
          model: "gpt-4o-mini",
          provider: "openai",
          text: "FAIL\nNeed consent for exact location.",
        };
      },
      llmUnavailableMode: "ask",
      llmErrorMode: "ask",
    });

    const result = await runtime.evaluateDirectSend({
      message: "Alice is at home right now.",
      recipient: " Alice ",
      senderConnectionId: "conn_sender",
      declaredSelectors: {
        action: " SHARE ",
        resource: "Location Current",
      },
      context: "User asked for an exact location update.",
      correlationId: "corr_direct_1",
      idempotencyKey: "idem_direct_1",
    });

    expect(directBundleCalls).toEqual([
      {
        declared_selectors: {
          action: "share",
          direction: "outbound",
          resource: "location.current",
        },
        recipient: " Alice ",
        recipient_type: "user",
        sender_connection_id: "conn_sender",
      },
    ]);
    expect(result.local_decision).toMatchObject({
      decision: "deny",
      delivery_mode: "blocked",
      reason_code: "policy.deny.user.llm",
      summary: "Need consent for exact location.",
      winning_policy_id: "pol_user_llm",
    });
    expect(result.recipient_results).toHaveLength(1);
    expect(result.recipient_results[0]).toMatchObject({
      recipient: "alice",
      recipient_id: "usr_alice",
      recipient_type: "user",
      resolution_id: "res_direct_1",
      should_send: false,
      transport_action: "block",
    });
    expect(result.commit_payload).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      resolution_id: "res_direct_1",
      sender_connection_id: "conn_sender",
      message: "Alice is at home right now.",
      context: "User asked for an exact location update.",
      correlation_id: "corr_direct_1",
      idempotency_key: "idem_direct_1",
    });
    expect(result.commit_payload.local_decision.matched_policy_ids).toEqual([
      "pol_role_ask",
      "pol_user_llm",
    ]);
    expect(result.commit_payload.local_decision.evaluated_policies).toHaveLength(
      2,
    );
    expect(result.transport_payload).toMatchObject({
      recipient: "alice",
      recipient_type: "user",
      resolution_id: "res_direct_1",
      sender_connection_id: "conn_sender",
      payload_type: "text/plain",
    });
  });

  it("fetches a group-fanout bundle and returns member-level results plus aggregate fanout metadata", async () => {
    const groupBundle: GroupFanoutPolicyBundle = {
      contract_version: "1.0.0",
      bundle_type: "group_fanout",
      bundle_metadata: {
        bundle_id: "bundle_group_1",
        resolution_id: "res_group_1",
        issued_at: "2026-03-14T10:30:00.000Z",
        expires_at: "2026-03-14T10:35:00.000Z",
      },
      authenticated_identity: {
        sender_user_id: "usr_sender",
        sender_connection_id: "conn_sender",
      },
      selector_context: {
        action: "share",
        direction: "outbound",
        resource: "message.general",
      },
      group: {
        id: "grp_hiking",
        member_count: 3,
        name: "Weekend Hikers",
        type: "group",
      },
      aggregate_metadata: {
        fanout_mode: "per_recipient",
        mixed_decision_priority: ["allow", "ask", "deny"],
        partial_reason_code: "policy.partial.group_fanout",
        empty_group_summary: "No active recipients in group.",
        partial_summary_template:
          "Partial group delivery: {delivered} delivered, {pending} pending, {denied} denied, {review_required} review-required, {failed} failed.",
        policy_evaluation_mode: "group_outbound_fanout",
      },
      group_overlay_policies: [
        createPolicy({
          id: "pol_group_allow",
          scope: "group",
          effect: "allow",
          evaluator: "structured",
          priority: 10,
          policy_content: {},
        }),
      ],
      members: [
        {
          recipient: {
            id: "usr_deny",
            type: "user",
            username: "denied_friend",
          },
          roles: ["close_friends"],
          resolution_id: "res_group_1_usr_deny",
          member_applicable_policies: [
            createPolicy({
              id: "pol_user_deny",
              scope: "user",
              effect: "deny",
              evaluator: "structured",
              priority: 100,
              policy_content: {},
            }),
          ],
          llm: {
            subject: "denied_friend",
            provider_defaults: null,
          },
        },
        {
          recipient: {
            id: "usr_ask",
            type: "user",
            username: "careful_friend",
          },
          roles: ["travel_buddies"],
          resolution_id: "res_group_1_usr_ask",
          member_applicable_policies: [
            createPolicy({
              id: "pol_user_ask",
              scope: "user",
              effect: "ask",
              evaluator: "structured",
              priority: 100,
              policy_content: { intent: "manual_review" },
            }),
          ],
          llm: {
            subject: "careful_friend",
            provider_defaults: null,
          },
        },
        {
          recipient: {
            id: "usr_allow",
            type: "user",
            username: "open_friend",
          },
          roles: [],
          resolution_id: "res_group_1_usr_allow",
          member_applicable_policies: [],
          llm: {
            subject: "open_friend",
            provider_defaults: null,
          },
        },
      ],
    };
    const groupBundleCalls: Record<string, unknown>[] = [];

    const runtime = createMahiloLocalPolicyRuntime({
      client: {
        getDirectSendPolicyBundle: async () => {
          throw new Error("unexpected direct bundle request");
        },
        getGroupFanoutPolicyBundle: async (payload) => {
          groupBundleCalls.push(payload);
          return groupBundle;
        },
      },
      llmUnavailableMode: "ask",
      llmErrorMode: "ask",
    });

    const result = await runtime.evaluate({
      message: "Weekend plan update",
      recipient: "grp_hiking",
      recipientType: "group",
      senderConnectionId: "conn_sender",
      declaredSelectors: {
        action: " SHARE ",
        direction: "OUTBOUND",
        resource: "Message General",
      },
      correlationId: "corr_group_1",
      payloadType: "text/plain",
    });

    expect(groupBundleCalls).toEqual([
      {
        declared_selectors: {
          action: "share",
          direction: "outbound",
          resource: "message.general",
        },
        recipient: "grp_hiking",
        recipient_type: "group",
        sender_connection_id: "conn_sender",
      },
    ]);
    expect(result.bundle_type).toBe("group_fanout");
    expect(result.aggregate).toEqual({
      decision: "allow",
      partial_delivery: true,
      reason_code: "policy.partial.group_fanout",
      summary:
        "Partial group delivery: 1 delivered, 0 pending, 1 denied, 1 review-required, 0 failed.",
      has_sendable_recipients: true,
      counts: {
        delivered: 1,
        pending: 0,
        denied: 1,
        review_required: 1,
        failed: 0,
      },
    });
    expect(
      result.recipient_results.map((entry) => ({
        decision: entry.local_decision.decision,
        recipient: entry.recipient,
        should_send: entry.should_send,
        transport_action: entry.transport_action,
      })),
    ).toEqual([
      {
        decision: "deny",
        recipient: "denied_friend",
        should_send: false,
        transport_action: "block",
      },
      {
        decision: "ask",
        recipient: "careful_friend",
        should_send: false,
        transport_action: "hold",
      },
      {
        decision: "allow",
        recipient: "open_friend",
        should_send: true,
        transport_action: "send",
      },
    ]);
    expect(result.transport_payload).toMatchObject({
      recipient: "grp_hiking",
      recipient_type: "group",
      resolution_id: "res_group_1",
      sender_connection_id: "conn_sender",
      correlation_id: "corr_group_1",
      payload_type: "text/plain",
    });
  });
});

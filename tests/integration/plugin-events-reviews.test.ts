import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server";
import {
  cleanupTestDatabase,
  createTestUser,
  getTestDb,
  setupTestDatabase,
} from "../helpers/setup";
import * as schema from "../../src/db/schema";

let app: ReturnType<typeof createApp>;

describe("Plugin blocked/review event APIs (SRV-044)", () => {
  beforeEach(async () => {
    await setupTestDatabase();
    app = createApp();
  });

  afterEach(() => {
    cleanupTestDatabase();
  });

  it("requires authentication and verified users", async () => {
    const { apiKey: unverifiedKey } = await createTestUser("plugin_events_unverified");

    const unauthenticated = await app.request("/api/v1/plugin/events/blocked", {
      method: "GET",
    });
    expect(unauthenticated.status).toBe(401);

    const unverified = await app.request("/api/v1/plugin/reviews", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${unverifiedKey}`,
      },
    });
    expect(unverified.status).toBe(403);
  });

  it("queries the review queue with status and direction filters", async () => {
    const db = getTestDb();
    const { viewer, viewerKey, peer } = await setupParticipants("plugin_reviews_query");

    await db.insert(schema.messages).values([
      {
        id: "msg_review_outbound",
        senderUserId: viewer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: peer.id,
        payload: "Outbound review-required draft with context to review.",
        payloadType: "text/plain",
        status: "review_required",
        direction: "outbound",
        resource: "location.current",
        action: "share",
        policiesEvaluated: JSON.stringify({
          effect: "ask",
          reason_code: "policy.ask.user.structured",
          winning_policy_id: "pol_review_outbound",
          matched_policy_ids: ["pol_review_outbound"],
          reason: "Needs user confirmation before sharing location.",
        }),
        createdAt: new Date("2026-03-08T10:00:00.000Z"),
      },
      {
        id: "msg_review_approval",
        senderUserId: viewer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: peer.id,
        payload: "Outbound draft currently held for explicit approval.",
        payloadType: "text/plain",
        status: "approval_pending",
        direction: "outbound",
        resource: "calendar.event",
        action: "share",
        policiesEvaluated: JSON.stringify({
          effect: "ask",
          reason_code: "policy.ask.global.llm",
          matched_policy_ids: ["pol_review_approval"],
        }),
        createdAt: new Date("2026-03-08T11:00:00.000Z"),
      },
      {
        id: "msg_review_inbound",
        senderUserId: peer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: viewer.id,
        payload: "Inbound request that should surface in the review queue.",
        payloadType: "text/plain",
        status: "review_required",
        direction: "inbound",
        resource: "health.summary",
        action: "request",
        policiesEvaluated: JSON.stringify({
          effect: "ask",
          reason_code: "policy.ask.inbound.request",
          matched_policy_ids: ["pol_review_inbound"],
          resolution_explanation: "Inbound sensitive request requires review.",
        }),
        createdAt: new Date("2026-03-08T12:00:00.000Z"),
      },
      {
        id: "msg_review_delivered",
        senderUserId: viewer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: peer.id,
        payload: "Delivered message that should not appear in review queue.",
        payloadType: "text/plain",
        status: "delivered",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        createdAt: new Date("2026-03-08T13:00:00.000Z"),
      },
    ]);

    const response = await app.request("/api/v1/plugin/reviews?limit=10", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${viewerKey}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contract_version).toBe("1.0.0");
    expect(body.review_queue).toEqual(
      expect.objectContaining({
        count: 3,
      })
    );
    expect(body.reviews).toHaveLength(3);
    expect(body.reviews[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_review_inbound",
        queue_direction: "inbound",
        status: "review_required",
      })
    );
    expect(body.reviews[1]).toEqual(
      expect.objectContaining({
        message_id: "msg_review_approval",
        queue_direction: "outbound",
        status: "approval_pending",
        delivery_mode: "hold_for_approval",
      })
    );
    expect(body.reviews[2]).toEqual(
      expect.objectContaining({
        message_id: "msg_review_outbound",
        queue_direction: "outbound",
        status: "review_required",
      })
    );

    for (const review of body.reviews) {
      expect(typeof review.review_id).toBe("string");
      expect(review.review_id.startsWith("rev_")).toBe(true);
      expect(review.message_preview.length).toBeLessThanOrEqual(240);
    }

    const filtered = await app.request(
      "/api/v1/plugin/reviews?status=approval_pending&direction=outbound",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${viewerKey}`,
        },
      }
    );

    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json();
    expect(filteredBody.reviews).toHaveLength(1);
    expect(filteredBody.reviews[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_review_approval",
        queue_direction: "outbound",
        status: "approval_pending",
      })
    );
  });

  it("returns minimal blocked-event logs with optional excerpt", async () => {
    const db = getTestDb();
    const { viewer, viewerKey, peer } = await setupParticipants("plugin_blocked_events");

    const outboundPayload =
      "Bearer secret-token-value plus other sensitive tokens that should stay out of the default blocked event response body and only appear as a hash.";

    await db.insert(schema.messages).values([
      {
        id: "msg_blocked_outbound",
        senderUserId: viewer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: peer.id,
        payload: outboundPayload,
        payloadType: "text/plain",
        status: "rejected",
        direction: "outbound",
        resource: "location.current",
        action: "share",
        rejectionReason: "Location share denied",
        policiesEvaluated: JSON.stringify({
          effect: "deny",
          reason_code: "policy.deny.user.structured",
          matched_policy_ids: ["pol_block_outbound"],
        }),
        createdAt: new Date("2026-03-08T14:00:00.000Z"),
      },
      {
        id: "msg_blocked_inbound",
        senderUserId: peer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: viewer.id,
        payload: "Inbound sensitive request blocked by recipient policy.",
        payloadType: "text/plain",
        status: "rejected",
        direction: "inbound",
        resource: "health.summary",
        action: "request",
        rejectionReason: "Inbound request denied",
        policiesEvaluated: JSON.stringify({
          effect: "deny",
          reason_code: "policy.deny.inbound.request",
          matched_policy_ids: ["pol_block_inbound"],
        }),
        createdAt: new Date("2026-03-08T15:00:00.000Z"),
      },
      {
        id: "msg_not_blocked",
        senderUserId: viewer.id,
        senderAgent: "openclaw",
        recipientType: "user",
        recipientId: peer.id,
        payload: "Not blocked",
        payloadType: "text/plain",
        status: "review_required",
        direction: "outbound",
        resource: "message.general",
        action: "share",
        createdAt: new Date("2026-03-08T16:00:00.000Z"),
      },
    ]);

    const response = await app.request("/api/v1/plugin/events/blocked?limit=10", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${viewerKey}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contract_version).toBe("1.0.0");
    expect(body.retention).toEqual(
      expect.objectContaining({
        blocked_event_log: "metadata_only",
        payload_excerpt_default: "omitted",
        payload_excerpt_included: false,
      })
    );
    expect(body.blocked_events).toHaveLength(2);

    const outboundEvent = body.blocked_events.find(
      (event: { message_id: string }) => event.message_id === "msg_blocked_outbound"
    );
    expect(outboundEvent).toBeTruthy();
    expect(outboundEvent).toEqual(
      expect.objectContaining({
        reason_code: "policy.deny.user.structured",
        stored_payload_excerpt: null,
        queue_direction: "outbound",
      })
    );
    expect(outboundEvent.payload_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const inboundEvent = body.blocked_events.find(
      (event: { message_id: string }) => event.message_id === "msg_blocked_inbound"
    );
    expect(inboundEvent).toBeTruthy();
    expect(inboundEvent).toEqual(
      expect.objectContaining({
        reason_code: "policy.deny.inbound.request",
        queue_direction: "inbound",
      })
    );

    const withExcerpt = await app.request(
      "/api/v1/plugin/events/blocked?direction=outbound&include_payload_excerpt=true",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${viewerKey}`,
        },
      }
    );

    expect(withExcerpt.status).toBe(200);
    const withExcerptBody = await withExcerpt.json();
    expect(withExcerptBody.blocked_events).toHaveLength(1);
    expect(withExcerptBody.blocked_events[0]).toEqual(
      expect.objectContaining({
        message_id: "msg_blocked_outbound",
        queue_direction: "outbound",
      })
    );
    expect(typeof withExcerptBody.blocked_events[0].stored_payload_excerpt).toBe("string");
    expect(withExcerptBody.blocked_events[0].stored_payload_excerpt.length).toBeLessThanOrEqual(120);
  });
});

async function setupParticipants(suffix: string) {
  const db = getTestDb();
  const { user: viewer, apiKey: viewerKey } = await createTestUser(`viewer_${suffix}`);
  const { user: peer } = await createTestUser(`peer_${suffix}`);

  await db
    .update(schema.users)
    .set({
      twitterVerified: true,
      verificationCode: null,
    })
    .where(eq(schema.users.id, viewer.id));

  return {
    viewer,
    viewerKey,
    peer,
  };
}

import { selectorDirectionsEquivalent } from "@mahilo/policy-core";

export type SelectorDirection =
  | "outbound"
  | "inbound"
  | "request"
  | "response"
  | "notification"
  | "error";

export interface SelectorTuple {
  direction: SelectorDirection;
  resource: string;
  action: string;
}

type SelectorField = "direction" | "resource" | "action";
type SelectorConfidence = "high" | "low";

interface ClassifiedSelectorField<T extends string> {
  value: T;
  confidence: SelectorConfidence;
  signal: string;
}

interface SelectorClassification {
  direction: ClassifiedSelectorField<SelectorDirection>;
  resource: ClassifiedSelectorField<string>;
  action: ClassifiedSelectorField<string>;
}

export interface SelectorVerificationResult {
  classifier_version: string;
  classification_status: "classified" | "skipped_encrypted";
  declared_selectors: SelectorTuple;
  classified_selectors: SelectorTuple | null;
  classification_signals:
    | {
        direction: string;
        resource: string;
        action: string;
      }
    | null;
  mismatch: boolean;
  mismatch_fields: SelectorField[];
}

interface VerifySelectorOptions {
  declaredSelectors: SelectorTuple;
  message: string;
  context?: string | null;
  payloadType?: string;
}

const ENCRYPTED_PAYLOAD_TYPE = "application/mahilo+ciphertext";
const CLASSIFIER_VERSION = "mahilo.heuristic.v1";

function normalizeClassificationText(message: string, context?: string | null): string {
  return `${message} ${context || ""}`.toLowerCase();
}

function classifyResource(text: string): ClassifiedSelectorField<string> {
  if (/\b(history|historical|past locations?|visited|travel history)\b/.test(text)) {
    return {
      value: "location.history",
      confidence: "high",
      signal: "keyword.location.history",
    };
  }
  if (/\b(location|where|address|gps|nearby|coordinates?|latitude|longitude)\b/.test(text)) {
    return {
      value: "location.current",
      confidence: "high",
      signal: "keyword.location.current",
    };
  }
  if (/\b(availability|available|free|busy|open slot)\b/.test(text)) {
    return {
      value: "calendar.availability",
      confidence: "high",
      signal: "keyword.calendar.availability",
    };
  }
  if (/\b(calendar|meeting|event|appointment|schedule)\b/.test(text)) {
    return {
      value: "calendar.event",
      confidence: "high",
      signal: "keyword.calendar.event",
    };
  }
  if (/\b(email|mail|inbox)\b/.test(text)) {
    return {
      value: "contact.email",
      confidence: "high",
      signal: "keyword.contact.email",
    };
  }
  if (/\b(phone|call|text|sms|number)\b/.test(text)) {
    return {
      value: "contact.phone",
      confidence: "high",
      signal: "keyword.contact.phone",
    };
  }
  if (/\b(balance|account balance)\b/.test(text)) {
    return {
      value: "financial.balance",
      confidence: "high",
      signal: "keyword.financial.balance",
    };
  }
  if (/\b(transaction|payment|invoice|charge|spent)\b/.test(text)) {
    return {
      value: "financial.transaction",
      confidence: "high",
      signal: "keyword.financial.transaction",
    };
  }
  if (/\b(health summary|medical summary|wellness summary)\b/.test(text)) {
    return {
      value: "health.summary",
      confidence: "high",
      signal: "keyword.health.summary",
    };
  }
  if (/\b(steps|heart rate|blood pressure|sleep|bmi|health)\b/.test(text)) {
    return {
      value: "health.metric",
      confidence: "high",
      signal: "keyword.health.metric",
    };
  }
  return {
    value: "message.general",
    confidence: "low",
    signal: "fallback.message.general",
  };
}

function classifyAction(text: string): ClassifiedSelectorField<string> {
  if (
    text.includes("?") ||
    /\b(can you|could you|would you|please|what|when|where|who|how|tell me|show me|request)\b/.test(
      text
    )
  ) {
    return {
      value: "request",
      confidence: "high",
      signal: "keyword.action.request",
    };
  }

  if (/\b(share|send|forward|publish|notify|update)\b/.test(text)) {
    return {
      value: "share",
      confidence: "high",
      signal: "keyword.action.share",
    };
  }

  return {
    value: "share",
    confidence: "low",
    signal: "fallback.action.share",
  };
}

function classifyDirection(
  text: string,
  action: ClassifiedSelectorField<string>,
  declaredDirection: SelectorDirection
): ClassifiedSelectorField<SelectorDirection> {
  if (/\b(reply|respond|response)\b/.test(text)) {
    return {
      value: "response",
      confidence: "high",
      signal: "keyword.direction.response",
    };
  }

  if (action.value === "request" && action.confidence === "high") {
    return {
      value: "request",
      confidence: "high",
      signal: "derived.direction.request",
    };
  }

  return {
    value: declaredDirection,
    confidence: "low",
    signal: "fallback.direction.declared",
  };
}

function collectMismatchFields(
  declaredSelectors: SelectorTuple,
  classification: SelectorClassification
): SelectorField[] {
  const mismatches: SelectorField[] = [];
  const directionMismatch =
    !selectorDirectionsEquivalent(
      classification.direction.value,
      declaredSelectors.direction
    );

  if (classification.direction.confidence === "high" && directionMismatch) {
    mismatches.push("direction");
  }

  if (
    classification.resource.confidence === "high" &&
    classification.resource.value !== declaredSelectors.resource
  ) {
    mismatches.push("resource");
  }

  if (
    classification.action.confidence === "high" &&
    classification.action.value !== declaredSelectors.action
  ) {
    mismatches.push("action");
  }

  return mismatches;
}

export function verifySelectorsAgainstClassification(
  options: VerifySelectorOptions
): SelectorVerificationResult {
  if (options.payloadType === ENCRYPTED_PAYLOAD_TYPE) {
    return {
      classifier_version: CLASSIFIER_VERSION,
      classification_status: "skipped_encrypted",
      declared_selectors: options.declaredSelectors,
      classified_selectors: null,
      classification_signals: null,
      mismatch: false,
      mismatch_fields: [],
    };
  }

  const text = normalizeClassificationText(options.message, options.context);
  const action = classifyAction(text);
  const direction = classifyDirection(text, action, options.declaredSelectors.direction);
  const resource = classifyResource(text);
  const classification: SelectorClassification = {
    direction,
    resource,
    action,
  };

  const mismatchFields = collectMismatchFields(options.declaredSelectors, classification);
  const classifiedSelectors: SelectorTuple = {
    direction: classification.direction.value,
    resource: classification.resource.value,
    action: classification.action.value,
  };

  return {
    classifier_version: CLASSIFIER_VERSION,
    classification_status: "classified",
    declared_selectors: options.declaredSelectors,
    classified_selectors: classifiedSelectors,
    classification_signals: {
      direction: classification.direction.signal,
      resource: classification.resource.signal,
      action: classification.action.signal,
    },
    mismatch: mismatchFields.length > 0,
    mismatch_fields: mismatchFields,
  };
}

export function buildSelectorVerificationAudit(
  result: SelectorVerificationResult
): Record<string, unknown> {
  return {
    classifier_version: result.classifier_version,
    classification_status: result.classification_status,
    declared_selectors: result.declared_selectors,
    classified_selectors: result.classified_selectors,
    classification_signals: result.classification_signals,
    mismatch: result.mismatch,
    mismatch_fields: result.mismatch_fields,
  };
}

export function logSelectorVerificationMismatch(
  result: SelectorVerificationResult,
  metadata?: Record<string, unknown>
) {
  if (!result.mismatch) {
    return;
  }

  console.warn("[selector-verification] mismatch detected", {
    classifier_version: result.classifier_version,
    mismatch_fields: result.mismatch_fields,
    declared_selectors: result.declared_selectors,
    classified_selectors: result.classified_selectors,
    ...(metadata || {}),
  });
}

export interface PlatformGuardrailEvaluation {
  blocked: boolean;
  reason?: string;
  guardrail_id?: string;
}

export interface PlatformGuardrailRule {
  id: string;
  description: string;
  reason: string;
  blocked_patterns: RegExp[];
}

export const PLATFORM_GUARDRAILS: PlatformGuardrailRule[] = [
  {
    id: "credentials.inline_secret_assignment",
    description: "Blocks direct sharing of credential-like values",
    reason: "Message appears to contain inline credential or secret material",
    blocked_patterns: [
      /\b(?:api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key|password|passphrase)\s*[:=]\s*\S{6,}/i,
      /\bmhl_[a-zA-Z0-9]{8}_[a-zA-Z0-9]{20,}\b/i,
    ],
  },
  {
    id: "credentials.bearer_token",
    description: "Blocks bearer token disclosure",
    reason: "Message appears to contain a bearer token",
    blocked_patterns: [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i],
  },
  {
    id: "credentials.private_key_material",
    description: "Blocks private key disclosure",
    reason: "Message appears to contain private key material",
    blocked_patterns: [/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  },
];

export function evaluatePlatformGuardrails(message: string): PlatformGuardrailEvaluation {
  for (const guardrail of PLATFORM_GUARDRAILS) {
    for (const pattern of guardrail.blocked_patterns) {
      if (pattern.test(message)) {
        return {
          blocked: true,
          guardrail_id: guardrail.id,
          reason: `Blocked by platform guardrail (${guardrail.id}): ${guardrail.reason}`,
        };
      }
    }
  }

  return { blocked: false };
}

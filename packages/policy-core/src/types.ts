export type PolicyScope = "global" | "user" | "role" | "group";
export type PolicyDirection =
  | "outbound"
  | "inbound"
  | "request"
  | "response"
  | "notification"
  | "error";
export type PolicyEffect = "allow" | "ask" | "deny";
export type PolicyEvaluator = "structured" | "heuristic" | "llm";
export type PolicySource =
  | "default"
  | "learned"
  | "user_confirmed"
  | "override"
  | "user_created"
  | "legacy_migrated";

export interface PolicyLearningProvenance {
  source_interaction_id: string | null;
  promoted_from_policy_ids: string[];
}

export interface CorePolicy {
  id: string;
  scope: PolicyScope;
  effect: PolicyEffect;
  evaluator: PolicyEvaluator;
  policy_content: unknown;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  source: PolicySource;
  derived_from_message_id: string | null;
  learning_provenance?: PolicyLearningProvenance | null;
  priority: number;
  created_at: string | null;
}

export type PolicyResolverLayer = "platform_guardrails" | "user_policies";
export type PolicyEvaluationPhase = "deterministic" | "contextual_llm";

export interface AuthenticatedSenderIdentity {
  sender_user_id: string;
  sender_connection_id: string;
}

export interface PolicySelectorInput {
  direction?: string | null;
  resource?: string | null;
  action?: string | null;
}

export interface PolicySelectorContext {
  direction?: PolicyDirection;
  resource?: string;
  action?: string;
}

export interface ResolvedPolicySelectorContext {
  direction: PolicyDirection;
  resource: string;
  action: string;
}

export interface SelectorFilterCandidate {
  direction?: string | null;
  resource?: string | null;
  action?: string | null;
}

export interface PolicyLifecycleProvenance {
  created_by_user_id: string;
  source: PolicySource;
  derived_from_message_id: string | null;
  learning_provenance: PolicyLearningProvenance | null;
  effective_from: string | null;
  expires_at: string | null;
  max_uses: number | null;
  remaining_uses: number | null;
  created_at: string | null;
}

export interface EvaluatedPolicy extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  priority: number;
  phase: PolicyEvaluationPhase;
  matched: boolean;
  reason?: string;
  skipped?: boolean;
  skip_reason?: string;
}

export interface PolicyMatch extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  reason: string;
  priority: number;
  phase: PolicyEvaluationPhase;
  reason_code?: string;
}

export interface WinningPolicy extends PolicyLifecycleProvenance {
  policy_id: string;
  scope: PolicyScope;
  evaluator: PolicyEvaluator;
  effect: PolicyEffect;
  priority: number;
  phase: PolicyEvaluationPhase;
  reason: string;
  reason_code?: string;
}

export interface ScopeResolution {
  effect: PolicyEffect;
  winner: PolicyMatch;
}

export type SpecificityScope = "user" | "role" | "global";

export interface PolicyResolutionContext {
  all_matches: PolicyMatch[];
  deterministic_evaluated: EvaluatedPolicy[];
  llm_evaluated: EvaluatedPolicy[];
  base_resolution: (ScopeResolution & { scope: SpecificityScope }) | null;
  group_resolution: ScopeResolution | null;
  final_effect: PolicyEffect;
}

export interface MatchedPolicyResolution {
  base_resolution: (ScopeResolution & { scope: SpecificityScope }) | null;
  group_resolution: ScopeResolution | null;
  final_effect: PolicyEffect;
  winning_match: PolicyMatch | null;
}

export interface PolicyResult {
  allowed: boolean;
  effect: PolicyEffect;
  reason?: string;
  reason_code: string;
  resolution_explanation: string;
  authenticated_identity?: AuthenticatedSenderIdentity;
  resolver_layer?: PolicyResolverLayer;
  guardrail_id?: string;
  winning_policy_id?: string;
  winning_policy?: WinningPolicy;
  matched_policy_ids: string[];
  evaluated_policies: EvaluatedPolicy[];
}

export interface PolicyEvaluationResult {
  evaluated_policy: EvaluatedPolicy;
  match: PolicyMatch | null;
}

export interface LLMPolicyEvaluationInput {
  policyContent: string;
  message: string;
  subject: string;
  context?: string;
}

export type LLMPolicyEvaluationErrorKind =
  | "timeout"
  | "network"
  | "provider"
  | "invalid_response"
  | "unavailable"
  | "unknown";

export interface LLMPolicyEvaluationResult {
  status: "pass" | "match" | "skip" | "error";
  reasoning?: string;
  skip_reason?: string;
  error?: string;
  error_kind?: LLMPolicyEvaluationErrorKind;
}

export interface LLMPolicyEvaluationError {
  kind: LLMPolicyEvaluationErrorKind;
  message: string;
}

export interface LLMProviderAdapterRequest {
  input: LLMPolicyEvaluationInput;
  prompt: string;
}

export interface LLMProviderAdapterResponse {
  text: string;
  provider?: string;
  model?: string;
}

export type LLMProviderAdapter = (
  request: LLMProviderAdapterRequest,
) => Promise<LLMProviderAdapterResponse>;

export interface CreateLLMPolicyEvaluatorOptions {
  providerAdapter: LLMProviderAdapter;
  normalizeError?: (error: unknown) => LLMPolicyEvaluationError;
  onError?: (
    error: LLMPolicyEvaluationError,
    input: LLMPolicyEvaluationInput,
  ) => LLMPolicyEvaluationResult | Promise<LLMPolicyEvaluationResult>;
}

export type LLMPolicyEvaluator = (
  input: LLMPolicyEvaluationInput,
) => Promise<LLMPolicyEvaluationResult>;

export type LLMEvaluationFallbackMode = "skip" | PolicyEffect;

export interface ResolvePolicySetOptions {
  policies: ReadonlyArray<CorePolicy>;
  ownerUserId: string;
  message: string;
  llmSubject: string;
  context?: string;
  recipientUsername?: string;
  authenticatedIdentity?: AuthenticatedSenderIdentity;
  resolverLayer?: PolicyResolverLayer;
  llmEvaluator?: LLMPolicyEvaluator;
  llmUnavailableMode?: LLMEvaluationFallbackMode;
  llmErrorMode?: LLMEvaluationFallbackMode;
  llmSkipMode?: LLMEvaluationFallbackMode;
}

export interface ParsedLLMPolicyEvaluation extends LLMPolicyEvaluationResult {}

export const POLICY_RESOLVER_ORDER: PolicyResolverLayer[] = [
  "platform_guardrails",
  "user_policies",
];

export const EFFECT_PRECEDENCE: Record<PolicyEffect, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

export const PHASE_PRECEDENCE: Record<PolicyEvaluationPhase, number> = {
  deterministic: 1,
  contextual_llm: 0,
};

export const SPECIFICITY_ORDER: SpecificityScope[] = ["user", "role", "global"];

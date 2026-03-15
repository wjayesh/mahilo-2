import {
  createLLMPolicyEvaluator,
  normalizeLLMPolicyEvaluationError,
  type CreateLLMPolicyEvaluatorOptions,
  type LLMPolicyEvaluationError,
  type LLMPolicyEvaluator,
  type LLMProviderAdapter,
} from "@mahilo/policy-core";
import {
  resolveMahiloLocalPolicyLLMConfig,
  type MahiloLocalPolicyLLMCredentialSource,
  type MahiloPluginConfig,
  type ResolveMahiloLocalPolicyLLMConfigOptions,
} from "./config";
import type { LocalPolicyLLMEvaluatorFactory } from "./local-policy-runtime";

export const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";

interface OpenAIResponseContentPart {
  refusal?: string;
  text?: string;
  type?: string;
}

interface OpenAIResponseOutputItem {
  content?: OpenAIResponseContentPart[];
  type?: string;
}

interface OpenAIResponse {
  output?: OpenAIResponseOutputItem[];
  output_text?: string | null;
}

export interface ResolvedOpenAILocalPolicyConfig {
  apiKey: string;
  apiKeyEnvVar?: string;
  authProfile?: string;
  credentialSource: MahiloLocalPolicyLLMCredentialSource;
  model: string;
  provider: "openai";
  timeout: number;
}

export interface ResolveOpenAILocalPolicyConfigOptions
  extends Pick<
    ResolveMahiloLocalPolicyLLMConfigOptions,
    "defaultTimeout" | "env"
  > {
  providerDefaults?: ResolveMahiloLocalPolicyLLMConfigOptions["providerDefaults"] | null;
}

export interface CreateOpenAILocalPolicyEvaluatorOptions
  extends Pick<CreateLLMPolicyEvaluatorOptions, "onError"> {
  fetch?: typeof globalThis.fetch;
  normalizeError?: (error: unknown) => LLMPolicyEvaluationError;
}

export interface CreateOpenAILocalPolicyEvaluatorFactoryOptions
  extends CreateOpenAILocalPolicyEvaluatorOptions,
    ResolveOpenAILocalPolicyConfigOptions {}

export function resolveOpenAILocalPolicyConfig(
  config: Pick<MahiloPluginConfig, "localPolicyLLM"> | undefined,
  options: ResolveOpenAILocalPolicyConfigOptions = {},
): ResolvedOpenAILocalPolicyConfig | undefined {
  const configuredProvider = normalizeProvider(config?.localPolicyLLM?.provider);
  const normalizedProviderDefaults = normalizeProviderDefaults(
    options.providerDefaults,
    configuredProvider,
  );
  const resolved = resolveMahiloLocalPolicyLLMConfig(config, {
    defaultTimeout: options.defaultTimeout,
    env: options.env,
    providerDefaults: normalizedProviderDefaults,
  });

  if (
    resolved.provider !== "openai" ||
    !resolved.apiKey ||
    !resolved.model
  ) {
    return undefined;
  }

  return {
    apiKey: resolved.apiKey,
    apiKeyEnvVar: resolved.apiKeyEnvVar,
    authProfile: resolved.authProfile,
    credentialSource: resolved.credentialSource,
    model: resolved.model,
    provider: "openai",
    timeout: resolved.timeout,
  };
}

export function createOpenAILocalPolicyProviderAdapter(
  config: ResolvedOpenAILocalPolicyConfig,
  options: Pick<CreateOpenAILocalPolicyEvaluatorOptions, "fetch"> = {},
): LLMProviderAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async ({ prompt }) => ({
    text: await callOpenAI(prompt, config, fetchImpl),
    provider: "openai",
    model: config.model,
  });
}

export function createOpenAILocalPolicyEvaluator(
  config: ResolvedOpenAILocalPolicyConfig,
  options: CreateOpenAILocalPolicyEvaluatorOptions = {},
): LLMPolicyEvaluator {
  return createLLMPolicyEvaluator({
    providerAdapter: createOpenAILocalPolicyProviderAdapter(config, {
      fetch: options.fetch,
    }),
    normalizeError: options.normalizeError ?? normalizeOpenAILocalPolicyError,
    onError: options.onError,
  });
}

export function createOpenAILocalPolicyEvaluatorFactory(
  config: Pick<MahiloPluginConfig, "localPolicyLLM"> | undefined,
  options: CreateOpenAILocalPolicyEvaluatorFactoryOptions = {},
): LocalPolicyLLMEvaluatorFactory {
  return ({ llm }) => {
    const resolved = resolveOpenAILocalPolicyConfig(config, {
      defaultTimeout: options.defaultTimeout,
      env: options.env,
      providerDefaults: llm.provider_defaults,
    });

    if (!resolved) {
      return undefined;
    }

    return createOpenAILocalPolicyEvaluator(resolved, {
      fetch: options.fetch,
      normalizeError: options.normalizeError,
      onError: options.onError,
    });
  };
}

export function normalizeOpenAILocalPolicyError(
  error: unknown,
): LLMPolicyEvaluationError {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /timed?\s*out|aborted/iu.test(error.message)
    ) {
      return {
        kind: "timeout",
        message: error.message || "OpenAI request timed out",
      };
    }

    if (
      /malformed response|missing output|invalid json|empty response/iu.test(
        error.message,
      )
    ) {
      return {
        kind: "invalid_response",
        message: error.message,
      };
    }

    if (/openai api error/iu.test(error.message)) {
      return {
        kind: "provider",
        message: error.message,
      };
    }

    if (
      /network|fetch|enotfound|econnrefused|econnreset|eai_again|socket|hang up|failed to fetch/iu.test(
        error.message,
      )
    ) {
      return {
        kind: "network",
        message: error.message,
      };
    }
  }

  return normalizeLLMPolicyEvaluationError(error, "provider");
}

async function callOpenAI(
  prompt: string,
  config: ResolvedOpenAILocalPolicyConfig,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: prompt,
    }),
    signal: AbortSignal.timeout(config.timeout),
  });

  if (!response.ok) {
    const errorBody = (await response.text()).trim();
    throw new Error(
      `OpenAI API error: ${response.status} - ${
        errorBody || response.statusText || "Request failed"
      }`,
    );
  }

  const data = await parseOpenAIResponse(response);
  return extractOpenAIText(data);
}

async function parseOpenAIResponse(response: Response): Promise<OpenAIResponse> {
  try {
    return (await response.json()) as OpenAIResponse;
  } catch {
    throw new Error("Malformed response from OpenAI API: invalid JSON");
  }
}

function extractOpenAIText(response: OpenAIResponse): string {
  if (
    typeof response.output_text === "string" &&
    response.output_text.trim().length > 0
  ) {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    throw new Error("Malformed response from OpenAI API: missing output");
  }

  const segments: string[] = [];
  for (const item of response.output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      if (typeof part.text === "string" && part.text.trim().length > 0) {
        segments.push(part.text);
        continue;
      }

      if (
        typeof part.refusal === "string" &&
        part.refusal.trim().length > 0
      ) {
        segments.push(part.refusal);
      }
    }
  }

  const normalized = segments.join("\n").trim();
  if (normalized.length === 0) {
    throw new Error("Malformed response from OpenAI API: missing output text");
  }

  return normalized;
}

function normalizeProviderDefaults(
  providerDefaults:
    | ResolveMahiloLocalPolicyLLMConfigOptions["providerDefaults"]
    | null,
  configuredProvider?: string,
): ResolveMahiloLocalPolicyLLMConfigOptions["providerDefaults"] {
  const defaultProvider = normalizeProvider(providerDefaults?.provider);
  const defaultModel = readOptionalString(providerDefaults?.model);
  const allowDefaultModel =
    !configuredProvider || configuredProvider === defaultProvider;

  return {
    provider: defaultProvider,
    // Do not inherit a bundle model from a different provider.
    model: allowDefaultModel ? defaultModel : undefined,
  };
}

function normalizeProvider(value: unknown): string | undefined {
  const normalized = readOptionalString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

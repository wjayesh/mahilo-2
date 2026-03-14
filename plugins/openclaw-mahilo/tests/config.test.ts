import { describe, expect, it } from "bun:test";

import {
  DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS,
  MAHILO_PLUGIN_RELEASE_VERSION,
  MahiloConfigError,
  MahiloContractClient,
  createClientOptionsFromConfig,
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  redactSensitiveConfig,
  resolveMahiloLocalPolicyLLMConfig
} from "../src";

describe("parseMahiloPluginConfig", () => {
  it("defaults baseUrl to the global Mahilo server", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key"
    });

    expect(config.baseUrl).toBe("https://mahilo.io");
  });

  it("parses required fields and applies defaults", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example/"
    });

    expect(config.baseUrl).toBe("https://mahilo.example");
    expect(config.reviewMode).toBe("ask");
    expect(config.cacheTtlSeconds).toBe(60);
    expect(config.promptContextEnabled).toBe(true);
    expect(config.contractVersion).toBe("1.0.0");
    expect(config.pluginVersion).toBe(MAHILO_PLUGIN_RELEASE_VERSION);
    expect(config.localPolicyLLM).toBeUndefined();
  });

  it("parses local policy LLM settings with a default timeout", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: " OpenAI ",
        model: " gpt-4o-mini ",
        authProfile: " primary-openai ",
        apiKeyEnvVar: "CUSTOM_OPENAI_KEY"
      }
    });

    expect(config.localPolicyLLM).toEqual({
      apiKey: undefined,
      apiKeyEnvVar: "CUSTOM_OPENAI_KEY",
      authProfile: "primary-openai",
      model: "gpt-4o-mini",
      provider: "openai",
      timeout: DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS
    });
  });

  it("throws for invalid baseUrl", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "/relative"
      })
    ).toThrow(MahiloConfigError);
  });

  it("throws for unsupported review mode", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        reviewMode: "always"
      })
    ).toThrow("reviewMode must be one of");
  });

  it("throws when config is not an object", () => {
    expect(() => parseMahiloPluginConfig("not-an-object")).toThrow(
      "plugin config must be an object"
    );
  });

  it("throws when required fields are missing", () => {
    expect(() => parseMahiloPluginConfig({ baseUrl: "https://mahilo.example" })).toThrow(
      "apiKey must be a non-empty string"
    );
  });

  it("allows apiKey to be omitted for setup bootstrap mode", () => {
    const config = parseMahiloPluginConfig(
      {
        baseUrl: "https://mahilo.example"
      },
      {
        requireApiKey: false
      }
    );

    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe("https://mahilo.example");
  });

  it("parses callbackUrl as absolute URL", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      callbackUrl: "https://example.com/hooks/mahilo"
    });

    expect(config.callbackUrl).toBe("https://example.com/hooks/mahilo");
  });

  it("throws for invalid callbackUrl", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        callbackUrl: "not-a-url"
      })
    ).toThrow("callbackUrl must be a valid absolute URL");
  });

  it("parses callbackPath when provided", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      callbackPath: "/hooks/mahilo"
    });

    expect(config.callbackPath).toBe("/hooks/mahilo");
  });

  it("throws for invalid callbackPath", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        callbackPath: "hooks/mahilo"
      })
    ).toThrow("callbackPath must start with '/'");
  });

  it("throws for negative cacheTtlSeconds", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        cacheTtlSeconds: -1
      })
    ).toThrow("cacheTtlSeconds must be a non-negative integer");
  });

  it("throws when localPolicyLLM is not an object", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        localPolicyLLM: "openai"
      })
    ).toThrow("localPolicyLLM must be an object");
  });

  it("throws for unsupported localPolicyLLM keys", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        localPolicyLLM: {
          provider: "openai",
          credentialPath: "/tmp/key"
        }
      })
    ).toThrow("unsupported localPolicyLLM config key(s): credentialPath");
  });

  it("throws for invalid localPolicyLLM timeout", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        localPolicyLLM: {
          timeout: 0
        }
      })
    ).toThrow("localPolicyLLM.timeout must be a positive integer");
  });

  it("throws for invalid localPolicyLLM env var override names", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        localPolicyLLM: {
          apiKeyEnvVar: "OPENAI-API-KEY"
        }
      })
    ).toThrow("localPolicyLLM.apiKeyEnvVar must be a valid env var name");
  });

  it("parses promptContextEnabled when explicitly provided", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      promptContextEnabled: false
    });

    expect(config.promptContextEnabled).toBe(false);
  });

  it("throws for non-boolean promptContextEnabled", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        promptContextEnabled: "false"
      })
    ).toThrow("promptContextEnabled must be a boolean");
  });

  it("accepts explicit defaults override", () => {
    const config = parseMahiloPluginConfig(
      {
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example"
      },
      {
        defaults: {
          cacheTtlSeconds: 120,
          contractVersion: "2.0.0",
          promptContextEnabled: false,
          pluginVersion: "1.2.3",
          reviewMode: "manual"
        }
      }
    );

    expect(config.cacheTtlSeconds).toBe(120);
    expect(config.contractVersion).toBe("2.0.0");
    expect(config.promptContextEnabled).toBe(false);
    expect(config.pluginVersion).toBe("1.2.3");
    expect(config.reviewMode).toBe("manual");
  });

  it("rejects unknown plugin config keys", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        unknownKnob: true
      })
    ).toThrow("unsupported plugin config key(s): unknownKnob");
  });

  it("rejects legacy server-owned plugin config keys", () => {
    expect(() =>
      parseMahiloPluginConfig({
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example",
        contractVersion: "9.9.9"
      })
    ).toThrow("Server-owned/deprecated keys are not allowed in plugin config");
  });
});

describe("config helpers", () => {
  it("builds client options from parsed config", () => {
    const config = parseMahiloPluginConfig(
      {
        apiKey: "mahilo-key",
        baseUrl: "https://mahilo.example"
      },
      {
        defaults: {
          contractVersion: "1.1.0",
          pluginVersion: "9.9.9"
        }
      }
    );

    expect(createClientOptionsFromConfig(config)).toEqual({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      contractVersion: "1.1.0",
      pluginVersion: "9.9.9"
    });
  });

  it("throws when client options are requested without an apiKey", () => {
    const config = parseMahiloPluginConfig(
      {
        baseUrl: "https://mahilo.example"
      },
      {
        requireApiKey: false
      }
    );

    expect(() => createClientOptionsFromConfig(config)).toThrow("apiKey must be a non-empty string");
  });

  it("creates Mahilo contract client from config", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example"
    });

    const client = createMahiloClientFromConfig(config);
    expect(client).toBeInstanceOf(MahiloContractClient);
  });

  it("redacts sensitive config values", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-super-secret",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        apiKey: "sk-policy-secret"
      }
    });

    const redacted = redactSensitiveConfig(config);
    expect(redacted.apiKey).toBe("ma***et");
    expect((redacted.localPolicyLLM as { apiKey?: unknown }).apiKey).toBe("sk***et");
    expect((redacted as { callbackSecret?: unknown }).callbackSecret).toBeUndefined();
    expect(redacted.baseUrl).toBe("https://mahilo.example");
  });
});

describe("resolveMahiloLocalPolicyLLMConfig", () => {
  it("prefers inline local policy API keys over env fallback", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        apiKey: "inline-policy-key",
        apiKeyEnvVar: "CUSTOM_OPENAI_KEY",
        timeout: 9000
      }
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        env: {
          CUSTOM_OPENAI_KEY: "env-policy-key"
        }
      })
    ).toEqual({
      apiKey: "inline-policy-key",
      apiKeyEnvVar: "CUSTOM_OPENAI_KEY",
      authProfile: undefined,
      credentialSource: "inline",
      model: undefined,
      provider: "openai",
      timeout: 9000
    });
  });

  it("prefers the configured env var override over provider-default env fallback", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY"
      }
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        env: {
          MAHILO_OPENAI_POLICY_KEY: "custom-env-key",
          OPENAI_API_KEY: "provider-default-key"
        }
      })
    ).toEqual({
      apiKey: "custom-env-key",
      apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: undefined,
      provider: "openai",
      timeout: DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS
    });
  });

  it("falls back to bundle defaults and provider-default env lookup when config overrides are absent", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example"
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        env: {
          OPENAI_API_KEY: "provider-default-key"
        },
        providerDefaults: {
          provider: "openai",
          model: "gpt-4o-mini"
        }
      })
    ).toEqual({
      apiKey: "provider-default-key",
      apiKeyEnvVar: "OPENAI_API_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: "gpt-4o-mini",
      provider: "openai",
      timeout: DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS
    });
  });

  it("prefers plugin-local model and timeout over bundle defaults", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        model: "gpt-4.1-mini",
        timeout: 9000,
        apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY"
      }
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        defaultTimeout: 1500,
        env: {
          MAHILO_OPENAI_POLICY_KEY: "custom-env-key",
          OPENAI_API_KEY: "provider-default-key"
        },
        providerDefaults: {
          provider: "openai",
          model: "gpt-4o-mini"
        }
      })
    ).toEqual({
      apiKey: "custom-env-key",
      apiKeyEnvVar: "MAHILO_OPENAI_POLICY_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: "gpt-4.1-mini",
      provider: "openai",
      timeout: 9000
    });
  });

  it("uses the caller-supplied default timeout when no plugin-local override exists", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example"
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        defaultTimeout: 1500,
        env: {
          OPENAI_API_KEY: "provider-default-key"
        },
        providerDefaults: {
          provider: "openai",
          model: "gpt-4o-mini"
        }
      })
    ).toEqual({
      apiKey: "provider-default-key",
      apiKeyEnvVar: "OPENAI_API_KEY",
      authProfile: undefined,
      credentialSource: "env",
      model: "gpt-4o-mini",
      provider: "openai",
      timeout: 1500
    });
  });

  it("preserves authProfile hints without claiming a credential source when no key resolves", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example",
      localPolicyLLM: {
        provider: "openai",
        authProfile: "primary-openai"
      }
    });

    expect(
      resolveMahiloLocalPolicyLLMConfig(config, {
        env: {}
      })
    ).toEqual({
      apiKey: undefined,
      apiKeyEnvVar: "OPENAI_API_KEY",
      authProfile: "primary-openai",
      credentialSource: "none",
      model: undefined,
      provider: "openai",
      timeout: DEFAULT_LOCAL_POLICY_LLM_TIMEOUT_MS
    });
  });
});

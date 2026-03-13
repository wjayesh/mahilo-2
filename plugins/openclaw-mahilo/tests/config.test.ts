import { describe, expect, it } from "bun:test";

import {
  MAHILO_PLUGIN_RELEASE_VERSION,
  MahiloConfigError,
  MahiloContractClient,
  createClientOptionsFromConfig,
  createMahiloClientFromConfig,
  parseMahiloPluginConfig,
  redactSensitiveConfig
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
      baseUrl: "https://mahilo.example"
    });

    const redacted = redactSensitiveConfig(config);
    expect(redacted.apiKey).toBe("ma***et");
    expect((redacted as { callbackSecret?: unknown }).callbackSecret).toBeUndefined();
    expect(redacted.baseUrl).toBe("https://mahilo.example");
  });
});

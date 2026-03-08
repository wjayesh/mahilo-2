import { describe, expect, it } from "bun:test";

import { MahiloConfigError, parseMahiloPluginConfig } from "../src";

describe("parseMahiloPluginConfig", () => {
  it("parses required fields and applies defaults", () => {
    const config = parseMahiloPluginConfig({
      apiKey: "mahilo-key",
      baseUrl: "https://mahilo.example/"
    });

    expect(config.baseUrl).toBe("https://mahilo.example");
    expect(config.reviewMode).toBe("ask");
    expect(config.cacheTtlSeconds).toBe(60);
    expect(config.contractVersion).toBe("1.0.0");
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
});

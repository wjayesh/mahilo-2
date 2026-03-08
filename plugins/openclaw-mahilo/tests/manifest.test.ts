import { describe, expect, it } from "bun:test";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("openclaw.plugin.json", () => {
  it("loads manifest metadata", async () => {
    const manifest = (await Bun.file(manifestPath).json()) as unknown;

    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) {
      return;
    }

    expect(manifest.id).toBe("mahilo");
    expect(manifest.name).toBe("Mahilo");
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.entry).toBe("./dist/index.js");
  });

  it("loads config schema with clear plugin-local boundaries", async () => {
    const manifest = (await Bun.file(manifestPath).json()) as unknown;

    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) {
      return;
    }

    const configSchema = manifest.configSchema;
    expect(isRecord(configSchema)).toBe(true);

    if (!isRecord(configSchema)) {
      return;
    }

    expect(configSchema.type).toBe("object");
    expect(configSchema.additionalProperties).toBe(false);
    expect(configSchema.description).toContain("Plugin-local runtime configuration only");
    expect(configSchema.description).toContain("source of truth");

    const required = configSchema.required;
    expect(Array.isArray(required)).toBe(true);

    if (!Array.isArray(required)) {
      return;
    }

    expect(required).toEqual(["baseUrl", "apiKey"]);

    const properties = configSchema.properties;
    expect(isRecord(properties)).toBe(true);

    if (!isRecord(properties)) {
      return;
    }

    expect(Object.keys(properties).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "cacheTtlSeconds",
      "callbackPath",
      "callbackUrl",
      "reviewMode"
    ]);

    const baseUrl = properties.baseUrl;
    const apiKey = properties.apiKey;
    const callbackPath = properties.callbackPath;

    expect(isRecord(baseUrl)).toBe(true);
    expect(isRecord(apiKey)).toBe(true);
    expect(isRecord(callbackPath)).toBe(true);

    if (!isRecord(baseUrl) || !isRecord(apiKey) || !isRecord(callbackPath)) {
      return;
    }

    expect(baseUrl.type).toBe("string");
    expect(apiKey.type).toBe("string");
    expect(apiKey.format).toBe("password");
    expect(apiKey.writeOnly).toBe(true);
    expect(apiKey["x-sensitive"]).toBe(true);
    expect(callbackPath.pattern).toBe("^\\/.*");
  });
});

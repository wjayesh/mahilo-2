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

  it("loads config schema with required fields", async () => {
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

    const required = configSchema.required;
    expect(Array.isArray(required)).toBe(true);

    if (!Array.isArray(required)) {
      return;
    }

    expect(required).toContain("baseUrl");
    expect(required).toContain("apiKey");

    const properties = configSchema.properties;
    expect(isRecord(properties)).toBe(true);

    if (!isRecord(properties)) {
      return;
    }

    const baseUrl = properties.baseUrl;
    const apiKey = properties.apiKey;

    expect(isRecord(baseUrl)).toBe(true);
    expect(isRecord(apiKey)).toBe(true);

    if (!isRecord(baseUrl) || !isRecord(apiKey)) {
      return;
    }

    expect(baseUrl.type).toBe("string");
    expect(apiKey.type).toBe("string");
  });
});

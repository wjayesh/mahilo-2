export const MAHILO_PLUGIN_PACKAGE_NAME = "@mahilo/openclaw-mahilo";
export const MAHILO_RUNTIME_PLUGIN_ID = "mahilo";
export const MAHILO_RUNTIME_PLUGIN_NAME = "Mahilo";
export const MAHILO_RUNTIME_PLUGIN_DESCRIPTION = "Mahilo policy-aware communication tools for OpenClaw.";
export const MAHILO_PLUGIN_CONFIG_ENTRY_KEY = `plugins.entries.${MAHILO_RUNTIME_PLUGIN_ID}.config`;

export const MAHILO_PLUGIN_CONFIG_KEYS = [
  "baseUrl",
  "apiKey",
  "callbackUrl",
  "callbackPath",
  "promptContextEnabled",
  "reviewMode",
  "cacheTtlSeconds"
] as const;

export const config = {
  port: parseInt(process.env.PORT || "8080", 10),
  host: process.env.HOST || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL || "./data/mahilo.db",
  secretKey: process.env.SECRET_KEY || "dev-secret-change-in-production",
  nodeEnv: process.env.NODE_ENV || "development",
  trustedMode: process.env.TRUSTED_MODE === "true",

  // API settings
  apiVersion: "v1",
  apiPrefix: "/api/v1",

  // Rate limiting (requests per minute per user)
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT || "100", 10),

  // Message settings
  maxPayloadSize: parseInt(process.env.MAX_PAYLOAD_SIZE || "32768", 10), // 32KB

  // Retry settings
  maxRetries: parseInt(process.env.MAX_RETRIES || "5", 10),
  callbackTimeoutMs: parseInt(process.env.CALLBACK_TIMEOUT_MS || "30000", 10),

  // Security
  allowPrivateIps: process.env.ALLOW_PRIVATE_IPS === "true", // For self-hosted
  adminApiKey: process.env.ADMIN_API_KEY || "", // Required for admin endpoints

  // LLM Policy Evaluation (PERM-015)
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.LLM_POLICY_MODEL || "claude-3-haiku-20240307",
    timeoutMs: parseInt(process.env.LLM_POLICY_TIMEOUT_MS || "5000", 10),
    enabled: !!process.env.ANTHROPIC_API_KEY, // Only enabled if API key is set
  },
} as const;

export type Config = typeof config;

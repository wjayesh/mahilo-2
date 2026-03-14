import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";

export interface UserLLMProviderDefaults {
  model: string;
  provider: string;
}

export async function loadUserLLMProviderDefaults(
  userId: string,
): Promise<UserLLMProviderDefaults | null> {
  const db = getDb();
  const [preferences] = await db
    .select({
      defaultLlmModel: schema.userPreferences.defaultLlmModel,
      defaultLlmProvider: schema.userPreferences.defaultLlmProvider,
    })
    .from(schema.userPreferences)
    .where(eq(schema.userPreferences.userId, userId))
    .limit(1);

  const provider = normalizeProviderPreference(
    preferences?.defaultLlmProvider ?? null,
  );
  const model = normalizeModelPreference(preferences?.defaultLlmModel ?? null);

  if (!provider || !model) {
    return null;
  }

  return {
    model,
    provider,
  };
}

function normalizeProviderPreference(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeModelPreference(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

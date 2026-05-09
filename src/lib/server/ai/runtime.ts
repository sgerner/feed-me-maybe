import { getDb } from '$lib/server/db';
import { decrypt } from './crypto';
import { createAiClient } from './client';
import { getProvider } from './models-dev';

type ProviderConfigRow = {
  provider_id: string;
  model_id: string;
  api_key_encrypted: string | null;
  api_key_nonce: string | null;
  custom_base_url: string | null;
};

export async function getConfiguredAiClient() {
  const db = getDb();
  const config = db
    .prepare('SELECT * FROM provider_configs WHERE enabled = 1 LIMIT 1')
    .get() as ProviderConfigRow | undefined;

  if (!config) return null;

  const decryptedRaw = decrypt(
    config.api_key_encrypted || '',
    config.api_key_nonce || '',
  );
  if (!decryptedRaw) return null;

  const decryptedConfig: Record<string, string> = (() => {
    try {
      return JSON.parse(decryptedRaw) as Record<string, string>;
    } catch {
      return { apiKey: decryptedRaw };
    }
  })();

  const providerInfo = await getProvider(config.provider_id);
  const baseUrl = config.custom_base_url || providerInfo?.baseUrl || '';

  const apiKey = providerInfo?.requiredEnvVars?.length
    ? decryptedConfig[providerInfo.requiredEnvVars[0]] ||
      Object.values(decryptedConfig)[0] ||
      ''
    : decryptedConfig.apiKey || Object.values(decryptedConfig)[0] || '';

  if (!apiKey || !baseUrl) return null;

  return createAiClient({
    baseUrl,
    apiKey,
    model: config.model_id,
  });
}

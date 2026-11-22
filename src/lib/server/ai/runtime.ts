import { getDb } from '#lib/server/db/index.ts';
import {
  decryptProviderCredentials,
  hasProviderCredentials,
} from './credentials';
import { createAiClient } from './client';
import { getProvider } from './models-dev';

type ProviderConfigRow = {
  provider_id: string;
  model_id: string;
  api_key_encrypted: string | null;
  api_key_nonce: string | null;
  custom_base_url: string | null;
};

export function isAiProcessingConfigured(): boolean {
  const config = getProviderConfig();
  return Boolean(
    config &&
    hasProviderCredentials(config.api_key_encrypted, config.api_key_nonce),
  );
}

function getProviderConfig() {
  const db = getDb();
  const setting = db
    .prepare("SELECT value FROM app_settings WHERE key = 'ai_enabled'")
    .get() as { value: string } | undefined;
  if (setting?.value === 'false') return undefined;
  return db
    .prepare(
      'SELECT * FROM provider_configs WHERE enabled = 1 ORDER BY updated_at DESC, id DESC LIMIT 1',
    )
    .get() as ProviderConfigRow | undefined;
}

const CREDENTIAL_KEY_PATTERN =
  /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|(?:^|[_-])(?:TOKEN|PAT|KEY|SECRET))$/i;

export async function getConfiguredAiClient() {
  const config = getProviderConfig();

  if (!config) return null;

  const decryptedConfig = decryptProviderCredentials(
    config.api_key_encrypted,
    config.api_key_nonce,
  );
  if (Object.keys(decryptedConfig).length === 0) return null;

  const providerInfo = await getProvider(config.provider_id);
  if (!providerInfo) return null;
  const modelInfo = providerInfo?.models.find(
    (model) => model.id === config.model_id,
  );
  const baseUrl = config.custom_base_url || providerInfo.baseUrl;

  const keyVariable = [
    ...providerInfo.requiredEnvVars.filter((name) =>
      CREDENTIAL_KEY_PATTERN.test(name),
    ),
    ...Object.keys(decryptedConfig).filter((name) =>
      CREDENTIAL_KEY_PATTERN.test(name),
    ),
  ].find((name) => decryptedConfig[name]?.trim());
  const apiKey =
    decryptedConfig.apiKey?.trim() ||
    (keyVariable ? decryptedConfig[keyVariable].trim() : '');

  if (!apiKey || !baseUrl) return null;

  return createAiClient({
    baseUrl,
    apiKey,
    model: config.model_id,
    providerId: config.provider_id,
    supportsTemperature: modelInfo?.temperature !== false,
  });
}

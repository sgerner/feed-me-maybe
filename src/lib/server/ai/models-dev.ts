import { type AiProvider, type AiModel } from './types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL = 1000 * 60 * 60; // 1 hour
const OPENAI_API_URL = 'https://api.openai.com/v1';
const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

let cache: { data: any; timestamp: number } | null = null;
let pendingFetch: Promise<any> | null = null;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compatibleBaseUrl(id: string, provider: Record<string, any>): string {
  const npm = provider.npm;
  if (id === 'openai' && npm === '@ai-sdk/openai') return OPENAI_API_URL;

  const hasCompatibleAdapter =
    npm === OPENAI_COMPATIBLE_NPM ||
    npm === '@ai-sdk/openai' ||
    (id === 'openrouter' && npm === '@openrouter/ai-sdk-provider');
  const api = typeof provider.api === 'string' ? provider.api.trim() : '';
  if (!hasCompatibleAdapter || !api || api.includes('${')) return '';

  try {
    const url = new URL(api);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function isTextChatModel(model: Record<string, any>): boolean {
  const modalities = model.modalities;
  const contextWindow = Number(model.limit?.context);
  return (
    model.status !== 'deprecated' &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    isRecord(modalities) &&
    Array.isArray(modalities.input) &&
    modalities.input.includes('text') &&
    Array.isArray(modalities.output) &&
    modalities.output.includes('text')
  );
}

async function fetchModelsDev() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  if (pendingFetch) return pendingFetch;

  pendingFetch = (async () => {
    try {
      const response = await fetch(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch models.dev: ${response.statusText}`);
      }

      const data = await response.json();
      cache = { data, timestamp: Date.now() };
      return data;
    } catch (error) {
      if (cache) return cache.data;
      throw error;
    } finally {
      pendingFetch = null;
    }
  })();
  return pendingFetch;
}

export async function getProviders(): Promise<AiProvider[]> {
  const data = await fetchModelsDev();
  if (!isRecord(data)) throw new Error('Invalid models.dev catalog');

  return Object.entries(data).flatMap(([id, rawProvider]) => {
    if (!isRecord(rawProvider)) return [];
    const baseUrl = compatibleBaseUrl(id, rawProvider);
    if (!baseUrl) return [];

    const models: AiModel[] = Object.entries(
      isRecord(rawProvider.models) ? rawProvider.models : {},
    )
      .filter(([, model]) => isRecord(model) && isTextChatModel(model))
      .map(([modelId, model]) => ({
        id: modelId,
        name: model.name || modelId,
        family: model.family,
        contextWindow: Number(model.limit?.context),
        inputPrice: safeNonNegativeNumber(model.cost?.input),
        outputPrice: safeNonNegativeNumber(model.cost?.output),
        reasoning: Boolean(model.reasoning),
        toolCall: Boolean(model.tool_call),
        structuredOutput: Boolean(model.structured_output),
        temperature: model.temperature !== false,
      }));

    if (models.length === 0) return [];

    return {
      id,
      name: rawProvider.name || id,
      description: rawProvider.description || '',
      baseUrl,
      docsUrl: rawProvider.doc,
      npm: rawProvider.npm,
      requiredEnvVars: Array.isArray(rawProvider.env)
        ? rawProvider.env.filter(
            (name: unknown): name is string => typeof name === 'string',
          )
        : [],
      models,
    };
  });
}

function safeNonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export async function getProvider(id: string): Promise<AiProvider | undefined> {
  const providers = await getProviders();
  return providers.find((p) => p.id === id);
}

export async function getModel(
  providerId: string,
  modelId: string,
): Promise<AiModel | undefined> {
  const provider = await getProvider(providerId);
  return provider?.models.find((m) => m.id === modelId);
}

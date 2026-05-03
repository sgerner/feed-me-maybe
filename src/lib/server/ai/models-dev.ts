import { type AiProvider, type AiModel } from './types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

let cache: { data: any; timestamp: number } | null = null;

async function fetchModelsDev() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch models.dev: ${response.statusText}`);
  }

  const data = await response.json();
  cache = { data, timestamp: Date.now() };
  return data;
}

export async function getProviders(): Promise<AiProvider[]> {
  const data = await fetchModelsDev();
  
  return Object.entries(data).map(([id, provider]: [string, any]) => {
    const models: AiModel[] = Object.entries(provider.models || {}).map(([modelId, model]: [string, any]) => ({
      id: modelId,
      name: model.name || modelId,
      family: model.family,
      contextWindow: model.limit?.context || 0,
      inputPrice: model.cost?.input || 0,
      outputPrice: model.cost?.output || 0,
      reasoning: model.reasoning,
      toolCall: model.tool_call,
      structuredOutput: model.structured_output
    }));

    return {
      id,
      name: provider.name || id,
      description: provider.description || '',
      baseUrl: provider.api || '',
      docsUrl: provider.doc,
      npm: provider.npm,
      requiredEnvVars: provider.env || [],
      models
    };
  });
}

export async function getProvider(id: string): Promise<AiProvider | undefined> {
  const providers = await getProviders();
  return providers.find(p => p.id === id);
}

export async function getModel(providerId: string, modelId: string): Promise<AiModel | undefined> {
  const provider = await getProvider(providerId);
  return provider?.models.find(m => m.id === modelId);
}

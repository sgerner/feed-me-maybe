import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const providers = [
  { id: 'openai', name: 'OpenAI', description: 'GPT-4 and GPT-3.5 models', baseUrl: 'https://api.openai.com/v1', docsUrl: 'https://platform.openai.com/docs', requiredEnvVars: ['OPENAI_API_KEY'], models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, inputPrice: 2.5, outputPrice: 10 }, { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, inputPrice: 0.15, outputPrice: 0.6 }, { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextWindow: 16385, inputPrice: 0.5, outputPrice: 1.5 }] },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', baseUrl: 'https://api.anthropic.com/v1', docsUrl: 'https://docs.anthropic.com', requiredEnvVars: ['ANTHROPIC_API_KEY'], models: [{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000, inputPrice: 3, outputPrice: 15 }, { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000, inputPrice: 0.8, outputPrice: 4 }] },
  { id: 'openrouter', name: 'OpenRouter', description: 'Multi-provider access', baseUrl: 'https://openrouter.ai/api/v1', docsUrl: 'https://openrouter.ai/docs', requiredEnvVars: ['OPENROUTER_API_KEY'], models: [{ id: 'openai/gpt-4o', name: 'GPT-4o (OpenRouter)', contextWindow: 128000, inputPrice: 2.5, outputPrice: 10 }, { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (OpenRouter)', contextWindow: 200000, inputPrice: 3, outputPrice: 15 }, { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', contextWindow: 1048576, inputPrice: 0.1, outputPrice: 0.4 }] },
  { id: 'groq', name: 'Groq', description: 'Fast inference cloud', baseUrl: 'https://api.groq.com/openai/v1', docsUrl: 'https://console.groq.com/docs', requiredEnvVars: ['GROQ_API_KEY'], models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 32768, inputPrice: 0.59, outputPrice: 0.79 }, { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, inputPrice: 0.24, outputPrice: 0.24 }] }
];

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  return json({ providers });
};

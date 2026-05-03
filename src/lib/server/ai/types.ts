export interface AiProvider {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  docsUrl?: string;
  requiredEnvVars: string[];
  models: AiModel[];
}

export interface AiModel {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice: number; // per million tokens
  outputPrice: number;
}

export interface ArticleScore {
  summary: string;
  topics: string[];
  entities: string[];
  contentType: string;
  relevanceScore: number;
  noveltyScore: number;
  qualityScore: number;
  likelyUserInterest: string;
  positiveSignals: string[];
  negativeSignals: string[];
  explanation: string;
}

export interface MemoryUpdate {
  addPositivePreferences: string[];
  addNegativePreferences: string[];
  strengthenExisting: string[];
  weakenExisting: string[];
  notes: string;
}
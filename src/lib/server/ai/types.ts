export interface AiProvider {
  id: string;
  name: string;
  description?: string;
  baseUrl: string;
  docsUrl?: string;
  requiredEnvVars: string[];
  models: AiModel[];
  npm?: string;
}

export interface AiModel {
  id: string;
  name: string;
  family?: string;
  contextWindow: number;
  inputPrice: number; // per million tokens
  outputPrice: number;
  reasoning?: boolean;
  toolCall?: boolean;
  structuredOutput?: boolean;
}

export interface ArticleAnalysisInput {
  title: string;
  summary?: string;
  content?: string;
  author?: string;
  publishedAge?: string;
  categories?: string[];
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
  signals: string[];
  explanation: string;
}

export interface MemoryUpdate {
  addPositivePreferences: string[];
  addNegativePreferences: string[];
  strengthenExisting: string[];
  weakenExisting: string[];
  notes: string;
}

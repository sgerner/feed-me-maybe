export const CLASSIFICATION_PROMPT = `Classify the following article. Return a JSON object with:
- "topics": array of topic strings
- "contentType": one of "news", "tutorial", "opinion", "release_note", "essay", "podcast", "video", "other"
- "entities": array of named entities found
- "summary": 2-3 sentence summary`;

export const SCORING_PROMPT = `Score this article for relevance. Return JSON:
- "relevanceScore": 0.0 to 1.0
- "noveltyScore": 0.0 to 1.0
- "qualityScore": 0.0 to 1.0
- "likelyUserInterest": "high", "medium", or "low"
- "explanation": brief reason for the score`;

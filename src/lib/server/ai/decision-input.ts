/**
 * Full-information cleanup is used by the active ranking scorer. Compact,
 * minimal, and packed variants remain opt-in inputs for offline evaluation.
 */

export type DecisionState = {
  reader_profile: Record<string, unknown>;
  candidate: Record<string, unknown>;
  [key: string]: unknown;
};

const SENTENCE_ABBREVIATIONS = new Set([
  'approx',
  'assoc',
  'capt',
  'ch',
  'cmdr',
  'co',
  'col',
  'corp',
  'dept',
  'dr',
  'e.g',
  'eq',
  'fig',
  'figs',
  'gen',
  'gov',
  'hon',
  'i.e',
  'inc',
  'jr',
  'maj',
  'mr',
  'mrs',
  'ms',
  'no',
  'nos',
  'pres',
  'prof',
  'rep',
  'rev',
  'sen',
  'sr',
  'st',
  'univ',
  'vol',
  'vs',
]);

function isSentenceBoundary(
  value: string,
  index: number,
  start: number,
): boolean {
  const character = value[index];
  if (character === '!' || character === '?') return true;
  if (character !== '.') return false;

  const isDecimalPoint =
    /\d/.test(value[index - 1] || '') && /\d/.test(value[index + 1] || '');
  if (isDecimalPoint) return false;

  const prefix = value.slice(start, index + 1).trimEnd();
  const trailingToken = prefix.match(/([\p{L}.]+\.)$/u)?.[1];
  if (trailingToken) {
    const abbreviation = trailingToken.slice(0, -1).toLowerCase();
    if (
      SENTENCE_ABBREVIATIONS.has(abbreviation) ||
      /^(?:\p{L}\.){1,5}$/u.test(trailingToken)
    ) {
      return false;
    }
  }
  return true;
}

/** Keep punctuation and whitespace in each surviving sentence unchanged. */
function splitPreservingSentences(value: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (!isSentenceBoundary(value, index, start)) continue;

    let end = index + 1;
    while (/["'’”»)}\]]/u.test(value[end] || '')) end += 1;
    while (/\s/u.test(value[end] || '')) end += 1;
    sentences.push(value.slice(start, end));
    start = end;
    index = end - 1;
  }

  if (start < value.length) sentences.push(value.slice(start));
  return sentences;
}

function exactSentenceKey(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function removeExactRepeatedSentences(
  summary: string,
  excerpt: string,
): string {
  const summaryKeys = new Set(
    splitPreservingSentences(summary)
      .map((sentence) => {
        const key = exactSentenceKey(sentence);
        return key;
      })
      .filter(Boolean),
  );
  const sentences = splitPreservingSentences(excerpt);
  const kept = sentences.filter((sentence) => {
    const key = exactSentenceKey(sentence);
    if (!key) return true;
    return !summaryKeys.has(key);
  });
  return kept.length === sentences.length ? excerpt : kept.join('');
}

function omitEmptyFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) omitEmptyFields(item);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (
      item === null ||
      (typeof item === 'string' && item.trim().length === 0) ||
      (Array.isArray(item) && item.length === 0)
    ) {
      delete record[key];
    } else {
      omitEmptyFields(item);
    }
  }
}

/**
 * Remove only structurally empty fields and full excerpt sentences already
 * represented in the summary. This preserves text bounds and all profile and
 * candidate facts; unlike the experimental variants, it does not clip or pack.
 */
export function buildSafeDecisionInput(state: DecisionState): DecisionState {
  const safe = cloneValue(state);
  omitEmptyFields(safe);

  if (
    typeof safe.candidate.summary === 'string' &&
    typeof safe.candidate.content_excerpt === 'string'
  ) {
    const excerpt = removeExactRepeatedSentences(
      safe.candidate.summary,
      safe.candidate.content_excerpt,
    );
    if (excerpt.trim().length === 0) delete safe.candidate.content_excerpt;
    else safe.candidate.content_excerpt = excerpt;
  }

  return safe;
}

export type DecisionInputVariants = {
  full: DecisionState;
  compact: DecisionState;
  minimal: DecisionState;
};

export type PackedPreferenceTuple = [
  type: string,
  value: string,
  strength: number,
  evidence_count: number,
];
export type PackedSourceTuple = [source: string, interactions: number];

export type DecisionQuestion = {
  type: 'noul';
  instructions: string;
  criteria: {
    true: string;
    false: string;
  };
};

/** The current Jev question plus two narrow signals for evaluation. */
export const JEV_DECISION_QUESTIONS = {
  would_open: {
    type: 'noul',
    instructions:
      'Would this reader choose to open this candidate article next? Judge personalized reading relevance, not generic quality. Do not reward title keyword overlap alone. A high value means the article is likely worth opening in this feed today.',
    criteria: {
      true: 'The candidate is a strong match for this reader and is likely worth opening next.',
      false:
        'The candidate is not a strong match for this reader, even if it is generally well written or newsworthy.',
    },
  },
  evidence_quality: {
    type: 'noul',
    instructions:
      'Does the candidate provide specific, attributable, and useful evidence for its main claims? Judge the evidence present in the article, not the importance of its topic or the confidence of its writing.',
    criteria: {
      true: 'The article gives concrete, attributable details or evidence that support its main claims.',
      false:
        'The article relies mainly on vague assertions, unsupported claims, or lacks enough detail to assess its main claims.',
    },
  },
  hype_speculation: {
    type: 'noul',
    instructions:
      'Is this candidate substantially driven by sensational hype, unsupported certainty, or speculation presented as likely fact? Judge the article text and signals, not merely an exciting subject.',
    criteria: {
      true: 'The framing relies substantially on hype, weakly supported predictions, or speculation presented with undue certainty.',
      false:
        'The article is mainly measured and distinguishes evidence from uncertainty or speculation.',
    },
  },
} as const satisfies Record<string, DecisionQuestion>;

const COMPACT = {
  title: 200,
  author: 80,
  source: 90,
  source_category: 60,
  summary: 700,
  content_excerpt: 600,
  content_type: 40,
  metadataText: 100,
  semanticItems: 8,
  positivePreferences: 10,
  preferredSources: 5,
} as const;

const MINIMAL = {
  title: 160,
  author: 60,
  source: 70,
  source_category: 40,
  summary: 300,
  content_type: 32,
  metadataText: 80,
  semanticItems: 4,
  positivePreferences: 5,
  preferredSources: 3,
} as const;

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function clippedText(value: unknown, maxLength: number): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 0) return '';
  const contentLimit = maxLength - 1;
  const cut = text.slice(0, contentLimit);
  const wordBoundary = cut.lastIndexOf(' ');
  const head = cut
    .slice(0, wordBoundary > contentLimit * 0.75 ? wordBoundary : contentLimit)
    .trimEnd();
  return `${head}…`;
}

function normalizeEvidenceUnit(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitEvidenceUnits(value: string): string[] {
  const units: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    const isDecimalPoint =
      character === '.' &&
      /\d/.test(value[index - 1] || '') &&
      /\d/.test(next || '');
    const isBoundary =
      character === ';' ||
      character === ':' ||
      character === '!' ||
      character === '?' ||
      (character === '.' && !isDecimalPoint);
    if (!isBoundary) continue;
    units.push(value.slice(start, index + 1).trim());
    start = index + 1;
  }
  const remainder = value.slice(start).trim();
  if (remainder) units.push(remainder);
  return units;
}

/** Remove only exact normalized sentence or clause repetitions. */
function removeRepeatedExcerpt(summary: string, excerpt: string): string {
  const summaryUnits = new Set(
    splitEvidenceUnits(summary).map(normalizeEvidenceUnit).filter(Boolean),
  );
  return splitEvidenceUnits(excerpt)
    .filter((unit) => !summaryUnits.has(normalizeEvidenceUnit(unit)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactList(
  value: unknown,
  limit: number,
  textLimit: number,
): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .slice(0, limit)
    .map((item) =>
      typeof item === 'string'
        ? clippedText(item, textLimit)
        : cloneValue(item),
    );
}

function compactPreferenceList(
  value: unknown,
  limit: number,
  preserveAll = false,
): unknown {
  if (!Array.isArray(value)) return value;
  return (preserveAll ? value : value.slice(0, limit)).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return cloneValue(item);
    }
    const preference = cloneValue(item as Record<string, unknown>);
    if ('type' in preference)
      preference.type = clippedText(preference.type, 40);
    if ('value' in preference)
      preference.value = clippedText(preference.value, 120);
    return preference;
  });
}

function compactSourceList(
  value: unknown,
  limit: number,
  preserveAll = false,
): unknown {
  if (!Array.isArray(value)) return value;
  return (preserveAll ? value : value.slice(0, limit)).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return cloneValue(item);
    }
    const source = cloneValue(item as Record<string, unknown>);
    if ('source' in source) source.source = clippedText(source.source, 100);
    return source;
  });
}

function makeVariant(
  state: DecisionState,
  limits: typeof COMPACT | typeof MINIMAL,
  minimal: boolean,
): DecisionState {
  const result = cloneValue(state);
  const profile = result.reader_profile;
  const candidate = result.candidate;

  profile.positive_preferences = compactPreferenceList(
    profile.positive_preferences,
    limits.positivePreferences,
  );
  // Preserve every negative preference so a short payload cannot erase an
  // explicit dislike. buildState already bounds this list to fourteen entries.
  profile.negative_preferences = compactPreferenceList(
    profile.negative_preferences,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  profile.preferred_sources = compactSourceList(
    profile.preferred_sources,
    limits.preferredSources,
  );
  // Avoided sources are negative feedback and are retained in every variant.
  profile.avoided_sources = compactSourceList(
    profile.avoided_sources,
    Number.MAX_SAFE_INTEGER,
    true,
  );

  candidate.title = clippedText(candidate.title, limits.title);
  candidate.author = clippedText(candidate.author, limits.author);
  candidate.source = clippedText(candidate.source, limits.source);
  candidate.source_category = clippedText(
    candidate.source_category,
    limits.source_category,
  );
  candidate.summary = clippedText(candidate.summary, limits.summary);
  candidate.content_type = clippedText(
    candidate.content_type,
    limits.content_type,
  );
  candidate.categories = compactList(
    candidate.categories,
    limits.semanticItems,
    limits.metadataText,
  );
  candidate.topics = compactList(
    candidate.topics,
    limits.semanticItems,
    limits.metadataText,
  );
  candidate.entities = compactList(
    candidate.entities,
    limits.semanticItems,
    limits.metadataText,
  );
  candidate.signals = compactList(
    candidate.signals,
    limits.semanticItems,
    limits.metadataText,
  );

  if (minimal) {
    delete candidate.content_excerpt;
  } else if (typeof candidate.content_excerpt === 'string') {
    const summary =
      typeof candidate.summary === 'string' ? candidate.summary : '';
    const excerpt = removeRepeatedExcerpt(summary, candidate.content_excerpt);
    const excerptLimit =
      'content_excerpt' in limits ? limits.content_excerpt : 0;
    candidate.content_excerpt = excerpt
      ? clippedText(excerpt, excerptLimit)
      : '';
  }

  return result;
}

/** Build comparable full, compact, and minimal Jev states without mutating input. */
export function buildDecisionInputVariants(
  state: DecisionState,
): DecisionInputVariants {
  return {
    full: cloneValue(state),
    compact: makeVariant(state, COMPACT, false),
    minimal: makeVariant(state, MINIMAL, true),
  };
}

/** JSON character count, useful as a tokenizer-independent input-cost proxy. */
export function decisionInputJsonLength(state: DecisionState): number {
  return JSON.stringify(state).length;
}

function packTuples<T extends readonly string[]>(
  values: unknown,
  fields: T,
): unknown {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return cloneValue(value);
    }
    const record = value as Record<string, unknown>;
    return fields.map((field) => record[field]);
  });
}

function omitEmptyCandidateFields(candidate: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(candidate)) {
    if (
      value === null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0)
    ) {
      delete candidate[key];
    }
  }
}

/**
 * Pack the compact state without dropping any of its surviving profile data.
 * Preference/source schemas appear once, while each row contains only tuples.
 */
export function buildPackedDecisionInput(state: DecisionState): DecisionState {
  const packed = makeVariant(state, COMPACT, false);
  const profile = packed.reader_profile;
  const preferenceFields = [
    'type',
    'value',
    'strength',
    'evidence_count',
  ] as const;
  const sourceFields = ['source', 'interactions'] as const;

  profile.preference_fields = [...preferenceFields];
  profile.positive_preferences = packTuples(
    profile.positive_preferences,
    preferenceFields,
  );
  profile.negative_preferences = packTuples(
    profile.negative_preferences,
    preferenceFields,
  );
  profile.source_fields = [...sourceFields];
  profile.preferred_sources = packTuples(
    profile.preferred_sources,
    sourceFields,
  );
  profile.avoided_sources = packTuples(profile.avoided_sources, sourceFields);
  omitEmptyCandidateFields(packed.candidate);
  return packed;
}

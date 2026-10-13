import type { DecisionState } from './decision-input';

export type PreferenceInputTransformOptions = {
  stripTypePrefix?: boolean;
  roundStrength?: boolean;
  omitEvidenceCount?: boolean;
  positivePreferenceLimit?: number;
};

export const PREFERENCE_INPUT_VARIANT_NAMES = [
  'prefix_stripped',
  'prefix_stripped_round2',
  'prefix_stripped_no_evidence_count',
  'prefix_top12',
  'prefix_top10',
] as const;

export type PreferenceInputVariantName =
  (typeof PREFERENCE_INPUT_VARIANT_NAMES)[number];

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function roundedStrength(value: unknown): unknown {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) < 0.01
  ) {
    return value;
  }

  return Number(value.toFixed(2));
}

function transformRows(
  value: unknown,
  options: PreferenceInputTransformOptions,
): unknown {
  if (!Array.isArray(value)) return cloneValue(value);

  return value.map((row) => {
    if (!isRecord(row)) return cloneValue(row);
    const transformed = cloneValue(row);

    if (
      options.stripTypePrefix &&
      typeof transformed.type === 'string' &&
      typeof transformed.value === 'string'
    ) {
      const prefix = `${transformed.type}:`;
      if (
        transformed.value.startsWith(prefix) &&
        transformed.value.length > prefix.length
      ) {
        transformed.value = transformed.value.slice(prefix.length);
      }
    }

    if (options.roundStrength && 'strength' in transformed) {
      transformed.strength = roundedStrength(transformed.strength);
    }

    if (options.omitEvidenceCount) delete transformed.evidence_count;
    return transformed;
  });
}

/**
 * Clone a full decision state and apply only the requested preference-row
 * reductions. Candidate data, preference ordering, and unselected profile
 * fields are preserved.
 */
export function transformPreferenceInput(
  state: DecisionState,
  options: PreferenceInputTransformOptions,
): DecisionState {
  const transformed = cloneValue(state);
  const profile = transformed.reader_profile;

  if ('positive_preferences' in profile) {
    const positives = transformRows(profile.positive_preferences, options);
    profile.positive_preferences =
      typeof options.positivePreferenceLimit === 'number' &&
      Array.isArray(positives)
        ? positives.slice(
            0,
            Math.max(0, Math.floor(options.positivePreferenceLimit)),
          )
        : positives;
  }

  if ('negative_preferences' in profile) {
    profile.negative_preferences = transformRows(
      profile.negative_preferences,
      options,
    );
  }

  return transformed;
}

/** Build named, opt-in preference variants from the current safe full state. */
export function buildNamedPreferenceInputVariants(
  state: DecisionState,
): Record<PreferenceInputVariantName, DecisionState> {
  return {
    prefix_stripped: transformPreferenceInput(state, {
      stripTypePrefix: true,
    }),
    prefix_stripped_round2: transformPreferenceInput(state, {
      stripTypePrefix: true,
      roundStrength: true,
    }),
    prefix_stripped_no_evidence_count: transformPreferenceInput(state, {
      stripTypePrefix: true,
      omitEvidenceCount: true,
    }),
    prefix_top12: transformPreferenceInput(state, {
      stripTypePrefix: true,
      positivePreferenceLimit: 12,
    }),
    prefix_top10: transformPreferenceInput(state, {
      stripTypePrefix: true,
      positivePreferenceLimit: 10,
    }),
  };
}

/** Preserve every preference and evidence count; round only ordinary strengths. */
export function buildRankingPreferenceInput(
  state: DecisionState,
): DecisionState {
  return transformPreferenceInput(state, {
    stripTypePrefix: true,
    roundStrength: true,
  });
}

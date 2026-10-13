import { describe, expect, it } from 'vitest';
import {
  buildDecisionInputVariants,
  buildPackedDecisionInput,
  decisionInputJsonLength,
  JEV_DECISION_QUESTIONS,
  type DecisionState,
} from './decision-input';

function unpackRows(rows: unknown, fields: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows) || !Array.isArray(fields)) {
    throw new Error('Expected packed rows and field schema arrays');
  }
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error('Expected tuple row');
    return Object.fromEntries(
      fields.map((field, index) => [String(field), row[index]]),
    );
  });
}

function makeState(): DecisionState {
  return {
    reader_profile: {
      positive_preferences: Array.from({ length: 14 }, (_, index) => ({
        type: 'topic',
        value: `preferred topic ${index}`,
        strength: 0.9,
        evidence_count: 4,
      })),
      negative_preferences: [
        {
          type: 'topic',
          value: 'crypto hype',
          strength: 0.98,
          evidence_count: 11,
        },
        {
          type: 'source',
          value: 'rumor mill',
          strength: 0.91,
          evidence_count: 6,
        },
      ],
      preferred_sources: Array.from({ length: 5 }, (_, index) => ({
        source: `Preferred Source ${index}`,
        interactions: 10 - index,
      })),
      avoided_sources: [{ source: 'Avoided Gazette', interactions: 8 }],
    },
    candidate: {
      title: `A useful article title ${'title '.repeat(40)}`,
      author: `Example Author ${'name '.repeat(20)}`,
      source: `Example Feed ${'feed '.repeat(20)}`,
      source_category: `Technology ${'category '.repeat(12)}`,
      summary:
        'The team published measured battery test results across several devices and explained the limits of the comparison. '.repeat(
          8,
        ),
      content_excerpt:
        'The team published measured battery test results across several devices and explained the limits of the comparison. '.repeat(
          3,
        ) +
        'Separately, the report includes the full lab protocol, sample sizes, and temperature readings for each device.',
      categories: ['technology', 'hardware', 'research', 'mobile', 'testing'],
      topics: ['battery life', 'device testing', 'measurement methods'],
      entities: ['Example Labs', 'Device A', 'Device B'],
      content_type: 'analysis',
      signals: ['primary source', 'measured results'],
      age_hours: 2.4,
    },
  };
}

describe('experimental Jev decision inputs', () => {
  it('returns a full current-shaped copy and smaller bounded compact and minimal variants', () => {
    const state = makeState();
    const variants = buildDecisionInputVariants(state);

    expect(variants.full).toEqual(state);
    expect(variants.full).not.toBe(state);
    expect(decisionInputJsonLength(variants.compact)).toBeLessThan(
      decisionInputJsonLength(variants.full),
    );
    expect(decisionInputJsonLength(variants.minimal)).toBeLessThan(
      decisionInputJsonLength(variants.compact),
    );

    expect(
      (variants.compact.candidate.title as string).length,
    ).toBeLessThanOrEqual(200);
    expect(
      (variants.compact.candidate.summary as string).length,
    ).toBeLessThanOrEqual(700);
    expect(
      (variants.compact.candidate.content_excerpt as string).length,
    ).toBeLessThanOrEqual(600);
    expect(variants.compact.reader_profile.positive_preferences).toHaveLength(
      10,
    );
    expect(variants.compact.reader_profile.preferred_sources).toHaveLength(5);
    expect(variants.minimal.reader_profile.positive_preferences).toHaveLength(
      5,
    );
    expect(variants.minimal.reader_profile.preferred_sources).toHaveLength(3);
    expect(variants.minimal.candidate).not.toHaveProperty('content_excerpt');
    expect(
      (variants.minimal.candidate.title as string).length,
    ).toBeLessThanOrEqual(160);
    expect(
      (variants.minimal.candidate.summary as string).length,
    ).toBeLessThanOrEqual(300);
    expect(variants.minimal.candidate.categories).toHaveLength(4);
    expect(
      (variants.minimal.candidate.categories as string[]).every(
        (item) => item.length <= 80,
      ),
    ).toBe(true);
  });

  it('does not mutate input and preserves negative preferences, avoided sources, and distinct evidence', () => {
    const state = makeState();
    const original = structuredClone(state);
    const variants = buildDecisionInputVariants(state);

    expect(state).toEqual(original);
    for (const variant of Object.values(variants)) {
      expect(variant.reader_profile.negative_preferences).toEqual(
        state.reader_profile.negative_preferences,
      );
      expect(variant.reader_profile.avoided_sources).toEqual(
        state.reader_profile.avoided_sources,
      );
    }
    expect(variants.compact.candidate.content_excerpt).toContain(
      'full lab protocol',
    );
    expect(variants.compact.candidate.content_excerpt).not.toContain(
      'The team published measured battery test results',
    );
    expect(variants.compact.candidate.topics).toEqual(state.candidate.topics);
    expect(variants.minimal.candidate.topics).toEqual(state.candidate.topics);
  });

  it('keeps contradictory excerpt wording and new numerical facts', () => {
    const contradiction = makeState();
    contradiction.candidate.summary =
      'Study showed benefit for patients receiving the new treatment.';
    contradiction.candidate.content_excerpt =
      'Study did not show benefit for patients receiving the new treatment.';

    const contradictionExcerpt =
      buildDecisionInputVariants(contradiction).compact.candidate
        .content_excerpt;
    expect(contradictionExcerpt).toBe(
      'Study did not show benefit for patients receiving the new treatment.',
    );

    const numerical = makeState();
    numerical.candidate.summary = 'Study showed benefit.';
    numerical.candidate.content_excerpt =
      'Study showed benefit; 2,400 participants completed follow-up in 2024.';

    expect(
      buildDecisionInputVariants(numerical).compact.candidate.content_excerpt,
    ).toBe('2,400 participants completed follow-up in 2024.');

    numerical.candidate.summary = 'Results rose by 2.4%.';
    numerical.candidate.content_excerpt = 'Results rose by 2.1%.';
    expect(
      buildDecisionInputVariants(numerical).compact.candidate.content_excerpt,
    ).toBe('Results rose by 2.1%.');
  });

  it('counts the ellipsis inside the configured text bound', () => {
    const state = makeState();
    state.candidate.title = 'x'.repeat(500);

    const variants = buildDecisionInputVariants(state);
    expect(variants.compact.candidate.title).toHaveLength(200);
    expect(variants.compact.candidate.title).toMatch(/…$/);
    expect(variants.minimal.candidate.title).toHaveLength(160);
    expect(variants.minimal.candidate.title).toMatch(/…$/);
  });

  it('packs compact preferences and sources with schemas and reconstructs the same information', () => {
    const state = makeState();
    const compact = buildDecisionInputVariants(state).compact;
    const packed = buildPackedDecisionInput(state);
    const profile = packed.reader_profile;

    expect(profile.preference_fields).toEqual([
      'type',
      'value',
      'strength',
      'evidence_count',
    ]);
    expect(profile.source_fields).toEqual(['source', 'interactions']);
    expect(
      unpackRows(profile.positive_preferences, profile.preference_fields),
    ).toEqual(compact.reader_profile.positive_preferences);
    expect(
      unpackRows(profile.negative_preferences, profile.preference_fields),
    ).toEqual(compact.reader_profile.negative_preferences);
    expect(
      unpackRows(profile.preferred_sources, profile.source_fields),
    ).toEqual(compact.reader_profile.preferred_sources);
    expect(unpackRows(profile.avoided_sources, profile.source_fields)).toEqual(
      compact.reader_profile.avoided_sources,
    );
    expect(profile.negative_preferences).toHaveLength(
      (compact.reader_profile.negative_preferences as unknown[]).length,
    );
    expect(decisionInputJsonLength(packed)).toBeLessThan(
      decisionInputJsonLength(compact),
    );
  });

  it('omits only empty candidate fields and does not mutate source state', () => {
    const state = makeState();
    state.candidate.summary = '';
    state.candidate.categories = [];
    state.candidate.entities = null;
    state.candidate.content_type = '  ';
    state.candidate.age_hours = 0;
    const original = structuredClone(state);

    const packed = buildPackedDecisionInput(state);
    expect(state).toEqual(original);
    expect(packed.candidate).not.toHaveProperty('summary');
    expect(packed.candidate).not.toHaveProperty('categories');
    expect(packed.candidate).not.toHaveProperty('entities');
    expect(packed.candidate).not.toHaveProperty('content_type');
    expect(packed.candidate.age_hours).toBe(0);
    expect(packed.candidate.title).toBeTruthy();
  });

  it('exports personalized match, evidence, and hype questions with the live would_open wording', () => {
    expect(Object.keys(JEV_DECISION_QUESTIONS)).toEqual([
      'would_open',
      'evidence_quality',
      'hype_speculation',
    ]);
    expect(JEV_DECISION_QUESTIONS.would_open).toEqual({
      type: 'noul',
      instructions:
        'Would this reader choose to open this candidate article next? Judge personalized reading relevance, not generic quality. Do not reward title keyword overlap alone. A high value means the article is likely worth opening in this feed today.',
      criteria: {
        true: 'The candidate is a strong match for this reader and is likely worth opening next.',
        false:
          'The candidate is not a strong match for this reader, even if it is generally well written or newsworthy.',
      },
    });
  });
});

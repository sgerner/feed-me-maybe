import { describe, expect, it } from 'vitest';
import {
  buildRankingPreferenceInput,
  buildNamedPreferenceInputVariants,
  transformPreferenceInput,
} from './preference-input';
import type { DecisionState } from './decision-input';

function state(): DecisionState {
  return {
    reader_profile: {
      positive_preferences: Array.from({ length: 14 }, (_, i) => ({
        type: 'topic',
        value: `topic:interest-${i}`,
        strength: i === 13 ? 0.003 : 0.837,
        evidence_count: 40 - i,
      })),
      negative_preferences: [
        {
          type: 'phrase',
          value: 'phrase:avoid',
          strength: 0.999,
          evidence_count: 20,
        },
      ],
      avoided_sources: [{ source: 'Disliked source', interactions: 100 }],
    },
    candidate: {
      title: 'Complete title',
      summary: 'Exact summary with 12.5% and a negation: not improved.',
      content_excerpt: 'Every original paragraph remains.',
      topics: ['AI', 'Research'],
      age_hours: 0,
    },
  };
}

describe('preference input experiments', () => {
  it('keeps article facts, preference order, weights and counts while removing only duplicated typed prefixes', () => {
    const input = state();
    const before = structuredClone(input);
    const output = transformPreferenceInput(input, { stripTypePrefix: true });
    expect(input).toEqual(before);
    expect(output.candidate).toEqual(input.candidate);
    const prefs = output.reader_profile.positive_preferences as Record<
      string,
      unknown
    >[];
    expect(prefs).toHaveLength(14);
    expect(prefs[0]).toEqual({
      type: 'topic',
      value: 'interest-0',
      strength: 0.837,
      evidence_count: 40,
    });
    expect(output.reader_profile.negative_preferences).toEqual([
      { type: 'phrase', value: 'avoid', strength: 0.999, evidence_count: 20 },
    ]);
    expect(output.reader_profile.avoided_sources).toEqual(
      input.reader_profile.avoided_sources,
    );
  });

  it('preserves mismatched, embedded and empty-value prefixes', () => {
    const input = state();
    input.reader_profile.positive_preferences = [
      { type: 'topic', value: 'entity:AI' },
      { type: 'topic', value: 'Discuss topic:AI' },
      { type: 'topic', value: 'topic:' },
    ];
    expect(
      transformPreferenceInput(input, { stripTypePrefix: true }).reader_profile
        .positive_preferences,
    ).toEqual(input.reader_profile.positive_preferences);
  });

  it('never drops dislikes or article text when limiting weak positive entries', () => {
    const input = state();
    const output = buildNamedPreferenceInputVariants(input).prefix_top12;
    expect(output.reader_profile.positive_preferences).toHaveLength(12);
    expect(output.reader_profile.negative_preferences).toHaveLength(1);
    expect(output.reader_profile.avoided_sources).toEqual(
      input.reader_profile.avoided_sources,
    );
    expect(output.candidate).toEqual(input.candidate);
    expect(input.reader_profile.positive_preferences).toHaveLength(14);
  });

  it('keeps nonzero preferences in rounding and keeps every preference when omitting evidence counts', () => {
    const variants = buildNamedPreferenceInputVariants(state());
    const rounded = variants.prefix_stripped_round2.reader_profile
      .positive_preferences as Record<string, unknown>[];
    expect(rounded[13].strength).toBe(0.003);
    expect(rounded[0].strength).toBe(0.84);
    const withoutCounts = variants.prefix_stripped_no_evidence_count
      .reader_profile.positive_preferences as Record<string, unknown>[];
    expect(withoutCounts).toHaveLength(14);
    expect(withoutCounts[0].strength).toBe(0.837);
    expect(withoutCounts[0]).not.toHaveProperty('evidence_count');
  });

  it('bounds production precision changes while retaining all preferences and their evidence', () => {
    const input = state();
    const output = buildRankingPreferenceInput(input);
    for (const key of ['positive_preferences', 'negative_preferences']) {
      const oldRows = input.reader_profile[key] as Record<string, unknown>[];
      const newRows = output.reader_profile[key] as Record<string, unknown>[];
      expect(newRows).toHaveLength(oldRows.length);
      newRows.forEach((row, i) => {
        expect(row.evidence_count).toBe(oldRows[i].evidence_count);
        expect(
          Math.abs(Number(row.strength) - Number(oldRows[i].strength)),
        ).toBeLessThanOrEqual(0.005000001);
      });
    }
    expect(output.candidate).toEqual(input.candidate);
    expect(output.reader_profile.avoided_sources).toEqual(
      input.reader_profile.avoided_sources,
    );
  });
});

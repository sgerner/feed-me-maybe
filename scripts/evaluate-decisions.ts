/**
 * Offline, resumable comparison of Jev and SubQ decision scores.
 *
 * Run with Node's built-in TypeScript stripping (Node >=22.12):
 *   node --experimental-strip-types scripts/evaluate-decisions.ts cohort.json results.jsonl --limit 40
 *   node --experimental-strip-types scripts/evaluate-decisions.ts --summarize results.jsonl
 *
 * This script only reads API keys from SUBQ_API_KEY_FILE and JEV_API_KEY_FILE.
 * Calls are sequential and results are appended after each response.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildDecisionInputVariants,
  JEV_DECISION_QUESTIONS,
  type DecisionState,
} from '../src/lib/server/ai/decision-input.ts';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const SUBQ_ENDPOINT = 'https://api.subq.ai/v1/systemone';
const SUBQ_MODEL = 'subq-snap-preview';
const FORMAT_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;

type Label = 0 | 1 | null;
type Provider = 'jev' | 'subq';
type VariantName = 'full' | 'compact' | 'minimal';
type QuestionSet = 'would_open' | 'narrow_multiquestion';
type Baseline = {
  jevScore: number | null;
  heuristic: number | null;
  aiComposite: number | null;
};
type CohortRow = {
  id: string;
  label: Label;
  state: DecisionState;
  baseline: Baseline;
};
type Cohort = { provenance: unknown; rows: CohortRow[] };
type Config = {
  provider: Provider;
  variant: VariantName;
  questionSet: QuestionSet;
  model: string;
  endpoint: string;
};
type CallRecord = {
  recordType: 'call';
  formatVersion: number;
  cohortHash: string;
  experimentHash: string;
  callKey: string;
  rowId: string;
  label: Label;
  baseline: Baseline;
  provider: Provider;
  model: string;
  resolvedModel: string | null;
  endpoint: string;
  variant: VariantName;
  questionSet: QuestionSet;
  questionNames: string[];
  status: 'ok' | 'error';
  recordedAt: string;
  latencyMs: number;
  serializedBytes: number;
  variantJsonBytes: Record<VariantName, number>;
  usageTokens: Record<string, number> | null;
  scores: Record<string, number | null>;
  error?: { name: string; message: string };
};
type JsonRecord = Record<string, unknown>;

const QUESTION_SETS = {
  would_open: {
    would_open: JEV_DECISION_QUESTIONS.would_open,
  },
  narrow_multiquestion: {
    would_open: JEV_DECISION_QUESTIONS.would_open,
    evidence_quality: JEV_DECISION_QUESTIONS.evidence_quality,
    hype_speculation: JEV_DECISION_QUESTIONS.hype_speculation,
  },
} as const;

const CONFIGS: Config[] = [
  {
    provider: 'jev',
    variant: 'full',
    questionSet: 'would_open',
    model: JEV_MODEL,
    endpoint: JEV_ENDPOINT,
  },
  {
    provider: 'jev',
    variant: 'compact',
    questionSet: 'would_open',
    model: JEV_MODEL,
    endpoint: JEV_ENDPOINT,
  },
  {
    provider: 'jev',
    variant: 'minimal',
    questionSet: 'would_open',
    model: JEV_MODEL,
    endpoint: JEV_ENDPOINT,
  },
  {
    provider: 'subq',
    variant: 'full',
    questionSet: 'would_open',
    model: SUBQ_MODEL,
    endpoint: SUBQ_ENDPOINT,
  },
  {
    provider: 'subq',
    variant: 'compact',
    questionSet: 'would_open',
    model: SUBQ_MODEL,
    endpoint: SUBQ_ENDPOINT,
  },
  {
    provider: 'subq',
    variant: 'minimal',
    questionSet: 'would_open',
    model: SUBQ_MODEL,
    endpoint: SUBQ_ENDPOINT,
  },
  {
    provider: 'subq',
    variant: 'compact',
    questionSet: 'narrow_multiquestion',
    model: SUBQ_MODEL,
    endpoint: SUBQ_ENDPOINT,
  },
];

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function numericOrNull(value: unknown, field: string): number | null {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a finite number or null`);
  }
  return number;
}

function readCohort(path: string): { cohort: Cohort; hash: string } {
  const source = readFileSync(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Input is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isObject(value) || !Array.isArray(value.rows)) {
    throw new Error('Input must be an object with provenance and a rows array');
  }

  const ids = new Set<string>();
  const rows = value.rows.map((raw, index): CohortRow => {
    if (!isObject(raw)) throw new Error(`rows[${index}] must be an object`);
    const id = String(raw.id ?? '').trim();
    if (!id) throw new Error(`rows[${index}].id must be non-empty`);
    if (ids.has(id)) throw new Error(`Duplicate row id: ${id}`);
    ids.add(id);
    if (raw.label !== null && raw.label !== 0 && raw.label !== 1) {
      throw new Error(`rows[${index}].label must be 0, 1, or null`);
    }
    if (
      !isObject(raw.state) ||
      !isObject(raw.state.reader_profile) ||
      !isObject(raw.state.candidate)
    ) {
      throw new Error(
        `rows[${index}].state must contain reader_profile and candidate objects`,
      );
    }
    if (!isObject(raw.baseline)) {
      throw new Error(`rows[${index}].baseline must be an object`);
    }
    return {
      id,
      label: raw.label,
      state: raw.state as DecisionState,
      baseline: {
        jevScore: numericOrNull(
          raw.baseline.jevScore,
          `rows[${index}].baseline.jevScore`,
        ),
        heuristic: numericOrNull(
          raw.baseline.heuristic,
          `rows[${index}].baseline.heuristic`,
        ),
        aiComposite: numericOrNull(
          raw.baseline.aiComposite,
          `rows[${index}].baseline.aiComposite`,
        ),
      },
    };
  });

  return {
    cohort: { provenance: value.provenance ?? null, rows },
    hash: createHash('sha256').update(source).digest('hex'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readKeyFromFile(
  envName: 'JEV_API_KEY_FILE' | 'SUBQ_API_KEY_FILE',
): string {
  const path = process.env[envName]?.trim();
  if (!path)
    throw new Error(`${envName} must point to a file containing the API key`);
  const key = readFileSync(path, 'utf8').trim();
  if (!key) throw new Error(`${envName} points to an empty API key file`);
  return key;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function makeCallKey(
  cohortHash: string,
  rowId: string,
  config: Config,
): string {
  return sha256(
    JSON.stringify([
      cohortHash,
      EXPERIMENT_HASH,
      rowId,
      config.provider,
      config.variant,
      config.questionSet,
      config.model,
    ]),
  );
}

const EXPERIMENT_METADATA = {
  formatVersion: FORMAT_VERSION,
  configurations: CONFIGS.map((config) => ({
    ...config,
    questions: QUESTION_SETS[config.questionSet],
  })),
  decisionInputSourceSha256: createHash('sha256')
    .update(
      readFileSync(
        new URL('../src/lib/server/ai/decision-input.ts', import.meta.url),
      ),
    )
    .digest('hex'),
  scoreRange: [0, 1],
  narrowBlend: {
    formula:
      '0.8 * would_open + 0.1 * evidence_quality + 0.1 * (1 - hype_speculation)',
    status: 'untuned exploratory proxy',
  },
  baselineScales: {
    heuristic:
      '0..100 in frozen cohort; divided by 100 for probability metrics',
  },
} as const;
const EXPERIMENT_HASH = sha256(JSON.stringify(EXPERIMENT_METADATA));

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const records: JsonRecord[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) records.push(parsed);
    } catch (error) {
      throw new Error(
        `Invalid JSONL at ${path}:${index + 1}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  });
  return records;
}

function appendJsonl(path: string, record: JsonRecord): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function questionNames(questionSet: QuestionSet): string[] {
  return Object.keys(QUESTION_SETS[questionSet]);
}

function responseScores(
  data: unknown,
  names: string[],
): Record<string, number | null> {
  const scores: Record<string, number | null> = {};
  const answers = isObject(data) && isObject(data.answers) ? data.answers : {};
  for (const name of names) {
    const answer = isObject(answers[name]) ? answers[name] : {};
    const value = answer.noul;
    const number =
      value == null ||
      (typeof value !== 'number' &&
        (typeof value !== 'string' || !value.trim()))
        ? Number.NaN
        : Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`API response has no usable ${name}.noul score`);
    }
    if (number < 0 || number > 1) {
      throw new Error(`API response ${name}.noul must be between 0 and 1`);
    }
    scores[name] = number;
  }
  return scores;
}

function responseUsageTokens(data: unknown): Record<string, number> | null {
  if (!isObject(data) || !isObject(data.usage)) return null;
  const tokens: Record<string, number> = {};
  for (const [key, value] of Object.entries(data.usage)) {
    if (!/token/i.test(key)) continue;
    if (
      typeof value !== 'number' &&
      (typeof value !== 'string' || !value.trim())
    )
      continue;
    const number = Number(value);
    if (Number.isFinite(number)) tokens[key] = number;
  }
  return Object.keys(tokens).length ? tokens : null;
}

async function callApi(
  row: CohortRow,
  state: DecisionState,
  cohortHash: string,
  variants: Record<VariantName, DecisionState>,
  config: Config,
  apiKey: string,
): Promise<CallRecord> {
  const names = questionNames(config.questionSet);
  const body = JSON.stringify({
    state,
    model: config.model,
    questions: QUESTION_SETS[config.questionSet],
  });
  const serializedBytes = Buffer.byteLength(body, 'utf8');
  const startedAt = Date.now();
  const common = {
    recordType: 'call' as const,
    formatVersion: FORMAT_VERSION,
    cohortHash,
    experimentHash: EXPERIMENT_HASH,
    callKey: makeCallKey(cohortHash, row.id, config),
    rowId: row.id,
    label: row.label,
    baseline: row.baseline,
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint,
    variant: config.variant,
    questionSet: config.questionSet,
    questionNames: names,
    recordedAt: new Date().toISOString(),
    serializedBytes,
    variantJsonBytes: {
      full: jsonBytes(variants.full),
      compact: jsonBytes(variants.compact),
      minimal: jsonBytes(variants.minimal),
    },
  };
  let usageTokens: Record<string, number> | null = null;
  let resolvedModel: string | null = null;

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const detail = responseText.replace(/\s+/g, ' ').trim().slice(0, 400);
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        'API returned a successful response that was not valid JSON',
      );
    }
    usageTokens = responseUsageTokens(data);
    resolvedModel =
      isObject(data) && typeof data.model === 'string' ? data.model : null;
    return {
      ...common,
      status: 'ok',
      resolvedModel,
      latencyMs: Date.now() - startedAt,
      usageTokens,
      scores: responseScores(data, names),
    };
  } catch (error) {
    return {
      ...common,
      status: 'error',
      resolvedModel,
      latencyMs: Date.now() - startedAt,
      usageTokens,
      scores: Object.fromEntries(names.map((name) => [name, null])),
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: errorMessage(error).replace(/\s+/g, ' ').slice(0, 500),
      },
    };
  }
}

function countExistingSuccesses(
  records: JsonRecord[],
  cohortHash: string,
): Set<string> {
  return new Set(
    records
      .filter(
        (record) =>
          record.recordType === 'call' &&
          record.cohortHash === cohortHash &&
          record.experimentHash === EXPERIMENT_HASH &&
          record.status === 'ok' &&
          typeof record.callKey === 'string',
      )
      .map((record) => String(record.callKey)),
  );
}

function finiteScore(value: unknown): number | null {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

type MetricRow = { label: 0 | 1; score: number };

function binaryMetrics(rows: Array<{ label: Label; score: number | null }>) {
  const labeled = rows.filter(
    (row): row is { label: 0 | 1; score: number | null } => row.label !== null,
  );
  const valid = labeled.filter(
    (row): row is MetricRow => row.score !== null && Number.isFinite(row.score),
  );
  const positives = valid.filter((row) => row.label === 1);
  const negatives = valid.filter((row) => row.label === 0);

  let auc: number | null = null;
  if (positives.length && negatives.length) {
    const ascending = [...valid].sort((a, b) => a.score - b.score);
    let rank = 1;
    let positiveRankSum = 0;
    for (let index = 0; index < ascending.length;) {
      let end = index + 1;
      while (
        end < ascending.length &&
        ascending[end].score === ascending[index].score
      )
        end += 1;
      const averageRank = (rank + (rank + end - index - 1)) / 2;
      for (let tied = index; tied < end; tied += 1) {
        if (ascending[tied].label === 1) positiveRankSum += averageRank;
      }
      rank += end - index;
      index = end;
    }
    auc =
      (positiveRankSum - (positives.length * (positives.length + 1)) / 2) /
      (positives.length * negatives.length);
  }

  const brier = valid.length
    ? valid.reduce((sum, row) => sum + (row.score - row.label) ** 2, 0) /
      valid.length
    : null;

  const k = Math.min(10, valid.length);
  let positiveMass = 0;
  if (k > 0) {
    const descending = [...valid].sort((a, b) => b.score - a.score);
    let selected = 0;
    for (let index = 0; index < descending.length && selected < k;) {
      let end = index + 1;
      while (
        end < descending.length &&
        descending[end].score === descending[index].score
      )
        end += 1;
      const slots = Math.min(end - index, k - selected);
      const tieFraction = slots / (end - index);
      const positivesInTie = descending
        .slice(index, end)
        .filter((row) => row.label === 1).length;
      positiveMass += positivesInTie * tieFraction;
      selected += slots;
      index = end;
    }
  }

  return {
    labeledRows: labeled.length,
    scoredRows: valid.length,
    missingPredictions: labeled.length - valid.length,
    unlabeledRows: rows.length - labeled.length,
    positives: positives.length,
    negatives: negatives.length,
    auc,
    brier,
    topK: {
      k,
      precision: k ? positiveMass / k : null,
      recall: positives.length ? positiveMass / positives.length : null,
      positiveMass: k ? positiveMass : null,
      tiePolicy: 'fractional inclusion for scores tied across the cutoff',
    },
  };
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function summarize(
  records: JsonRecord[],
  cohortHash?: string,
  provenance?: unknown,
) {
  const runs = records.filter((record) => record.recordType === 'run');
  const latestRun = [...runs]
    .reverse()
    .find((record) => !cohortHash || record.cohortHash === cohortHash);
  const selectedHash =
    cohortHash ??
    (typeof latestRun?.cohortHash === 'string'
      ? latestRun.cohortHash
      : undefined);
  const selectedExperimentHash =
    typeof latestRun?.experimentHash === 'string'
      ? latestRun.experimentHash
      : undefined;
  const calls = records.filter(
    (record) =>
      record.recordType === 'call' &&
      (!selectedHash || record.cohortHash === selectedHash) &&
      (!selectedExperimentHash ||
        record.experimentHash === selectedExperimentHash),
  );

  const rowMap = new Map<
    string,
    {
      label: Label;
      baseline: Baseline;
      predictions: Record<string, number | null>;
      signals: Record<string, number | null>;
    }
  >();
  const latestSuccessful = new Map<string, JsonRecord>();
  for (const call of calls) {
    const rowId = String(call.rowId ?? '');
    if (!rowId) continue;
    const baselineRecord = isObject(call.baseline) ? call.baseline : {};
    const existing = rowMap.get(rowId);
    const row = existing ?? {
      label: call.label === 0 || call.label === 1 ? call.label : null,
      baseline: {
        jevScore: finiteScore(baselineRecord.jevScore),
        heuristic: finiteScore(baselineRecord.heuristic),
        aiComposite: finiteScore(baselineRecord.aiComposite),
      },
      predictions: {},
      signals: {},
    };
    rowMap.set(rowId, row);
    if (call.status === 'ok' && typeof call.callKey === 'string') {
      latestSuccessful.set(call.callKey, call);
    }
  }

  for (const call of latestSuccessful.values()) {
    const row = rowMap.get(String(call.rowId));
    if (!row || !isObject(call.scores)) continue;
    const scores = call.scores;
    if (call.questionSet === 'would_open') {
      const system = `${call.provider}_${call.variant}`;
      row.predictions[system] = finiteScore(scores.would_open);
    } else if (call.questionSet === 'narrow_multiquestion') {
      row.signals.would_open = finiteScore(scores.would_open);
      row.signals.evidence_quality = finiteScore(scores.evidence_quality);
      row.signals.hype_speculation = finiteScore(scores.hype_speculation);
    }
  }

  const rows = [...rowMap.values()];
  const completeRowCount = rows.filter(
    (row) =>
      row.predictions.jev_full != null &&
      row.predictions.jev_compact != null &&
      row.predictions.jev_minimal != null &&
      row.predictions.subq_full != null &&
      row.predictions.subq_compact != null &&
      row.predictions.subq_minimal != null &&
      row.signals.would_open != null &&
      row.signals.evidence_quality != null &&
      row.signals.hype_speculation != null,
  ).length;
  const predictors: Record<
    string,
    Array<{ label: Label; score: number | null }>
  > = {
    baseline_jev: rows.map((row) => ({
      label: row.label,
      score: row.baseline.jevScore,
    })),
    baseline_heuristic: rows.map((row) => ({
      label: row.label,
      score:
        row.baseline.heuristic === null ? null : row.baseline.heuristic / 100,
    })),
    baseline_aiComposite: rows.map((row) => ({
      label: row.label,
      score: row.baseline.aiComposite,
    })),
    jev_full: rows.map((row) => ({
      label: row.label,
      score: row.predictions.jev_full ?? null,
    })),
    jev_compact: rows.map((row) => ({
      label: row.label,
      score: row.predictions.jev_compact ?? null,
    })),
    jev_minimal: rows.map((row) => ({
      label: row.label,
      score: row.predictions.jev_minimal ?? null,
    })),
    subq_full: rows.map((row) => ({
      label: row.label,
      score: row.predictions.subq_full ?? null,
    })),
    subq_compact: rows.map((row) => ({
      label: row.label,
      score: row.predictions.subq_compact ?? null,
    })),
    subq_minimal: rows.map((row) => ({
      label: row.label,
      score: row.predictions.subq_minimal ?? null,
    })),
    subq_compact_narrow_would_open: rows.map((row) => ({
      label: row.label,
      score: row.signals.would_open ?? null,
    })),
    subq_compact_narrow_blend: rows.map((row) => {
      const wouldOpen = row.signals.would_open;
      const evidence = row.signals.evidence_quality;
      const hype = row.signals.hype_speculation;
      const score =
        wouldOpen === undefined ||
        wouldOpen === null ||
        evidence === undefined ||
        evidence === null ||
        hype === undefined ||
        hype === null
          ? null
          : 0.8 * wouldOpen + 0.1 * evidence + 0.1 * (1 - hype);
      return { label: row.label, score };
    }),
    subq_compact_single_open_with_narrow_blend: rows.map((row) => {
      const wouldOpen = row.predictions.subq_compact;
      const evidence = row.signals.evidence_quality;
      const hype = row.signals.hype_speculation;
      const score =
        wouldOpen === undefined ||
        wouldOpen === null ||
        evidence === undefined ||
        evidence === null ||
        hype === undefined ||
        hype === null
          ? null
          : 0.8 * wouldOpen + 0.1 * evidence + 0.1 * (1 - hype);
      return { label: row.label, score };
    }),
  };

  const groupedStats = new Map<string, JsonRecord[]>();
  for (const record of calls) {
    const key = `${record.provider}_${record.variant}_${record.questionSet}`;
    const group = groupedStats.get(key) ?? [];
    group.push(record);
    groupedStats.set(key, group);
  }
  const callStats: Record<string, unknown> = {};
  for (const [key, group] of groupedStats) {
    const usageTotals: Record<string, number> = {};
    for (const record of group) {
      if (!isObject(record.usageTokens)) continue;
      for (const [tokenName, count] of Object.entries(record.usageTokens)) {
        if (typeof count === 'number' && Number.isFinite(count)) {
          usageTotals[tokenName] = (usageTotals[tokenName] ?? 0) + count;
        }
      }
    }
    callStats[key] = {
      calls: group.length,
      succeeded: group.filter((record) => record.status === 'ok').length,
      failed: group.filter((record) => record.status === 'error').length,
      usageAvailable: group.filter((record) => isObject(record.usageTokens))
        .length,
      usageMissing: group.filter((record) => !isObject(record.usageTokens))
        .length,
      meanLatencyMs: mean(
        group.map((record) => Number(record.latencyMs)).filter(Number.isFinite),
      ),
      requestBytes: group.reduce(
        (sum, record) => sum + (Number(record.serializedBytes) || 0),
        0,
      ),
      actualUsageTokenTotals: usageTotals,
      resolvedModels: [
        ...new Set(
          group
            .map((record) => record.resolvedModel)
            .filter((value) => typeof value === 'string'),
        ),
      ],
    };
  }

  const signalSummary: Record<string, unknown> = {};
  for (const signal of ['would_open', 'evidence_quality', 'hype_speculation']) {
    const values = rows
      .map((row) => row.signals[signal])
      .filter(
        (value): value is number => value !== null && Number.isFinite(value),
      );
    signalSummary[signal] = { scoredRows: values.length, mean: mean(values) };
  }

  return {
    formatVersion: FORMAT_VERSION,
    cohortHash: selectedHash ?? null,
    experimentHash: selectedExperimentHash ?? null,
    cohortProvenance: provenance ?? latestRun?.provenance ?? null,
    rowsRequested:
      typeof latestRun?.rowCount === 'number' ? latestRun.rowCount : null,
    rowsInOutput: rows.length,
    rowsWithAllSevenCalls: completeRowCount,
    labeledRows: rows.filter((row) => row.label !== null).length,
    metrics: Object.fromEntries(
      Object.entries(predictors).map(([name, scores]) => [
        name,
        binaryMetrics(scores),
      ]),
    ),
    scoreScaling: {
      baseline_heuristic:
        'stored 0..100 value divided by 100 before probability metrics',
      API_noul_scores: 'validated to be within 0..1',
    },
    narrowSignalMeans: signalSummary,
    exploratoryBlend: {
      formula:
        '0.8 * SubQ compact multiquestion would_open + 0.1 * evidence_quality + 0.1 * (1 - hype_speculation)',
      singleQuestionBlend:
        'subq_compact_single_open_with_narrow_blend uses the separate one-question would_open score in the same formula',
      wouldOpenForBlend:
        'the would_open score returned by the same three-question request',
      status:
        'untuned exploratory proxy; narrow signals are not established relevance labels',
      comparison:
        'subq_compact_narrow_would_open can be compared with subq_compact to measure output shift when asking all three questions',
    },
    callStats,
    interpretation:
      'Metrics use only explicitly labeled rows; null labels are excluded and missing scores are omitted per predictor. AUC gives score ties half credit. Top-10 precision and recall use fractional inclusion when a score tie crosses the cutoff. Baseline values are stored scores and may not be clean historical predictions. These are proxy metrics: weak labels weaken the result, and observational agreement is noncausal.',
  };
}

function parseArgs(args: string[]) {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    return { help: true as const };
  }
  if (args[0] === '--summarize') {
    const path = args[1];
    if (!path || path.startsWith('--'))
      throw new Error('--summarize requires a JSONL path');
    return { help: false as const, summarizePath: path };
  }

  const positionals: string[] = [];
  let limit: number | null = null;
  let selectedVariants: VariantName[] | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--limit') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1)
        throw new Error('--limit must be a positive integer');
      limit = value;
    } else if (arg === '--variants') {
      const values = (args[++index] || '').split(',');
      if (
        !values.length ||
        values.some((value) => !['full', 'compact', 'minimal'].includes(value))
      )
        throw new Error(
          '--variants must be a comma-separated list of full,compact,minimal',
        );
      selectedVariants = values as VariantName[];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 2)
    throw new Error('Expected INPUT.json OUTPUT.jsonl [--limit N]');
  return {
    help: false as const,
    inputPath: positionals[0],
    outputPath: positionals[1],
    limit,
    selectedVariants,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  node --experimental-strip-types scripts/evaluate-decisions.ts INPUT.json OUTPUT.jsonl [--limit N] [--variants full,compact,minimal]',
      '  node --experimental-strip-types scripts/evaluate-decisions.ts --summarize OUTPUT.jsonl',
      '',
      'Set JEV_API_KEY_FILE and SUBQ_API_KEY_FILE to files containing provider keys.',
      'The runner appends one JSONL record per API call and resumes successful calls.',
    ].join('\n') + '\n',
  );
}

async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return;
  }
  if ('summarizePath' in parsed && typeof parsed.summarizePath === 'string') {
    const records = readJsonl(parsed.summarizePath);
    process.stdout.write(`${JSON.stringify(summarize(records), null, 2)}\n`);
    return;
  }

  const inputPath = resolve(parsed.inputPath);
  const outputPath = resolve(parsed.outputPath);
  const { cohort, hash: cohortHash } = readCohort(inputPath);
  const rows = parsed.limit ? cohort.rows.slice(0, parsed.limit) : cohort.rows;
  const keys = {
    jev: readKeyFromFile('JEV_API_KEY_FILE'),
    subq: readKeyFromFile('SUBQ_API_KEY_FILE'),
  };
  const existing = readJsonl(outputPath);
  const completed = countExistingSuccesses(existing, cohortHash);
  const variants = new Map(
    rows.map((row) => [row.id, buildDecisionInputVariants(row.state)]),
  );

  appendJsonl(outputPath, {
    recordType: 'run',
    formatVersion: FORMAT_VERSION,
    cohortHash,
    experimentHash: EXPERIMENT_HASH,
    experimentMetadata: EXPERIMENT_METADATA,
    startedAt: new Date().toISOString(),
    inputPath,
    rowCount: rows.length,
    selectedVariants: parsed.selectedVariants,
    totalCohortRows: cohort.rows.length,
    provenance: cohort.provenance,
  });

  let failedThisRun = 0;
  let consecutiveFailures = 0;
  let fatalApiError: string | null = null;
  rowsLoop: for (const row of rows) {
    const built = variants.get(row.id)!;
    for (const config of CONFIGS) {
      if (
        parsed.selectedVariants &&
        !parsed.selectedVariants.includes(config.variant)
      )
        continue;
      const callKey = makeCallKey(cohortHash, row.id, config);
      if (completed.has(callKey)) continue;
      const record = await callApi(
        row,
        built[config.variant],
        cohortHash,
        built,
        config,
        keys[config.provider],
      );
      appendJsonl(outputPath, record as unknown as JsonRecord);
      if (record.status === 'ok') {
        completed.add(callKey);
        consecutiveFailures = 0;
      } else {
        failedThisRun += 1;
        consecutiveFailures += 1;
      }
      process.stdout.write(
        `${record.status.toUpperCase()} ${record.provider}/${record.variant}/${record.questionSet} row=${record.rowId} ${record.latencyMs}ms ${record.serializedBytes} bytes${record.error ? `: ${record.error.message}` : ''}\n`,
      );
      const statusMatch = record.error?.message.match(/^HTTP (\d{3})\b/);
      const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
      if (
        httpStatus !== null &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        httpStatus !== 408 &&
        httpStatus !== 429
      ) {
        fatalApiError = `${record.provider} returned HTTP ${httpStatus}; stopped before making further calls`;
        break rowsLoop;
      }
      if (consecutiveFailures >= 3) {
        fatalApiError =
          'Three consecutive API calls failed; stopped before making further calls';
        break rowsLoop;
      }
    }
  }

  const allRecords = readJsonl(outputPath);
  process.stdout.write(
    `${JSON.stringify(summarize(allRecords, cohortHash, cohort.provenance), null, 2)}\n`,
  );
  if (fatalApiError) throw new Error(fatalApiError);
  if (failedThisRun > 0) {
    throw new Error(
      `${failedThisRun} API call(s) failed and were recorded; fix the cause and rerun to resume`,
    );
  }
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`evaluate-decisions: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

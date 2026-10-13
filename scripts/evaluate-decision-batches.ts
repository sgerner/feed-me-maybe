/**
 * Compare Jev and SubQ scores when several candidates share one reader profile.
 * The input is a transformed cohort (each row's state has the compact_packed
 * reader_profile and candidate). Calls are grouped by exact profile hash and
 * appended to JSONL so successful batches can be resumed.
 *
 * Run with Node's built-in TypeScript stripping (Node >=22.12):
 *   node --experimental-strip-types scripts/evaluate-decision-batches.ts cohort.json batches.jsonl --batch-size 4
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { JEV_DECISION_QUESTIONS } from '../src/lib/server/ai/decision-input.ts';

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const SUBQ_ENDPOINT = 'https://api.subq.ai/v1/systemone';
const SUBQ_MODEL = 'subq-snap-preview';
const FORMAT_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const PROVIDERS = [
  {
    provider: 'jev',
    model: JEV_MODEL,
    endpoint: JEV_ENDPOINT,
    keyFileEnv: 'JEV_API_KEY_FILE',
  },
  {
    provider: 'subq',
    model: SUBQ_MODEL,
    endpoint: SUBQ_ENDPOINT,
    keyFileEnv: 'SUBQ_API_KEY_FILE',
  },
] as const;

type Provider = (typeof PROVIDERS)[number]['provider'];
type Label = 0 | 1 | null;
type JsonRecord = Record<string, unknown>;
type InputRow = {
  id: string;
  label: Label;
  baseline: JsonRecord | null;
  state: {
    reader_profile: JsonRecord;
    candidate: JsonRecord;
  };
};
type ProfileGroup = {
  profileHash: string;
  readerProfile: JsonRecord;
  rows: InputRow[];
};
type ProviderConfig = (typeof PROVIDERS)[number];
type BatchRowScore = {
  rowId: string;
  label: Label;
  candidateKey: string;
  would_open_noul: number | null;
  baseline: JsonRecord | null;
};
type BatchRecord = {
  recordType: 'batch';
  formatVersion: number;
  cohortHash: string;
  experimentHash: string;
  profileHash: string;
  requestHash: string;
  callKey: string;
  profileGroupIndex: number;
  batchIndex: number;
  batchSize: number;
  rowIds: string[];
  provider: Provider;
  model: string;
  resolvedModel: string | null;
  endpoint: string;
  status: 'ok' | 'error';
  recordedAt: string;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number | null;
  usageTokens: Record<string, number> | null;
  rows: BatchRowScore[];
  error?: { name: string; message: string; status?: number };
};

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readCohort(path: string): {
  rows: InputRow[];
  hash: string;
} {
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
    throw new Error('Input must be an object with a rows array');
  }

  const ids = new Set<string>();
  const rows = value.rows.map((raw, index): InputRow => {
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
    return {
      id,
      label: raw.label,
      baseline: isObject(raw.baseline) ? raw.baseline : null,
      state: {
        reader_profile: raw.state.reader_profile,
        candidate: raw.state.candidate,
      },
    };
  });
  return { rows, hash: sha256(source) };
}

function groupByProfile(rows: InputRow[]): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const row of rows) {
    const profileHash = sha256(stableJson(row.state.reader_profile));
    const group = groups.get(profileHash) ?? {
      profileHash,
      readerProfile: row.state.reader_profile,
      rows: [],
    };
    group.rows.push(row);
    groups.set(profileHash, group);
  }
  return [...groups.values()];
}

function readKeyFromFile(
  envName: 'JEV_API_KEY_FILE' | 'SUBQ_API_KEY_FILE',
): string {
  const path = process.env[envName]?.trim();
  if (!path) {
    throw new Error(`${envName} must point to a file containing the API key`);
  }
  const key = readFileSync(path, 'utf8').trim();
  if (!key) throw new Error(`${envName} points to an empty API key file`);
  return key;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function batchQuestions(candidateKeys: string[]): JsonRecord {
  return Object.fromEntries(
    candidateKeys.map((candidateKey) => [
      `would_open_${candidateKey}`,
      {
        ...JEV_DECISION_QUESTIONS.would_open,
        instructions: `${JEV_DECISION_QUESTIONS.would_open.instructions} Evaluate candidate ${candidateKey} in state.candidates; treat other candidates only as context.`,
      },
    ]),
  );
}

function makeRequest(group: ProfileGroup, rows: InputRow[], model: string) {
  const candidates: Record<string, JsonRecord> = {};
  const candidateKeys = rows.map((_, index) => `c${index}`);
  rows.forEach((row, index) => {
    candidates[candidateKeys[index]] = row.state.candidate;
  });
  const body = {
    state: {
      reader_profile: group.readerProfile,
      candidates,
    },
    model,
    questions: batchQuestions(candidateKeys),
  };
  return { body, candidateKeys, serialized: JSON.stringify(body) };
}

function responseUsageTokens(data: unknown): Record<string, number> | null {
  if (!isObject(data) || !isObject(data.usage)) return null;
  const tokens: Record<string, number> = {};
  for (const [key, value] of Object.entries(data.usage)) {
    if (!/token/i.test(key)) continue;
    if (
      typeof value !== 'number' &&
      (typeof value !== 'string' || !value.trim())
    ) {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) tokens[key] = number;
  }
  return Object.keys(tokens).length ? tokens : null;
}

function blankRows(rows: InputRow[], candidateKeys: string[]): BatchRowScore[] {
  return rows.map((row, index) => ({
    rowId: row.id,
    label: row.label,
    candidateKey: candidateKeys[index],
    would_open_noul: null,
    baseline: row.baseline,
  }));
}

function fillScores(
  data: unknown,
  candidateKeys: string[],
  scores: BatchRowScore[],
): void {
  const answers = isObject(data) && isObject(data.answers) ? data.answers : {};
  const missing: string[] = [];
  for (let index = 0; index < candidateKeys.length; index += 1) {
    const answerName = `would_open_${candidateKeys[index]}`;
    const answer = isObject(answers[answerName]) ? answers[answerName] : {};
    const value = answer.noul;
    const number =
      value == null ||
      (typeof value !== 'number' &&
        (typeof value !== 'string' || !value.trim()))
        ? Number.NaN
        : Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
      missing.push(answerName);
      continue;
    }
    scores[index].would_open_noul = number;
  }
  if (missing.length) {
    throw new Error(
      `API response has no usable score for ${missing.join(', ')}`,
    );
  }
}

function safeMessage(error: unknown, apiKey: string): string {
  return errorMessage(error)
    .replaceAll(apiKey, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  const records: JsonRecord[] = [];
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
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

function completedBatchKeys(
  records: JsonRecord[],
  cohortHash: string,
): Set<string> {
  return new Set(
    records
      .filter(
        (record) =>
          record.recordType === 'batch' &&
          record.cohortHash === cohortHash &&
          record.experimentHash === EXPERIMENT_HASH &&
          record.status === 'ok' &&
          typeof record.callKey === 'string',
      )
      .map((record) => String(record.callKey)),
  );
}

async function callBatch(
  group: ProfileGroup,
  rows: InputRow[],
  candidateKeys: string[],
  serializedBody: string,
  cohortHash: string,
  experimentHash: string,
  callKey: string,
  profileGroupIndex: number,
  batchIndex: number,
  batchSize: number,
  config: ProviderConfig,
  apiKey: string,
): Promise<BatchRecord> {
  const startedAt = Date.now();
  const record: BatchRecord = {
    recordType: 'batch',
    formatVersion: FORMAT_VERSION,
    cohortHash,
    experimentHash,
    profileHash: group.profileHash,
    requestHash: sha256(serializedBody),
    callKey,
    profileGroupIndex,
    batchIndex,
    batchSize,
    rowIds: rows.map((row) => row.id),
    provider: config.provider,
    model: config.model,
    resolvedModel: null,
    endpoint: config.endpoint,
    status: 'error',
    recordedAt: new Date().toISOString(),
    latencyMs: 0,
    requestBytes: Buffer.byteLength(serializedBody, 'utf8'),
    responseBytes: null,
    usageTokens: null,
    rows: blankRows(rows, candidateKeys),
  };

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: serializedBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await response.text();
    record.responseBytes = Buffer.byteLength(responseText, 'utf8');
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      Object.assign(error, { status: response.status });
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        'API returned a successful response that was not valid JSON',
      );
    }
    record.usageTokens = responseUsageTokens(data);
    record.resolvedModel =
      isObject(data) && typeof data.model === 'string' ? data.model : null;
    fillScores(data, candidateKeys, record.rows);
    record.status = 'ok';
  } catch (error) {
    const status =
      isObject(error) && typeof error.status === 'number'
        ? error.status
        : undefined;
    record.error = {
      name: error instanceof Error ? error.name : 'Error',
      message: safeMessage(error, apiKey),
      ...(status === undefined ? {} : { status }),
    };
  }
  record.latencyMs = Date.now() - startedAt;
  return record;
}

function parseArgs(args: string[]) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { help: true as const };
  }
  const positionals: string[] = [];
  let batchSize: 4 | 8 = 4;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const inlineBatchSize = argument.match(/^--batch-size=(\d+)$/);
    if (argument === '--batch-size' || inlineBatchSize) {
      const value = Number(
        inlineBatchSize ? inlineBatchSize[1] : args[++index],
      );
      if (value !== 4 && value !== 8) {
        throw new Error('--batch-size must be 4 or 8');
      }
      batchSize = value;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 2) {
    throw new Error('Expected INPUT.json OUTPUT.jsonl [--batch-size 4|8]');
  }
  return {
    help: false as const,
    inputPath: positionals[0],
    outputPath: positionals[1],
    batchSize,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  node --experimental-strip-types scripts/evaluate-decision-batches.ts INPUT.json OUTPUT.jsonl [--batch-size 4|8]',
      '',
      'The input rows must contain transformed compact_packed reader profiles and candidates.',
      'Rows are grouped by reader-profile hash; a request never mixes profile groups.',
      'Set JEV_API_KEY_FILE and SUBQ_API_KEY_FILE to files containing provider keys.',
      'Successful batches are recorded to JSONL and skipped on resume.',
    ].join('\n') + '\n',
  );
}

const EXPERIMENT_HASH = sha256(
  stableJson({
    formatVersion: FORMAT_VERSION,
    models: PROVIDERS.map(({ provider, model, endpoint }) => ({
      provider,
      model,
      endpoint,
    })),
    baseQuestion: JEV_DECISION_QUESTIONS.would_open,
    batchInstructions:
      'Evaluate candidate {candidateKey} in state.candidates; treat other candidates only as context.',
    input: 'compact_packed rows grouped by stable reader_profile hash',
  }),
);

async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    printHelp();
    return;
  }

  const inputPath = resolve(parsed.inputPath);
  const outputPath = resolve(parsed.outputPath);
  const { rows, hash: cohortHash } = readCohort(inputPath);
  const profileGroups = groupByProfile(rows);
  const keys = {
    jev: readKeyFromFile('JEV_API_KEY_FILE'),
    subq: readKeyFromFile('SUBQ_API_KEY_FILE'),
  };
  const existing = readJsonl(outputPath);
  const completed = completedBatchKeys(existing, cohortHash);
  appendJsonl(outputPath, {
    recordType: 'run',
    formatVersion: FORMAT_VERSION,
    cohortHash,
    experimentHash: EXPERIMENT_HASH,
    startedAt: new Date().toISOString(),
    batchSize: parsed.batchSize,
    providers: PROVIDERS.map(({ provider, model, endpoint }) => ({
      provider,
      model,
      endpoint,
    })),
    rowCount: rows.length,
    profileGroupCount: profileGroups.length,
  });

  let failures = 0;
  let fatalError: string | null = null;
  groupsLoop: for (
    let groupIndex = 0;
    groupIndex < profileGroups.length;
    groupIndex += 1
  ) {
    const group = profileGroups[groupIndex];
    for (
      let offset = 0, batchIndex = 0;
      offset < group.rows.length;
      offset += parsed.batchSize, batchIndex += 1
    ) {
      const batchRows = group.rows.slice(offset, offset + parsed.batchSize);
      for (const config of PROVIDERS) {
        const { body, candidateKeys } = makeRequest(
          group,
          batchRows,
          config.model,
        );
        const serialized = JSON.stringify(body);
        const requestHash = sha256(serialized);
        const callKey = sha256(
          stableJson([
            cohortHash,
            EXPERIMENT_HASH,
            group.profileHash,
            batchRows.map((row) => row.id),
            parsed.batchSize,
            config.provider,
            config.model,
            requestHash,
          ]),
        );
        if (completed.has(callKey)) continue;

        const record = await callBatch(
          group,
          batchRows,
          candidateKeys,
          serialized,
          cohortHash,
          EXPERIMENT_HASH,
          callKey,
          groupIndex,
          batchIndex,
          parsed.batchSize,
          config,
          keys[config.provider],
        );
        appendJsonl(outputPath, record as unknown as JsonRecord);
        const summary = `${record.status.toUpperCase()} ${record.provider} group=${groupIndex} batch=${batchIndex} rows=${batchRows.length} ${record.latencyMs}ms ${record.requestBytes} bytes`;
        process.stdout.write(
          `${summary}${record.error ? `: ${record.error.message}` : ''}\n`,
        );
        if (record.status === 'ok') {
          completed.add(callKey);
          continue;
        }

        failures += 1;
        const status = record.error?.status;
        if (status === 401 || status === 403) {
          fatalError = `${record.provider} authentication failed with HTTP ${status}; stopped before further calls`;
          break groupsLoop;
        }
        if (
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429
        ) {
          fatalError = `${record.provider} returned HTTP ${status}; stopped before further calls`;
          break groupsLoop;
        }
      }
    }
  }

  process.stdout.write(
    `Recorded ${failures} failed batch call(s); rerun to resume missing successful batches.\n`,
  );
  if (fatalError) throw new Error(fatalError);
  if (failures)
    throw new Error(`${failures} batch call(s) failed and were recorded`);
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`evaluate-decision-batches: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

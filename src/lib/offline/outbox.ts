import {
  getAllRecords,
  getMetaValue,
  normalizeOfflineScope,
  putMetaValue,
  replaceRecords,
} from './db';
import { mutationDedupeKey } from './state';
import {
  OFFLINE_CACHE_VERSION,
  OUTBOX_PROCESSING_LEASE_MS,
  OUTBOX_RETRY_BASE_MS,
  OUTBOX_RETRY_MAX_MS,
  type OfflineMutation,
  type OfflineMutationState,
  type OfflineMutationType,
  type OfflineReplayResult,
  type OfflineSyncStatus,
} from './types';
import { activateOfflineUser, applyMutationToCachedArticle } from './store';

export interface ReplayResponse {
  ok: boolean;
  status: number;
  error?: string;
}

export interface ReplayBatchOptions {
  now?: number;
  maxMutations?: number;
  processingLeaseMs?: number;
}

export interface ReplayBatchResult {
  updated: OfflineMutation[];
  removedIds: string[];
  synced: number;
  retried: number;
  blocked: number;
  conflicts: number;
  stopped: boolean;
  lastError: string | null;
}

function compareMutationOrder(a: OfflineMutation, b: OfflineMutation): number {
  return (
    a.sequence - b.sequence ||
    a.queuedAt - b.queuedAt ||
    a.id.localeCompare(b.id)
  );
}

export function orderMutations(
  mutations: OfflineMutation[],
): OfflineMutation[] {
  return [...mutations].sort(compareMutationOrder);
}

export function calculateRetryDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(9, attempt - 1));
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** exponent, OUTBOX_RETRY_MAX_MS);
}

export function coalesceMutations(
  mutations: OfflineMutation[],
): OfflineMutation[] {
  const latestByKey = new Map<string, OfflineMutation>();
  for (const mutation of orderMutations(mutations)) {
    latestByKey.set(mutation.dedupeKey, mutation);
  }
  return orderMutations([...latestByKey.values()]);
}

function isTransientResponse(response: ReplayResponse): boolean {
  return (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500 ||
    response.status === 0
  );
}

function recoverLeasedMutation(
  mutation: OfflineMutation,
  now: number,
  leaseMs: number,
): OfflineMutation {
  if (
    mutation.state === 'processing' &&
    (mutation.processingAt ?? 0) + leaseMs <= now
  ) {
    return {
      ...mutation,
      state: 'pending',
      processingAt: undefined,
      nextAttemptAt: now,
      lastError: 'Recovered after an interrupted sync attempt',
    };
  }
  return mutation;
}

function withFailure(
  mutation: OfflineMutation,
  state: OfflineMutationState,
  error: string,
): OfflineMutation {
  return {
    ...mutation,
    state,
    processingAt: undefined,
    lastError: error,
  };
}

export async function replayMutationBatch(
  mutations: OfflineMutation[],
  send: (mutation: OfflineMutation) => Promise<ReplayResponse>,
  options: ReplayBatchOptions = {},
): Promise<ReplayBatchResult> {
  const currentTime = options.now ?? Date.now();
  const leaseMs = options.processingLeaseMs ?? OUTBOX_PROCESSING_LEASE_MS;
  const recovered = orderMutations(
    mutations.map((mutation) =>
      recoverLeasedMutation(mutation, currentTime, leaseMs),
    ),
  );
  const byId = new Map(recovered.map((mutation) => [mutation.id, mutation]));
  const ready = recovered
    .filter(
      (mutation) =>
        mutation.state === 'pending' && mutation.nextAttemptAt <= currentTime,
    )
    .slice(0, options.maxMutations ?? Number.POSITIVE_INFINITY);

  const removedIds: string[] = [];
  let synced = 0;
  let retried = 0;
  let blocked = 0;
  let conflicts = 0;
  let stopped = false;
  let lastError: string | null = null;

  for (const mutation of ready) {
    byId.set(mutation.id, {
      ...mutation,
      state: 'processing',
      processingAt: currentTime,
    });

    let response: ReplayResponse;
    try {
      response = await send(mutation);
    } catch (error) {
      response = {
        ok: false,
        status: 0,
        error:
          error instanceof Error ? error.message : 'Network request failed',
      };
    }

    if (response.ok || (response.status >= 200 && response.status < 300)) {
      removedIds.push(mutation.id);
      synced += 1;
      continue;
    }

    const error = response.error || `Sync failed with HTTP ${response.status}`;
    lastError = error;

    if (response.status === 409 || response.status === 412) {
      byId.set(mutation.id, withFailure(mutation, 'conflict', error));
      conflicts += 1;
      continue;
    }

    if (isTransientResponse(response)) {
      const attempts = mutation.attempts + 1;
      byId.set(mutation.id, {
        ...mutation,
        attempts,
        state: 'pending',
        processingAt: undefined,
        nextAttemptAt: currentTime + calculateRetryDelay(attempts),
        lastError: error,
      });
      retried += 1;
      stopped = true;
      break;
    }

    byId.set(mutation.id, withFailure(mutation, 'blocked', error));
    blocked += 1;

    // Authentication failures affect the whole queue. Do not send more
    // article identifiers until the caller has re-authenticated.
    if (response.status === 401 || response.status === 403) {
      stopped = true;
      break;
    }
  }

  const removedSet = new Set(removedIds);
  return {
    updated: orderMutations(
      [...byId.values()].filter((mutation) => !removedSet.has(mutation.id)),
    ),
    removedIds,
    synced,
    retried,
    blocked,
    conflicts,
    stopped,
    lastError,
  };
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function buildMutation(
  scope: string,
  articleId: string,
  type: OfflineMutationType,
  sequence: number,
  queuedAt: number,
): OfflineMutation {
  return {
    id: createId('offline-mutation'),
    idempotencyKey: createId('offline-idempotency'),
    scope,
    articleId,
    type,
    dedupeKey: mutationDedupeKey(articleId, type),
    sequence,
    queuedAt,
    attempts: 0,
    nextAttemptAt: queuedAt,
    state: 'pending',
  };
}

let enqueueQueue: Promise<void> = Promise.resolve();

function serializeEnqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = enqueueQueue.then(operation, operation);
  enqueueQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getScopedMutations(scope: string): Promise<OfflineMutation[]> {
  const records = await getAllRecords<OfflineMutation>('outbox');
  return records.filter((mutation) => mutation.scope === scope);
}

export function buildInteractionRequest(
  mutation: OfflineMutation,
): RequestInit & { credentials: 'include' } {
  return {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Offline-Mutation-Id': mutation.id,
      'X-Offline-Idempotency-Key': mutation.idempotencyKey,
      'X-Offline-Protocol': OFFLINE_CACHE_VERSION,
    },
    body: JSON.stringify({
      articleId: mutation.articleId,
      type: mutation.type,
    }),
  };
}

export async function enqueueOfflineMutation(
  userScope: string,
  input: { articleId: string; type: OfflineMutationType; queuedAt?: number },
): Promise<OfflineMutation> {
  return serializeEnqueue(async () => {
    const scope = await activateOfflineUser(userScope);
    const articleId = input.articleId.trim();
    if (!articleId) throw new Error('An article id is required');

    const existing = await getScopedMutations(scope);
    const nextSequence =
      Math.max(
        Number((await getMetaValue(`outbox-sequence:${scope}`)) || 0),
        ...existing.map((mutation) => mutation.sequence),
      ) + 1;
    const mutation = buildMutation(
      scope,
      articleId,
      input.type,
      nextSequence,
      input.queuedAt ?? Date.now(),
    );
    const next = coalesceMutations([...existing, mutation]);
    const nextKeys = new Set(next.map((item) => item.id));
    const removed = existing
      .filter((item) => !nextKeys.has(item.id))
      .map((item) => item.id);

    await replaceRecords('outbox', next, removed);
    await putMetaValue(`outbox-sequence:${scope}`, nextSequence);
    await applyMutationToCachedArticle(scope, articleId, input.type);
    return mutation;
  });
}

export async function getOfflineMutations(
  userScope: string,
): Promise<OfflineMutation[]> {
  const scope = normalizeOfflineScope(userScope);
  return orderMutations(await getScopedMutations(scope));
}

export async function replayOfflineMutations(
  userScope: string,
  options: {
    fetchImpl?: typeof fetch;
    now?: number;
    maxMutations?: number;
  } = {},
): Promise<OfflineReplayResult> {
  const scope = normalizeOfflineScope(userScope);
  const fetchImpl = options.fetchImpl ?? fetch;
  const all = await getOfflineMutations(scope);
  const currentTime = options.now ?? Date.now();
  const result = await replayMutationBatch(
    all,
    async (mutation) => {
      try {
        const response = await fetchImpl(
          '/api/interactions',
          buildInteractionRequest(mutation),
        );
        return {
          ok: response.ok,
          status: response.status,
          error: response.ok
            ? undefined
            : await response.text().catch(() => undefined),
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error:
            error instanceof Error ? error.message : 'Network request failed',
        };
      }
    },
    { now: currentTime, maxMutations: options.maxMutations },
  );

  await replaceRecords('outbox', result.updated, result.removedIds);
  const remaining = result.updated.filter(
    (mutation) => !result.removedIds.includes(mutation.id),
  );
  if (result.synced > 0) {
    await putMetaValue(`outbox-last-synced:${scope}`, currentTime);
  }
  const nextAttemptAt =
    remaining
      .filter((mutation) => mutation.state === 'pending')
      .map((mutation) => mutation.nextAttemptAt)
      .sort((a, b) => a - b)[0] ?? null;

  let state: OfflineSyncStatus['state'] = 'idle';
  if (result.retried > 0) state = 'retrying';
  else if (result.blocked > 0 || result.conflicts > 0) state = 'blocked';
  else if (result.synced > 0) state = 'idle';

  return {
    state,
    synced: result.synced,
    retried: result.retried,
    blocked: result.blocked,
    conflicts: result.conflicts,
    remaining: remaining.length,
    nextAttemptAt,
    lastError: result.lastError,
  };
}

export async function getOfflineSyncStatus(
  userScope: string,
): Promise<OfflineSyncStatus> {
  const mutations = await getOfflineMutations(userScope);
  const pending = mutations.filter(
    (mutation) =>
      mutation.state === 'pending' || mutation.state === 'processing',
  );
  const blocked = mutations.some(
    (mutation) => mutation.state === 'blocked' || mutation.state === 'conflict',
  );
  const lastSyncedAt = await getMetaValue(
    `outbox-last-synced:${normalizeOfflineScope(userScope)}`,
  );
  return {
    state: blocked ? 'blocked' : 'idle',
    pendingCount: pending.length,
    lastSyncedAt: typeof lastSyncedAt === 'number' ? lastSyncedAt : null,
    nextAttemptAt:
      pending
        .map((mutation) => mutation.nextAttemptAt)
        .sort((a, b) => a - b)[0] ?? null,
    lastError:
      mutations.find((mutation) => mutation.lastError)?.lastError ?? null,
  };
}

export async function requestOfflineBackgroundSync(
  userScope?: string,
): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker)
    return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const syncRegistration = registration as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    };
    if (syncRegistration.sync) {
      await syncRegistration.sync.register('feed-me-maybe-outbox-v1');
      return true;
    }
    syncRegistration.active?.postMessage({
      type: 'FEED_ME_MAYBE_REPLAY_OUTBOX',
      scope: userScope,
    });
  } catch {
    return false;
  }
  return false;
}

export function installOfflineSync(
  userScope: string,
  options: { onReplay?: (result: OfflineReplayResult) => void } = {},
): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const replay = () => {
    if (navigator.onLine === false) return;
    void replayOfflineMutations(userScope).then((result) => {
      options.onReplay?.(result);
    });
  };
  const handleOnline = () => replay();
  const handleWorkerMessage = (event: MessageEvent<unknown>) => {
    const message = event.data as {
      type?: string;
      scope?: string;
      result?: OfflineReplayResult;
    } | null;
    if (
      message?.type === 'FEED_ME_MAYBE_OUTBOX_RESULT' &&
      message.scope === userScope &&
      message.result
    ) {
      options.onReplay?.(message.result);
      return;
    }
    if (
      message?.type === 'FEED_ME_MAYBE_REPLAY_OUTBOX' &&
      (!message.scope || message.scope === userScope)
    ) {
      replay();
    }
  };

  window.addEventListener('online', handleOnline);
  navigator.serviceWorker?.addEventListener('message', handleWorkerMessage);
  replay();
  void requestOfflineBackgroundSync(userScope);

  return () => {
    window.removeEventListener('online', handleOnline);
    navigator.serviceWorker?.removeEventListener(
      'message',
      handleWorkerMessage,
    );
  };
}

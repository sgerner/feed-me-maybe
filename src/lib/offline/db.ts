import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  type CachedArticle,
  type CachedDigest,
  type OfflineMutation,
} from './types';

export const OFFLINE_STORE_NAMES = [
  'meta',
  'articles',
  'digests',
  'outbox',
] as const;

export type OfflineStoreName = (typeof OFFLINE_STORE_NAMES)[number];

export interface OfflineMetaRecord {
  key: string;
  value: string | number;
}

export type OfflineDbRecord =
  OfflineMetaRecord | CachedArticle | CachedDigest | OfflineMutation;

let databasePromise: Promise<IDBDatabase | null> | null = null;

function getIndexedDbFactory(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function createStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains('meta')) {
    database.createObjectStore('meta', { keyPath: 'key' });
  }

  if (!database.objectStoreNames.contains('articles')) {
    const store = database.createObjectStore('articles', { keyPath: 'key' });
    store.createIndex('by-scope', 'scope', { unique: false });
    store.createIndex('by-scope-updated', ['scope', 'updatedAt'], {
      unique: false,
    });
    store.createIndex('by-scope-saved', ['scope', 'saved'], { unique: false });
  }

  if (!database.objectStoreNames.contains('digests')) {
    const store = database.createObjectStore('digests', { keyPath: 'key' });
    store.createIndex('by-scope', 'scope', { unique: false });
    store.createIndex('by-scope-updated', ['scope', 'updatedAt'], {
      unique: false,
    });
  }

  if (!database.objectStoreNames.contains('outbox')) {
    const store = database.createObjectStore('outbox', { keyPath: 'id' });
    store.createIndex('by-scope', 'scope', { unique: false });
    store.createIndex('by-scope-sequence', ['scope', 'sequence'], {
      unique: false,
    });
    store.createIndex('by-scope-dedupe', ['scope', 'dedupeKey'], {
      unique: false,
    });
  }
}

export function openOfflineDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDbFactory();
  if (!factory) return Promise.resolve(null);
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = () => {
      createStores(request.result);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('Unable to open offline storage'));
    };
    request.onblocked = () => {
      // A stale tab can hold an older connection open. The existing connection
      // will close on versionchange; keep the request alive until then.
    };
  });

  return databasePromise;
}

export function scopedKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

export function normalizeOfflineScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized) throw new Error('An offline account scope is required');
  if (normalized.length > 128) {
    throw new Error('Offline account scope is too long');
  }
  return normalized;
}

export async function getMetaValue(
  key: string,
): Promise<string | number | undefined> {
  const database = await openOfflineDatabase();
  if (!database) return undefined;
  const transaction = database.transaction('meta', 'readonly');
  const result = await requestResult<OfflineMetaRecord | undefined>(
    transaction.objectStore('meta').get(key),
  );
  await transactionComplete(transaction);
  return result?.value;
}

export async function putMetaValue(
  key: string,
  value: string | number,
): Promise<void> {
  const database = await openOfflineDatabase();
  if (!database) return;
  const transaction = database.transaction('meta', 'readwrite');
  transaction
    .objectStore('meta')
    .put({ key, value } satisfies OfflineMetaRecord);
  await transactionComplete(transaction);
}

export async function clearOfflineStores(): Promise<void> {
  const database = await openOfflineDatabase();
  if (!database) return;
  const transaction = database.transaction(
    [...OFFLINE_STORE_NAMES],
    'readwrite',
  );
  for (const storeName of OFFLINE_STORE_NAMES) {
    transaction.objectStore(storeName).clear();
  }
  await transactionComplete(transaction);
}

export async function deleteOfflineDatabase(): Promise<void> {
  const factory = getIndexedDbFactory();
  if (!factory) return;

  const database = await openOfflineDatabase();
  database?.close();
  databasePromise = null;

  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(OFFLINE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error || new Error('Unable to delete offline storage'));
    request.onblocked = () => resolve();
  });
}

export async function getAllRecords<T extends OfflineDbRecord>(
  storeName: Exclude<OfflineStoreName, 'meta'>,
): Promise<T[]> {
  const database = await openOfflineDatabase();
  if (!database) return [];
  const transaction = database.transaction(storeName, 'readonly');
  const result = await requestResult<T[]>(
    transaction.objectStore(storeName).getAll(),
  );
  await transactionComplete(transaction);
  return result;
}

export async function putRecords(
  storeName: Exclude<OfflineStoreName, 'meta'>,
  records: OfflineDbRecord[],
): Promise<void> {
  const database = await openOfflineDatabase();
  if (!database || records.length === 0) return;
  const transaction = database.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const record of records) store.put(record);
  await transactionComplete(transaction);
}

export async function deleteRecords(
  storeName: Exclude<OfflineStoreName, 'meta'>,
  keys: IDBValidKey[],
): Promise<void> {
  const database = await openOfflineDatabase();
  if (!database || keys.length === 0) return;
  const transaction = database.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const key of keys) store.delete(key);
  await transactionComplete(transaction);
}

export async function replaceRecords(
  storeName: Exclude<OfflineStoreName, 'meta'>,
  records: OfflineDbRecord[],
  deleteKeys: IDBValidKey[] = [],
): Promise<void> {
  const database = await openOfflineDatabase();
  if (!database) return;
  const transaction = database.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  for (const key of deleteKeys) store.delete(key);
  for (const record of records) store.put(record);
  await transactionComplete(transaction);
}

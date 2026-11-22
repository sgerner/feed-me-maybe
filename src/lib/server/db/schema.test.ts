import Database from 'better-sqlite3';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from './schema';
import { createTestDb } from './test-db';

function listTablesAndColumns(db: Database.Database): Record<string, string[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE 'article_search%'
       ORDER BY name`,
    )
    .pluck()
    .all() as string[];

  const result: Record<string, string[]> = {};
  for (const table of tables) {
    result[table] = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    )
      .map((col) => col.name)
      .sort();
  }
  return result;
}

function listIndexes(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name NOT LIKE 'sqlite_autoindex_%'
           AND tbl_name NOT LIKE 'article_search%'
         ORDER BY name`,
      )
      .pluck()
      .all() as string[]
  ).filter(
    (name) =>
      // Drizzle names inline .unique() constraints `<table>_<col>_unique`,
      // whereas raw SQLite DDL creates `sqlite_autoindex_<table>_<n>`.
      !name.endsWith('_unique'),
  );
}

describe('Drizzle schema parity with runtime migrations', () => {
  it('generates valid executable SQLite SQL and matches runtime tables, columns, and indexes', async () => {
    const emptySnapshot = await generateSQLiteDrizzleJson({});
    const currentSnapshot = await generateSQLiteDrizzleJson(schema);
    const statements = await generateSQLiteMigration(
      emptySnapshot,
      currentSnapshot,
    );

    expect(statements.length).toBeGreaterThan(0);

    const drizzleDb = new Database(':memory:');
    const runtimeHandle = createTestDb('feed-me-maybe-schema-parity-');
    try {
      for (const statement of statements) {
        drizzleDb.exec(statement);
      }

      expect(listTablesAndColumns(drizzleDb)).toEqual(
        listTablesAndColumns(runtimeHandle.db),
      );
      expect(listIndexes(drizzleDb)).toEqual(listIndexes(runtimeHandle.db));
    } finally {
      drizzleDb.close();
      runtimeHandle.cleanup();
    }
  });
});

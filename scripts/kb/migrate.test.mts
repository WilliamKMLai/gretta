/**
 * Schema migrations (ADR-036).
 *
 * The rule these protect: every existing user has a populated database on
 * disk, and this is the first schema change the project has ever made. An
 * upgrade that crashes, half-applies, or silently skips is the one failure
 * that costs somebody their whole index.
 *
 * Runs against an in-memory database, so it lives in the native-addon config
 * (`pnpm test:kb-native`) alongside the other better-sqlite3 tests.
 */
import { describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { TARGET_VERSION, isFromFuture, migrate, schemaVersion } from './migrate.mts';

/** The pre-migration schema, exactly as it shipped before ADR-036. */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folders TEXT NOT NULL,
  embeddingModel TEXT NOT NULL, lastIndexedAt TEXT
);
CREATE TABLE IF NOT EXISTS files (
  collectionId TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (collectionId, source)
);
CREATE TABLE IF NOT EXISTS chunks (
  collectionId TEXT NOT NULL, source TEXT NOT NULL, page INTEGER,
  paragraph INTEGER, text TEXT NOT NULL, embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_macro_state (
  collectionId TEXT PRIMARY KEY, macroTableHash TEXT NOT NULL
);
`;

function legacyDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.exec(LEGACY_SCHEMA);
  return db;
}

function columns(db: Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
}

describe('migrate', () => {
  it('treats a pre-migration database as version 0', () => {
    expect(schemaVersion(legacyDb())).toBe(0);
  });

  it('brings a populated legacy database up to date without losing rows', () => {
    // The case that matters: somebody who has already indexed a folder.
    const db = legacyDb();
    db.prepare(
      `INSERT INTO chunks (collectionId, source, page, paragraph, text, embedding)
       VALUES ('refs', 'paper.pdf', 3, NULL, 'existing text', X'00000000')`,
    ).run();

    const applied = migrate(db);

    expect(applied).toEqual([1]);
    expect(schemaVersion(db)).toBe(TARGET_VERSION);
    const rows = db.prepare('SELECT text, figureId FROM chunks').all() as {
      text: string;
      figureId: string | null;
    }[];
    expect(rows).toEqual([{ text: 'existing text', figureId: null }]);
  });

  it('adds figureId and the figures table', () => {
    const db = legacyDb();
    migrate(db);
    expect(columns(db, 'chunks')).toContain('figureId');
    expect(columns(db, 'figures')).toEqual(
      expect.arrayContaining(['id', 'collectionId', 'source', 'contentHash', 'page', 'caption']),
    );
  });

  it('is a no-op the second time', () => {
    // Every companion start runs this; the second run must do nothing rather
    // than fail on a duplicate column.
    const db = legacyDb();
    migrate(db);
    expect(migrate(db)).toEqual([]);
    expect(schemaVersion(db)).toBe(TARGET_VERSION);
  });

  it('leaves a database from a newer build completely alone', () => {
    // Downgrading by guessing at what a future step did destroys data; a
    // reported mismatch is recoverable, a mangled index is not.
    const db = legacyDb();
    db.pragma(`user_version = ${String(TARGET_VERSION + 5)}`);
    expect(isFromFuture(db)).toBe(true);
    expect(migrate(db)).toEqual([]);
    expect(columns(db, 'chunks')).not.toContain('figureId');
  });

  it('does not report a current database as from the future', () => {
    const db = legacyDb();
    migrate(db);
    expect(isFromFuture(db)).toBe(false);
  });
});

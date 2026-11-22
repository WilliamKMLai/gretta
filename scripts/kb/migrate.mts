/**
 * Schema migrations for the companion's SQLite file (DECISIONS.md ADR-036).
 *
 * Until now the schema was applied with `CREATE TABLE IF NOT EXISTS` and never
 * changed, so no migration mechanism existed. That works exactly once. It
 * cannot add a column to a table that already exists, and every user who has
 * indexed anything has a populated database on disk — so the first schema
 * change is also the first chance to corrupt or crash on somebody's data.
 *
 * `PRAGMA user_version` is SQLite's own four-byte slot for exactly this, needs
 * no bookkeeping table, and is zero on every database that predates it. Steps
 * are ordered and idempotent-by-construction: each runs once, inside a
 * transaction, and the version is bumped in the same transaction so a crash
 * mid-migration cannot leave a half-applied schema recorded as complete.
 *
 * Mirrors the pane's `services/storage/migrations.ts` in spirit — one function
 * per version step, registered in order — but not in mechanism: that one
 * rewrites a JSON payload and can afford to drop what it cannot read, whereas
 * this one alters tables holding the only copy of a user's index.
 */
import type { Database } from 'better-sqlite3';

/**
 * Steps applied in order to bring a database up to `TARGET_VERSION`.
 *
 * Index 0 upgrades v0 → v1, index 1 upgrades v1 → v2, and so on. Never
 * reorder or remove one: a database at v1 will only ever run the steps after
 * it, so an edited earlier step silently never applies to anyone who has
 * already passed it.
 */
const STEPS: readonly ((db: Database) => void)[] = [
  /**
   * v0 → v1: figures (ADR-036).
   *
   * `chunks.figureId` is added rather than joined on (source, page) because a
   * page can hold two figures, and the chunk ↔ figure relationship has to stay
   * exact for the citation to be.
   *
   * Pixels and description are nullable: a figure is recorded at index time
   * from its caption alone, and only rendered and described when something
   * actually asks for it. `contentHash` is the source file's hash at the time
   * the figure was found, which is what lets a re-index of an unchanged file
   * keep descriptions that cost 16 seconds each to produce.
   */
  (db) => {
    db.exec(`
      ALTER TABLE chunks ADD COLUMN figureId TEXT;
      ALTER TABLE collections ADD COLUMN indexFigures INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS figures (
        id            TEXT PRIMARY KEY,
        collectionId  TEXT NOT NULL,
        source        TEXT NOT NULL,
        contentHash   TEXT NOT NULL,
        page          INTEGER NOT NULL,
        bbox          TEXT NOT NULL,
        caption       TEXT NOT NULL,
        description   TEXT,
        mediaType     TEXT,
        width         INTEGER,
        height        INTEGER,
        bytes         BLOB,
        describedAt   TEXT
      );
      CREATE INDEX IF NOT EXISTS figures_by_collection ON figures (collectionId);
      CREATE INDEX IF NOT EXISTS figures_by_source ON figures (collectionId, source);
    `);
  },
  /**
   * v1 → v2: partial index on `chunks(figureId)` so `updateChunkForFigure`
   * updates a figure's chunk directly instead of full-scanning `chunks`.
   */
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS chunks_by_figure
      ON chunks (figureId) WHERE figureId IS NOT NULL;
    `);
  },
];

/** Schema version this build expects. */
export const TARGET_VERSION = STEPS.length;

/** Current `user_version` of an open database (0 on anything pre-migration). */
export function schemaVersion(db: Database): number {
  const [row] = db.pragma('user_version') as { user_version: number }[];
  return row?.user_version ?? 0;
}

/**
 * Brings a database up to `TARGET_VERSION`, returning the versions applied.
 *
 * A database from a *newer* build is left completely alone. Downgrading by
 * guessing at what a future step did is how data gets destroyed; the caller
 * surfaces the mismatch instead, which is recoverable, whereas a mangled index
 * is not.
 */
export function migrate(db: Database): number[] {
  const from = schemaVersion(db);
  if (from >= TARGET_VERSION) return [];

  const applied: number[] = [];
  for (let version = from; version < TARGET_VERSION; version += 1) {
    const step = STEPS[version];
    if (step === undefined) break;
    // Version bump rides inside the step's own transaction: a crash halfway
    // must not leave an incomplete schema recorded as finished.
    db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${String(version + 1)}`);
    })();
    applied.push(version + 1);
  }
  return applied;
}

/** True when the file was written by a build newer than this one. */
export function isFromFuture(db: Database): boolean {
  return schemaVersion(db) > TARGET_VERSION;
}

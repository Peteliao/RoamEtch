import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_MIGRATIONS, DATABASE_SCHEMA_VERSION, DATABASE_TABLES, TRIP_SCHEMA_VERSION,
  assertTripSchemaVersion, logicalDatabaseVersion, migrationErrorFromPreflight, validateMigrationRegistry,
  verifyDatabaseMigration, type DatabasePreflight
} from '../src/core/migrations';

function tripTransaction(trips: any[]) {
  return {
    table: vi.fn(() => ({
      toCollection: () => ({
        each: async (visit) => { for (const trip of trips) visit(trip); },
        modify: async (update) => { for (const trip of trips) update(trip); }
      })
    }))
  };
}

function preflight(overrides: Partial<DatabasePreflight> = {}): DatabasePreflight {
  return {
    fromVersion: 2, toVersion: 4, needsUpgrade: true, skipped: false,
    blocking: false, ok: true, stores: DATABASE_TABLES,
    counts: {
      trips: 1, segments: 0, trackChunks: 0, trackSnapshots: 0,
      waypoints: 0, media: 0, elevCache: 0, shareImports: 0, quarantine: 0,
      points: 0, snapshotPoints: 0
    },
    issues: [], ...overrides
  };
}

function migratedDatabase(counts = preflight().counts, trips = [{ id: 'trip-1', schemaVersion: 1 }]) {
  return {
    verno: DATABASE_SCHEMA_VERSION,
    tables: DATABASE_TABLES.map((name) => ({ name })),
    table: (name: string) => ({
      count: async () => counts[name],
      toCollection: () => ({ each: async (visit) => { for (const trip of trips) visit(trip); } })
    })
  };
}

describe('database migration registry', () => {
  it('declares contiguous, independently named schema upgrades', () => {
    expect(validateMigrationRegistry()).toBe(true);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.name)).toEqual([
      'initial-trip-storage', 'durable-share-imports', 'original-track-snapshots', 'recoverable-integrity-quarantine'
    ]);
    expect(DATABASE_MIGRATIONS[1].upgrade).toEqual(expect.any(Function));
    expect(DATABASE_MIGRATIONS[2].upgrade).toEqual(expect.any(Function));
  });

  it('rejects gaps and duplicate migration names', () => {
    expect(() => validateMigrationRegistry([
      DATABASE_MIGRATIONS[0], { ...DATABASE_MIGRATIONS[2], version: 3 }
    ])).toThrow(/invalid-migration-registry/);
    expect(() => validateMigrationRegistry([
      DATABASE_MIGRATIONS[0], { ...DATABASE_MIGRATIONS[1], name: DATABASE_MIGRATIONS[0].name }, DATABASE_MIGRATIONS[2]
    ])).toThrow(/invalid-migration-registry/);
  });

  it('maps Dexie native versions back to logical schema versions', () => {
    expect([0, 10, 20, 30, 31, 40].map(logicalDatabaseVersion)).toEqual([0, 1, 2, 3, 3, 4]);
    expect(() => logicalDatabaseVersion(-1)).toThrow(/invalid-database-version/);
  });

  it('normalizes missing trip versions and verifies the migrated rows', async () => {
    const trips = [{ id: 'legacy' }, { id: 'current', schemaVersion: 1 }];
    await DATABASE_MIGRATIONS[2].upgrade(tripTransaction(trips));
    expect(trips).toEqual([
      { id: 'legacy', schemaVersion: TRIP_SCHEMA_VERSION },
      { id: 'current', schemaVersion: TRIP_SCHEMA_VERSION }
    ]);
  });

  it.each([
    [{ id: 'future', schemaVersion: 2 }, 'future-trip-schema-version'],
    [{ id: 'invalid', schemaVersion: 0 }, 'invalid-trip-schema-version'],
    [{ id: 'fractional', schemaVersion: 1.5 }, 'invalid-trip-schema-version']
  ])('stops before writing unsupported trip schema %#', async (trip, code) => {
    const tx = tripTransaction([trip]);
    await expect(DATABASE_MIGRATIONS[2].upgrade(tx)).rejects.toMatchObject({ code });
  });

  it('accepts missing legacy versions but rejects invalid values', () => {
    expect(() => assertTripSchemaVersion(undefined)).not.toThrow();
    expect(() => assertTripSchemaVersion(null)).not.toThrow();
    expect(() => assertTripSchemaVersion(1)).not.toThrow();
    expect(() => assertTripSchemaVersion(2)).toThrow(/future-trip-schema-version/);
    expect(() => assertTripSchemaVersion('1')).toThrow(/invalid-trip-schema-version/);
  });
});

describe('post-migration verification', () => {
  it('verifies schema, required stores, row counts and trip versions', async () => {
    await expect(verifyDatabaseMigration(migratedDatabase(), preflight())).resolves.toMatchObject({
      fromVersion: 2, toVersion: 4, needsUpgrade: true, verified: true
    });
  });

  it('rejects lost rows instead of treating an incomplete upgrade as successful', async () => {
    const counts = { ...preflight().counts, segments: 0 };
    await expect(verifyDatabaseMigration(migratedDatabase(counts), preflight({
      counts: { ...preflight().counts, segments: 1 }
    }))).rejects.toMatchObject({
      code: 'migration-verification-failed'
    });
  });

  it('rejects missing stores and unsupported trip versions', async () => {
    const missingStore = migratedDatabase();
    missingStore.tables = missingStore.tables.filter((table) => table.name !== 'trackSnapshots');
    await expect(verifyDatabaseMigration(missingStore, preflight())).rejects.toMatchObject({ code: 'migration-verification-failed' });

    const invalidTrip = migratedDatabase(preflight().counts, [{ id: 'trip-1', schemaVersion: 2 }]);
    await expect(verifyDatabaseMigration(invalidTrip, preflight())).rejects.toMatchObject({ code: 'future-trip-schema-version' });
  });

  it('verifies current and skipped databases without comparing row counts', async () => {
    const current = preflight({ fromVersion: 4, needsUpgrade: false });
    await expect(verifyDatabaseMigration(migratedDatabase(undefined, []), current)).resolves.toMatchObject({ verified: true, needsUpgrade: false });
    const skipped = preflight({ skipped: true });
    await expect(verifyDatabaseMigration(migratedDatabase(undefined, []), skipped)).resolves.toMatchObject({ verified: true, skipped: true });
  });

  it('rejects unsupported trip schemas even when the database schema is current', async () => {
    const current = preflight({ fromVersion: 4, needsUpgrade: false });
    await expect(verifyDatabaseMigration(
      migratedDatabase(undefined, [{ id: 'trip-1', schemaVersion: 2 }]),
      current
    )).rejects.toMatchObject({ code: 'future-trip-schema-version' });
  });

  it('turns blocking preflight findings into actionable migration errors', () => {
    const error = migrationErrorFromPreflight(preflight({
      blocking: true,
      issues: [{ type: 'future-trip-schema-version', severity: 'error', count: 1, sampleIds: ['trip-1'] }]
    }));
    expect(error).toMatchObject({ name: 'DatabaseMigrationError', code: 'future-trip-schema-version' });
  });
});

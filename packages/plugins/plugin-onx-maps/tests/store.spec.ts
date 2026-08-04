import { describe, expect, it } from "vitest";

import { DB_NAMESPACE } from "../src/constants.js";
import type { ParsedMarkup, StoredMarkup } from "../src/model.js";
import { parseOnxExport } from "../src/parse.js";
import * as store from "../src/store.js";
import { GPX_EXPORT } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Fake db that records every statement the store emits
// ---------------------------------------------------------------------------

interface Recorded {
  kind: "query" | "execute";
  sql: string;
  params: unknown[];
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const recorded: Recorded[] = [];
  const db: store.StoreDb = {
    namespace: DB_NAMESPACE,
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      recorded.push({ kind: "query", sql, params });
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      recorded.push({ kind: "execute", sql, params });
      // Report every supplied row as inserted unless the caller overrides.
      return { rowCount: 1 };
    },
  };
  return { db, recorded };
}

function markupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    company_id: "22222222-2222-4222-8222-222222222222",
    import_id: "33333333-3333-4333-8333-333333333333",
    external_key: "abc123",
    kind: "waypoint",
    name: "North Treestand",
    description: null,
    folder_path: "Elk 2025",
    symbol: "Tree Stand",
    lat: 46.8721,
    lon: -114.0198,
    elevation_meters: 1042.3,
    source_time: null,
    geometry: { type: "Point", coordinates: [-114.0198, 46.8721] },
    min_lon: -114.0198,
    min_lat: 46.8721,
    max_lon: -114.0198,
    max_lat: 46.8721,
    point_count: 1,
    distance_meters: null,
    elevation_gain_meters: null,
    elevation_loss_meters: null,
    min_elevation_meters: 1042.3,
    max_elevation_meters: 1042.3,
    area_square_meters: null,
    created_at: "2025-09-14T00:00:00.000Z",
    updated_at: "2025-09-14T00:00:00.000Z",
    ...overrides,
  };
}

const COMPANY = "22222222-2222-4222-8222-222222222222";
const IMPORT = "33333333-3333-4333-8333-333333333333";

// ---------------------------------------------------------------------------
// Host runtime-SQL rules
//
// The host validates every ctx.db call before it reaches Postgres
// (validatePluginRuntimeQuery / validatePluginRuntimeExecute). Those rules are
// mirrored here so a statement that the host would reject at runtime fails in
// CI instead of in front of a user.
// ---------------------------------------------------------------------------

function normalise(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function assertHostWouldAcceptQuery(sql: string): void {
  const normalized = normalise(sql);
  expect(normalized.startsWith("select ") || normalized.startsWith("with ")).toBe(true);
  // A SELECT may not contain mutation or DDL keywords anywhere.
  expect(normalized).not.toMatch(/\b(insert|update|delete|alter|create|drop|truncate)\b/);
  for (const schema of qualifiedSchemas(sql)) {
    expect(schema).toBe(DB_NAMESPACE);
  }
  expect(normalizedStatementCount(sql)).toBe(1);
}

function assertHostWouldAcceptExecute(sql: string): void {
  const normalized = normalise(sql);
  expect(normalized).toMatch(/^(insert\s+into|update|delete\s+from)\b/);
  expect(normalized).not.toMatch(/\b(alter|create|drop|truncate)\b/);
  for (const schema of qualifiedSchemas(sql)) {
    expect(schema).toBe(DB_NAMESPACE);
  }
  expect(normalizedStatementCount(sql)).toBe(1);
}

/** Schemas named in `from`/`join`/`into`/`update`/`references` positions. */
function qualifiedSchemas(sql: string): string[] {
  const schemas: string[] = [];
  const pattern = /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const match of sql.matchAll(pattern)) schemas.push(match[2]!);
  return schemas;
}

function normalizedStatementCount(sql: string): number {
  return sql
    .replace(/'[^']*'/g, "''")
    .split(";")
    .filter((part) => part.trim().length > 0).length;
}

/** Exercise every store entry point and collect the SQL it produces. */
async function collectAllStatements(): Promise<Recorded[]> {
  const { db, recorded } = fakeDb([markupRow()]);
  const markups = parseOnxExport(GPX_EXPORT).markups;

  await store.findImportByHash(db, COMPANY, "hash");
  await store.createImport(db, {
    companyId: COMPANY,
    filename: "a.gpx",
    format: "gpx",
    contentHash: "hash",
    byteSize: 10,
    warnings: [],
    importedBy: null,
  });
  await store.finalizeImport(db, IMPORT, {
    markupCount: 1,
    insertedCount: 1,
    duplicateCount: 0,
  });
  await store.listImports(db, COMPANY);
  await store.deleteImport(db, COMPANY, IMPORT);
  await store.insertMarkups(db, COMPANY, IMPORT, markups);
  await store.listMarkups(db, COMPANY, {
    kinds: ["waypoint"],
    folderPath: "Elk 2025",
    search: "stand",
    importId: IMPORT,
    limit: 10,
    offset: 5,
  });
  await store.listMarkups(db, COMPANY);
  await store.getMarkupById(db, COMPANY, "id");
  await store.getMarkupByExternalKey(db, COMPANY, "key");
  await store.markupsNear(db, COMPANY, 46.87, -114.02, 8000, 10);
  await store.listFolders(db, COMPANY);
  await store.getOverview(db, COMPANY);
  await store.listIssueLinks(db, COMPANY, "issue");
  await store.listMarkupIssueIds(db, COMPANY, "markup");
  await store.linkMarkupToIssue(db, COMPANY, "issue", "markup", null, null);
  await store.unlinkMarkupFromIssue(db, COMPANY, "issue", "markup");

  return recorded;
}

describe("store SQL conforms to the host runtime validators", () => {
  it("emits only statements the host would accept", async () => {
    const recorded = await collectAllStatements();
    expect(recorded.length).toBeGreaterThan(15);

    for (const entry of recorded) {
      if (entry.kind === "query") assertHostWouldAcceptQuery(entry.sql);
      else assertHostWouldAcceptExecute(entry.sql);
    }
  });

  it("references only this plugin's namespace", async () => {
    const recorded = await collectAllStatements();
    for (const entry of recorded) {
      expect(entry.sql).not.toMatch(/\bpublic\./);
      const tables = entry.sql.match(/plugin_[a-z0-9_]+/g) ?? [];
      for (const table of tables) expect(table).toBe(DB_NAMESPACE);
    }
  });

  it("numbers every placeholder contiguously from $1", async () => {
    const recorded = await collectAllStatements();
    for (const entry of recorded) {
      const used = new Set(
        [...entry.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
      );
      for (const index of used) {
        expect(index).toBeGreaterThanOrEqual(1);
        expect(index).toBeLessThanOrEqual(entry.params.length);
      }
      // Every bound parameter must actually be referenced.
      expect(used.size).toBe(entry.params.length);
    }
  });
});

describe("insertMarkups", () => {
  it("binds 25 values per row and casts geometry to jsonb", async () => {
    const { db, recorded } = fakeDb();
    const markups = parseOnxExport(GPX_EXPORT).markups;
    await store.insertMarkups(db, COMPANY, IMPORT, markups);

    const insert = recorded.find((entry) => entry.kind === "execute")!;
    expect(insert.params.length).toBe(markups.length * 25);
    expect(insert.sql).toMatch(/::jsonb/);
    expect(insert.sql).toMatch(/on conflict \(company_id, external_key\) do nothing/i);
  });

  it("collapses duplicates within a single file before inserting", async () => {
    const { db, recorded } = fakeDb();
    const [first] = parseOnxExport(GPX_EXPORT).markups;
    const duplicated: ParsedMarkup[] = [first!, { ...first! }, { ...first! }];

    const result = await store.insertMarkups(db, COMPANY, IMPORT, duplicated);
    const insert = recorded.find((entry) => entry.kind === "execute")!;

    // One row bound, not three — ON CONFLICT cannot fire twice on one key
    // inside a single statement, so the collapse has to happen first.
    expect(insert.params.length).toBe(25);
    expect(result.insertedCount).toBe(1);
    expect(result.duplicateCount).toBe(2);
  });

  it("chunks large inserts to stay under the bind-parameter ceiling", async () => {
    const { db, recorded } = fakeDb();
    const [first] = parseOnxExport(GPX_EXPORT).markups;
    const many: ParsedMarkup[] = Array.from({ length: 450 }, (_, index) => ({
      ...first!,
      externalKey: `key-${index}`,
    }));

    await store.insertMarkups(db, COMPANY, IMPORT, many);
    const inserts = recorded.filter((entry) => entry.kind === "execute");

    expect(inserts).toHaveLength(3);
    for (const insert of inserts) {
      expect(insert.params.length).toBeLessThanOrEqual(200 * 25);
      // Comfortably inside Postgres' 65535-parameter limit.
      expect(insert.params.length).toBeLessThan(65_535);
    }
  });

  it("does nothing for an empty list", async () => {
    const { db, recorded } = fakeDb();
    const result = await store.insertMarkups(db, COMPANY, IMPORT, []);
    expect(recorded).toHaveLength(0);
    expect(result).toEqual({ insertedCount: 0, duplicateCount: 0 });
  });
});

describe("markupsNear", () => {
  it("filters the bounding-box prefilter down to a true radius", async () => {
    // Row sits ~1.2 km north of the search point.
    const { db } = fakeDb([markupRow({ lat: 46.8821, lon: -114.0198 })]);

    const inside = await store.markupsNear(db, COMPANY, 46.8721, -114.0198, 5000);
    expect(inside).toHaveLength(1);
    expect(inside[0]!.distanceMeters).toBeGreaterThan(1000);
    expect(inside[0]!.distanceMeters).toBeLessThan(1200);

    // The same row is inside the lat/lon window at 500 m but outside the circle.
    const outside = await store.markupsNear(db, COMPANY, 46.8721, -114.0198, 500);
    expect(outside).toHaveLength(0);
  });

  it("does not divide by zero at the poles", async () => {
    const { db, recorded } = fakeDb([]);
    await store.markupsNear(db, COMPANY, 90, 0, 10_000);
    const query = recorded[0]!;
    for (const param of query.params) {
      expect(Number.isFinite(Number(param)) || typeof param === "string").toBe(true);
    }
  });
});

describe("row mapping", () => {
  it("maps snake_case columns onto the domain model", async () => {
    const { db } = fakeDb([markupRow()]);
    const markup = (await store.getMarkupById(db, COMPANY, "id")) as StoredMarkup;

    expect(markup.kind).toBe("waypoint");
    expect(markup.folderPath).toBe("Elk 2025");
    expect(markup.elevationMeters).toBeCloseTo(1042.3, 3);
    expect(markup.bounds.minLat).toBeCloseTo(46.8721, 6);
    expect(markup.stats.pointCount).toBe(1);
    expect(markup.geometry.type).toBe("Point");
  });

  it("parses geometry that arrives as text", async () => {
    const { db } = fakeDb([
      markupRow({ geometry: JSON.stringify({ type: "Point", coordinates: [-114, 46] }) }),
    ]);
    const markup = (await store.getMarkupById(db, COMPANY, "id")) as StoredMarkup;
    expect(markup.geometry).toEqual({ type: "Point", coordinates: [-114, 46] });
  });
});

describe("escapeLike", () => {
  it("neutralises LIKE wildcards", () => {
    expect(store.escapeLike("50%")).toBe("50\\%");
    expect(store.escapeLike("a_b")).toBe("a\\_b");
    expect(store.escapeLike("back\\slash")).toBe("back\\\\slash");
    expect(store.escapeLike("plain")).toBe("plain");
  });
});

describe("clampLimit", () => {
  it("falls back and clamps", () => {
    expect(store.clampLimit(undefined, 25, 200)).toBe(25);
    expect(store.clampLimit(Number.NaN, 25, 200)).toBe(25);
    expect(store.clampLimit(1000, 25, 200)).toBe(200);
    expect(store.clampLimit(0, 25, 200)).toBe(1);
    expect(store.clampLimit(-5, 25, 200)).toBe(1);
    expect(store.clampLimit(50, 25, 200)).toBe(50);
  });
});

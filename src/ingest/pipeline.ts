import { eq, desc, and, gte, lt, inArray } from "drizzle-orm";
import { METRICS, X_HANDLES, type MetricDef } from "@/catalog/metrics";
import {
  DESK_MATRIX_BLOCKS,
  allDeskMatrixMetricIds,
  cellAllowed,
  type ColumnRule,
  type DeskRegion,
  toQuarterEndPeriod,
} from "@/catalog/desk-matrix";
import {
  DESK_SMOOTHED_ROWS,
  SMOOTH_METHOD_LABELS,
  SMOOTH_METHOD_SHORT,
  allDeskSmoothedMetricIds,
  type SmoothMethod,
} from "@/catalog/desk-smoothed";
import { LIVE_MAP, liveSeriesIdsForProvider } from "@/catalog/live-map";
import { investingToCatalogScale } from "@/catalog/investing-map";
import { getClient, getDb } from "@/db";
import {
  calendarEvents,
  ingestRuns,
  metrics,
  observations,
  releases,
  sourceHandles,
} from "@/db/schema";
import { computeSurprise } from "@/lib/surprise";
import {
  annualized3mFromIndex,
  annualized3mFromMom,
  indexLevel,
  movingAverage3,
  roundSmooth,
  windowEndingAt,
  type SeriesPoint,
} from "@/lib/smoothing";
import {
  calendarCountryToRegion,
  classifyCalendarEvent,
  dedupeCalendarRows,
  speakerInstitution,
  utcDayStart,
  addUtcDays,
} from "@/lib/calendar-tape";
import { fetchFredSeries, mapPool } from "./fred";
import { fetchEurostatPreset } from "./eurostat";
import { fetchOnsSeries } from "./ons";
import { fetchEcbSpfHicp1y, fetchEcbSpfSeries, fetchEcbCesInflation1y, type EcbSpfSeries } from "./ecb-spf";
import { fetchEcbSafeWageExpectations } from "./ecb-safe";
import { fetchBoeInflationExpectations1y, fetchBoeInflationExpectations } from "./boe-inflation-attitudes";
import { fetchBoeDmpWages } from "./boe-dmp";
import { fetchOnsPpiBulletin } from "./ons-ppi-bulletin";
import { fetchBlsSeries } from "./bls";
import {
  blsReleaseFallbackPoints,
  fetchBlsCpiRelease,
  fetchBlsEmpsitRelease,
} from "./bls-releases";
import { fetchBeaNipa } from "./bea";
import { fetchAdpNational } from "./adp";
import { fetchDolClaims } from "./dol-claims";
import { fetchGdpNow } from "./fed-regional";
import { fetchReleaseFeeds, mapFeedItemsToMetrics, type FeedItem } from "./rss";
import { applyTransform, round, type RawPoint } from "./transforms";

export interface IngestSummary {
  runId: number;
  mode: "backfill" | "refresh";
  metricsProcessed: number;
  observationsUpserted: number;
  liveHits: number;
  fredFallbacks: number;
  failures: Array<{ metricId: string; error: string }>;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS metrics (
    id TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    series_id TEXT NOT NULL,
    transform TEXT NOT NULL,
    frequency TEXT NOT NULL,
    unit TEXT NOT NULL,
    importance TEXT NOT NULL,
    official_url TEXT NOT NULL,
    docs_url TEXT NOT NULL,
    release_name TEXT NOT NULL,
    earliest_available TEXT,
    last_ingested_at TEXT,
    observation_count INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_id TEXT NOT NULL,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    raw_value REAL,
    released_at TEXT,
    vintage_date TEXT,
    is_latest INTEGER DEFAULT 1,
    UNIQUE(metric_id, date, vintage_date)
  )`,
  `CREATE INDEX IF NOT EXISTS obs_metric_date_idx ON observations(metric_id, date)`,
  `CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_id TEXT NOT NULL,
    period_date TEXT NOT NULL,
    released_at TEXT NOT NULL,
    value REAL NOT NULL,
    expected_value REAL,
    prior_period_value REAL,
    prior_period_date TEXT,
    prior_release_value REAL,
    change_vs_prior_period REAL,
    change_vs_prior_release REAL,
    supporting_doc_url TEXT,
    notes TEXT,
    UNIQUE(metric_id, period_date, released_at)
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'investing',
    country TEXT NOT NULL,
    currency TEXT,
    event_name TEXT NOT NULL,
    importance INTEGER,
    released_at TEXT NOT NULL,
    period_date TEXT,
    period_label TEXT,
    actual REAL,
    forecast REAL,
    previous REAL,
    raw_actual TEXT,
    raw_forecast TEXT,
    raw_previous TEXT,
    metric_id TEXT,
    dump_file TEXT,
    imported_at TEXT NOT NULL,
    UNIQUE(source, country, event_name, released_at)
  )`,
  `CREATE INDEX IF NOT EXISTS calendar_metric_idx ON calendar_events(metric_id)`,
  `CREATE INDEX IF NOT EXISTS calendar_released_idx ON calendar_events(released_at)`,
  `CREATE TABLE IF NOT EXISTS ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    metrics_processed INTEGER DEFAULT 0,
    observations_upserted INTEGER DEFAULT 0,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS source_handles (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL DEFAULT 'x',
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    region TEXT,
    role TEXT NOT NULL,
    notes TEXT
  )`,
];

async function ensureColumn(
  table: string,
  column: string,
  ddlType: string
): Promise<void> {
  const client = getClient();
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((r) => String(r.name) === column);
  if (!exists) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

export async function ensureSchema(): Promise<void> {
  const client = getClient();
  for (const sql of DDL) {
    await client.execute(sql);
  }
  // Existing DBs created before expected_value
  await ensureColumn("releases", "expected_value", "REAL");
}

export async function seedCatalog(): Promise<void> {
  const db = getDb();
  const client = getClient();
  const catalogIds = new Set(METRICS.map((m) => m.id));

  for (const m of METRICS) {
    await db
      .insert(metrics)
      .values({
        id: m.id,
        region: m.region,
        category: m.category,
        subcategory: m.subcategory,
        name: m.name,
        shortName: m.shortName,
        description: m.description,
        source: m.source,
        seriesId: m.seriesId,
        transform: m.transform,
        frequency: m.frequency,
        unit: m.unit,
        importance: m.importance,
        officialUrl: m.officialUrl,
        docsUrl: m.docsUrl,
        releaseName: m.releaseName,
      })
      .onConflictDoUpdate({
        target: metrics.id,
        set: {
          name: m.name,
          shortName: m.shortName,
          description: m.description,
          seriesId: m.seriesId,
          transform: m.transform,
          officialUrl: m.officialUrl,
          docsUrl: m.docsUrl,
          releaseName: m.releaseName,
          importance: m.importance,
          subcategory: m.subcategory,
          category: m.category,
          region: m.region,
        },
      });
  }

  const existing = await db.select({ id: metrics.id }).from(metrics);
  for (const row of existing) {
    if (!catalogIds.has(row.id)) {
      await client.execute({
        sql: "DELETE FROM observations WHERE metric_id = ?",
        args: [row.id],
      });
      await client.execute({
        sql: "DELETE FROM releases WHERE metric_id = ?",
        args: [row.id],
      });
      await client.execute({
        sql: "DELETE FROM metrics WHERE id = ?",
        args: [row.id],
      });
    }
  }

  for (const h of X_HANDLES) {
    await db
      .insert(sourceHandles)
      .values({
        id: h.id,
        platform: "x",
        handle: h.handle,
        displayName: h.displayName,
        region: h.region,
        role: h.role,
        notes: h.notes,
      })
      .onConflictDoUpdate({
        target: sourceHandles.id,
        set: {
          handle: h.handle,
          displayName: h.displayName,
          notes: h.notes,
          role: h.role,
        },
      });
  }
}

function effectiveTransform(
  metric: MetricDef,
  opts?: { treatAsLevel?: boolean }
): Parameters<typeof applyTransform>[1] {
  if (opts?.treatAsLevel) return "level";
  if (metric.id === "us-nfp" || metric.id === "us-adp-change") return "diff";
  return metric.transform;
}

function scalePoints(metric: MetricDef, points: RawPoint[]): RawPoint[] {
  // ADP FRED levels are persons; live ADP change scrape may already be in thousands.
  if (metric.id === "us-adp-level") {
    return points.map((p) => ({
      ...p,
      value: p.value > 1_000_000 ? p.value / 1000 : p.value,
    }));
  }
  if (metric.id === "us-adp-change") {
    // If values look like persons (e.g. 44000), keep as thousands already from scrape
    // If from FRED persons level diff after /1000 scale upstream — handled in live loader
    return points;
  }
  return points;
}

function preparePoints(
  metric: MetricDef,
  raw: RawPoint[],
  opts?: { treatAsLevel?: boolean }
) {
  if (raw.length === 0) throw new Error("No observations returned");
  const scaled = scalePoints(metric, raw);
  const transformed = applyTransform(
    scaled,
    effectiveTransform(metric, opts)
  ).map((p) => ({
    ...p,
    value: round(p.value),
  }));
  const byDate = new Map<string, (typeof transformed)[number]>();
  for (const p of transformed) byDate.set(p.date, p);
  const unique = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, p]) => p);
  if (unique.length === 0) throw new Error("Transform produced no points");
  return unique;
}

async function writeReleaseRow(
  metric: MetricDef,
  unique: Array<{ date: string; value: number; rawValue: number }>,
  sourceNote: string,
  docsUrl?: string | null
) {
  const client = getClient();
  const now = new Date().toISOString();
  const latest = unique[unique.length - 1];
  const prior = unique.length > 1 ? unique[unique.length - 2] : null;

  let priorValue = prior?.value ?? null;
  let priorDate = prior?.date ?? null;
  if (!prior) {
    const prev = await client.execute({
      sql: `SELECT date, value FROM observations
            WHERE metric_id = ? AND date < ?
            ORDER BY date DESC LIMIT 1`,
      args: [metric.id, latest.date],
    });
    if (prev.rows[0]) {
      priorDate = String(prev.rows[0].date);
      priorValue = Number(prev.rows[0].value);
    }
  }
  if (!priorValue) {
    const prevRel = await client.execute({
      sql: `SELECT period_date, value FROM releases
            WHERE metric_id = ? AND period_date < ?
            ORDER BY period_date DESC, released_at DESC LIMIT 1`,
      args: [metric.id, latest.date],
    });
    if (prevRel.rows[0]) {
      priorDate = String(prevRel.rows[0].period_date);
      priorValue = Number(prevRel.rows[0].value);
    }
  }

  const existing = await client.execute({
    sql: `SELECT released_at, value, expected_value, prior_period_value, prior_period_date
          FROM releases
          WHERE metric_id = ? AND period_date = ?
          ORDER BY CASE WHEN notes LIKE 'investing calendar:%' THEN 0 ELSE 1 END,
                   released_at ASC
          LIMIT 1`,
    args: [metric.id, latest.date],
  });

  const releasedAt = existing.rows[0] ? String(existing.rows[0].released_at) : now;
  const expectedValue =
    existing.rows[0]?.expected_value != null ? Number(existing.rows[0].expected_value) : null;
  let priorReleaseValue: number | null = null;
  let changeVsPriorRelease: number | null = null;

  if (existing.rows[0]) {
    const oldVal = Number(existing.rows[0].value);
    if (Number.isFinite(oldVal) && Math.abs(oldVal - latest.value) > 0.001) {
      priorReleaseValue = oldVal;
      changeVsPriorRelease = round(latest.value - oldVal);
    }
    if (priorValue == null && existing.rows[0].prior_period_value != null) {
      priorValue = Number(existing.rows[0].prior_period_value);
      priorDate = String(existing.rows[0].prior_period_date);
    }
  }

  await client.execute({
    sql: `INSERT INTO releases (
            metric_id, period_date, released_at, value, expected_value,
            prior_period_value, prior_period_date,
            prior_release_value, change_vs_prior_release,
            change_vs_prior_period, supporting_doc_url, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(metric_id, period_date, released_at) DO UPDATE SET
            value=excluded.value,
            expected_value=COALESCE(excluded.expected_value, releases.expected_value),
            prior_period_value=COALESCE(excluded.prior_period_value, releases.prior_period_value),
            prior_period_date=COALESCE(excluded.prior_period_date, releases.prior_period_date),
            prior_release_value=COALESCE(excluded.prior_release_value, releases.prior_release_value),
            change_vs_prior_release=COALESCE(excluded.change_vs_prior_release, releases.change_vs_prior_release),
            change_vs_prior_period=COALESCE(excluded.change_vs_prior_period, releases.change_vs_prior_period),
            supporting_doc_url=excluded.supporting_doc_url,
            notes=CASE
              WHEN releases.notes LIKE 'investing calendar:%' THEN releases.notes
              ELSE excluded.notes
            END`,
    args: [
      metric.id,
      latest.date,
      releasedAt,
      latest.value,
      expectedValue,
      priorValue,
      priorDate,
      priorReleaseValue,
      changeVsPriorRelease,
      priorValue !== null ? round(latest.value - priorValue) : null,
      docsUrl || metric.docsUrl,
      sourceNote,
    ],
  });

  // Drop duplicate live rows for the same period (keep canonical released_at)
  await client.execute({
    sql: `DELETE FROM releases
          WHERE metric_id = ? AND period_date = ? AND released_at != ?`,
    args: [metric.id, latest.date, releasedAt],
  });
}

/** Full replace — used for historical backfill. */
async function persistMetricReplace(
  metric: MetricDef,
  raw: RawPoint[],
  sourceNote: string
): Promise<number> {
  const unique = preparePoints(metric, raw);
  const client = getClient();
  const now = new Date().toISOString();
  const vintage = now.slice(0, 10);

  await client.execute({
    sql: "DELETE FROM observations WHERE metric_id = ?",
    args: [metric.id],
  });

  const chunkSize = 400;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, 1)").join(",");
    const args: (string | number | null)[] = [];
    for (const p of chunk) {
      args.push(metric.id, p.date, p.value, p.rawValue, now, vintage);
    }
    await client.execute({
      sql: `INSERT INTO observations (metric_id, date, value, raw_value, released_at, vintage_date, is_latest)
            VALUES ${placeholders}`,
      args,
    });
  }

  await getDb()
    .update(metrics)
    .set({
      earliestAvailable: unique[0].date,
      lastIngestedAt: now,
      observationCount: unique.length,
    })
    .where(eq(metrics.id, metric.id));

  await writeReleaseRow(metric, unique, sourceNote);
  return unique.length;
}

/** Merge upsert — used for live refresh so we don't wipe FRED history. */
async function persistMetricMerge(
  metric: MetricDef,
  raw: RawPoint[],
  sourceNote: string,
  opts?: { treatAsLevel?: boolean; docsUrl?: string | null }
): Promise<number> {
  const unique = preparePoints(metric, raw, opts);
  const client = getClient();
  const now = new Date().toISOString();
  const vintage = `live-${now.slice(0, 10)}`;

  // Bulk delete + insert for speed
  const dates = unique.map((p) => p.date);
  if (dates.length === 1) {
    await client.execute({
      sql: `DELETE FROM observations WHERE metric_id = ? AND date = ?`,
      args: [metric.id, dates[0]],
    });
  } else if (dates.length > 1) {
    const placeholders = dates.map(() => "?").join(",");
    await client.execute({
      sql: `DELETE FROM observations WHERE metric_id = ? AND date IN (${placeholders})`,
      args: [metric.id, ...dates],
    });
  }

  const chunkSize = 200;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const ph = chunk.map(() => "(?, ?, ?, ?, ?, ?, 1)").join(",");
    const args: (string | number | null)[] = [];
    for (const p of chunk) {
      args.push(metric.id, p.date, p.value, p.rawValue, now, vintage);
    }
    await client.execute({
      sql: `INSERT INTO observations (metric_id, date, value, raw_value, released_at, vintage_date, is_latest)
            VALUES ${ph}`,
      args,
    });
  }

  const countRes = await client.execute({
    sql: `SELECT COUNT(*) AS c, MIN(date) AS mn FROM observations WHERE metric_id = ?`,
    args: [metric.id],
  });
  const observationCount = Number(countRes.rows[0]?.c ?? unique.length);
  const earliestAvailable = String(countRes.rows[0]?.mn ?? unique[0].date);

  await getDb()
    .update(metrics)
    .set({
      earliestAvailable,
      lastIngestedAt: now,
      observationCount,
    })
    .where(eq(metrics.id, metric.id));

  await writeReleaseRow(metric, unique, sourceNote, opts?.docsUrl);
  return unique.length;
}

type LiveCaches = {
  bls: Map<string, RawPoint[]>;
  empsit?: Awaited<ReturnType<typeof fetchBlsEmpsitRelease>>;
  cpiRelease?: Awaited<ReturnType<typeof fetchBlsCpiRelease>> | null;
  adp?: { level: RawPoint[]; change: RawPoint[] };
  dol?: { initial: RawPoint[]; continuing: RawPoint[] };
  gdpNow?: RawPoint[];
  onsPpi?: Awaited<ReturnType<typeof fetchOnsPpiBulletin>>;
  rssByMetric?: Map<string, FeedItem>;
};

async function warmLiveCaches(): Promise<LiveCaches> {
  const caches: LiveCaches = { bls: new Map() };

  // Official release RSS/Atom — docs + release awareness (BLS, BEA, Fed, ONS via GOV.UK, ECB)
  try {
    const feedItems = await fetchReleaseFeeds();
    caches.rssByMetric = mapFeedItemsToMetrics(feedItems);
    console.log(
      `[live] RSS feeds items=${feedItems.length} metricLinks=${caches.rssByMetric.size}`
    );
  } catch (err) {
    console.warn(`[live] RSS feeds failed:`, err);
  }

  const blsIds = liveSeriesIdsForProvider("bls");
  if (blsIds.length) {
    try {
      caches.bls = await fetchBlsSeries(blsIds, {
        startYear: new Date().getFullYear() - 3,
      });
      console.log(`[live] BLS API fetched ${caches.bls.size} series`);
    } catch (err) {
      console.warn(`[live] BLS API failed (will use release pages):`, err);
    }
  }

  // HTML release pages only as fallback when BLS API returned nothing
  if (![...caches.bls.values()].some((pts) => pts.length > 0)) {
    try {
      caches.empsit = await fetchBlsEmpsitRelease();
      console.log(
        `[live] BLS empsit NFP=${caches.empsit.nfpChange?.value} U3=${caches.empsit.unemployment?.value}`
      );
    } catch (err) {
      console.warn(`[live] BLS empsit HTML failed:`, err);
    }

    try {
      caches.cpiRelease = await fetchBlsCpiRelease();
      console.log(`[live] BLS CPI release period=${caches.cpiRelease.period}`);
    } catch (err) {
      caches.cpiRelease = null;
      console.warn(`[live] BLS CPI HTML failed:`, err);
    }
  } else {
    console.log(`[live] Skipping BLS HTML scrapes — API data present`);
  }

  try {
    caches.adp = await fetchAdpNational();
    console.log(
      `[live] ADP JSON change=${caches.adp.change.length} level=${caches.adp.level.length}`,
      caches.adp.change.at(-1)
    );
  } catch (err) {
    console.warn(`[live] ADP failed:`, err);
  }

  try {
    caches.dol = await fetchDolClaims();
    console.log(
      `[live] DOL claims initial=${caches.dol.initial.at(-1)?.value} continuing=${caches.dol.continuing.at(-1)?.value}`
    );
  } catch (err) {
    console.warn(`[live] DOL claims failed:`, err);
  }

  try {
    caches.gdpNow = await fetchGdpNow();
    console.log(`[live] GDPNow`, caches.gdpNow.at(-1));
  } catch (err) {
    console.warn(`[live] GDPNow failed:`, err);
  }

  try {
    caches.onsPpi = await fetchOnsPpiBulletin();
    console.log(
      `[live] ONS PPI bulletin in=${caches.onsPpi.inputYoy?.value} out=${caches.onsPpi.outputYoy?.value}`
    );
  } catch (err) {
    console.warn(`[live] ONS PPI bulletin failed:`, err);
  }

  return caches;
}

async function loadLiveRaw(
  metric: MetricDef,
  caches: LiveCaches
): Promise<{ points: RawPoint[]; note: string } | null> {
  const ref = LIVE_MAP[metric.id];
  if (!ref) {
    // Catalog native official sources
    if (metric.source === "ons") {
      await new Promise((r) => setTimeout(r, 2000));
      return {
        points: await fetchOnsSeries(metric.seriesId),
        note: "Live ONS",
      };
    }
    if (metric.source === "eurostat") {
      return {
        points: await fetchEurostatPreset(metric.seriesId),
        note: "Live Eurostat",
      };
    }
    return null;
  }

  switch (ref.provider) {
    case "bls": {
      const pts = caches.bls.get(ref.seriesId);
      if (pts?.length) {
        return { points: pts, note: `Live BLS API ${ref.seriesId}` };
      }
      // API down / empty → official release HTML
      if (caches.empsit || caches.cpiRelease) {
        const scraped = blsReleaseFallbackPoints(
          metric.id,
          caches.empsit ?? {
            nfpChange: null,
            unemployment: null,
            period: null,
          },
          caches.cpiRelease ?? null
        );
        if (scraped?.length) {
          return { points: scraped, note: `Live BLS release page (${metric.id})` };
        }
      }
      return null;
    }
    case "adp": {
      if (!caches.adp) return null;
      if (ref.seriesId === "change") {
        // Prefer explicit change series; else derive from level in persons→thousands
        if (caches.adp.change.length) {
        return { points: caches.adp.change, note: "Live ADP JSON API (change)" };
        }
        if (caches.adp.level.length >= 2) {
          const lvl = caches.adp.level.map((p) => ({
            ...p,
            value: p.value > 1_000_000 ? p.value / 1000 : p.value,
          }));
          return { points: lvl, note: "Live ADP scrape (level→diff)" };
        }
        return null;
      }
      if (ref.seriesId === "level" && caches.adp.level.length) {
        return { points: caches.adp.level, note: "Live ADP scrape (level)" };
      }
      return null;
    }
    case "dol": {
      if (!caches.dol) return null;
      if (ref.seriesId === "initial" && caches.dol.initial.length) {
        return { points: caches.dol.initial, note: "Live DOL ETA claims" };
      }
      if (ref.seriesId === "continuing" && caches.dol.continuing.length) {
        return { points: caches.dol.continuing, note: "Live DOL ETA claims" };
      }
      return null;
    }
    case "atlanta_gdpnow": {
      if (!caches.gdpNow?.length) return null;
      return { points: caches.gdpNow, note: "Live Atlanta Fed GDPNow" };
    }
    case "bea": {
      if (!process.env.BEA_API_KEY) return null;
      const [table, line] = ref.seriesId.split(":");
      const freq = metric.frequency === "monthly" ? "M" : "Q";
      const points = await fetchBeaNipa(table, line, { frequency: freq });
      return { points, note: `Live BEA ${ref.seriesId}` };
    }
    case "ons": {
      // Prefer bulletin headlines for PPI annual rates (authoritative on release day)
      if (metric.id === "uk-ppi-input-yoy" && caches.onsPpi?.inputYoy) {
        return {
          points: [caches.onsPpi.inputYoy],
          note: "Live ONS PPI bulletin (input YoY)",
        };
      }
      if (metric.id === "uk-ppi-output-yoy" && caches.onsPpi?.outputYoy) {
        return {
          points: [caches.onsPpi.outputYoy],
          note: "Live ONS PPI bulletin (output YoY)",
        };
      }
      await new Promise((r) => setTimeout(r, 400));
      return {
        points: await fetchOnsSeries(ref.seriesId),
        note: `Live ONS ${ref.seriesId}`,
      };
    }
    case "eurostat": {
      return {
        points: await fetchEurostatPreset(ref.seriesId),
        note: `Live Eurostat ${ref.seriesId}`,
      };
    }
    case "ecb": {
      const points = await fetchEcbBySeriesId(ref.seriesId);
      return { points, note: `Live ECB ${ref.seriesId}` };
    }
    case "boe": {
      const points = await fetchBoeBySeriesId(ref.seriesId);
      return { points, note: `Live BoE ${ref.seriesId}` };
    }
    default:
      return null;
  }
}

async function loadFredRaw(
  metric: MetricDef,
  fredCache: Map<string, RawPoint[]>
): Promise<RawPoint[]> {
  if (metric.source === "fred") {
    if (!fredCache.has(metric.seriesId)) {
      const result = await fetchFredSeries(metric.seriesId);
      fredCache.set(metric.seriesId, result.points);
    }
    return fredCache.get(metric.seriesId)!;
  }
  if (metric.source === "eurostat") return fetchEurostatPreset(metric.seriesId);
  if (metric.source === "ons") {
    await new Promise((r) => setTimeout(r, 2000));
    return fetchOnsSeries(metric.seriesId);
  }
  if (metric.source === "ecb") return fetchEcbBySeriesId(metric.seriesId);
  if (metric.source === "boe") return fetchBoeBySeriesId(metric.seriesId);
  throw new Error(`Unknown source ${metric.source}`);
}

async function fetchEcbBySeriesId(seriesId: string) {
  if (seriesId === "CES_HICP_1Y") return fetchEcbCesInflation1y();
  if (seriesId === "SAFE_WAGE_EXP_1Y") return fetchEcbSafeWageExpectations();
  if (seriesId in SPF_SERIES_MAP) {
    return fetchEcbSpfSeries(SPF_SERIES_MAP[seriesId as keyof typeof SPF_SERIES_MAP]);
  }
  throw new Error(`Unknown ECB series ${seriesId}`);
}

const SPF_SERIES_MAP = {
  SPF_HICP_P12M: "SPF_HICP_P12M",
  SPF_CORE_P12M: "SPF_CORE_P12M",
  SPF_HICP_LT: "SPF_HICP_LT",
  SPF_ASSU_LAB_P12M: "SPF_ASSU_LAB_P12M",
} as const satisfies Record<string, EcbSpfSeries>;

async function fetchBoeBySeriesId(seriesId: string) {
  if (seriesId === "IAS_Q2A") return fetchBoeInflationExpectations("1y");
  if (seriesId === "IAS_Q2C") return fetchBoeInflationExpectations("5y");
  if (
    seriesId === "DMP_WAGE_REALISED_3M" ||
    seriesId === "DMP_WAGE_EXPECTED_3M" ||
    seriesId === "DMP_WAGE_REALISED_1M" ||
    seriesId === "DMP_WAGE_EXPECTED_1M"
  ) {
    return fetchBoeDmpWages(seriesId);
  }
  throw new Error(`Unknown BoE series ${seriesId}`);
}

export async function runIngest(
  mode: "backfill" | "refresh",
  opts?: { metricIds?: string[] }
): Promise<IngestSummary> {
  await ensureSchema();
  await seedCatalog();

  const db = getDb();
  const startedAt = new Date().toISOString();
  await db.insert(ingestRuns).values({
    startedAt,
    mode,
    status: "running",
    metricsProcessed: 0,
    observationsUpserted: 0,
  });
  const runRow = (
    await db.select().from(ingestRuns).orderBy(desc(ingestRuns.id)).limit(1)
  )[0];
  const runId = runRow?.id ?? 0;

  const failures: IngestSummary["failures"] = [];
  let metricsProcessed = 0;
  let observationsUpserted = 0;
  let liveHits = 0;
  let fredFallbacks = 0;

  const fredCache = new Map<string, RawPoint[]>();
  const liveCaches: LiveCaches =
    mode === "refresh" || mode === "backfill"
      ? await warmLiveCaches()
      : { bls: new Map() };

  const targets = opts?.metricIds?.length
    ? METRICS.filter((m) => opts.metricIds!.includes(m.id))
    : METRICS;
  if (targets.length === 0) throw new Error("No metrics matched ingest filter");

  const results = await mapPool(targets, mode === "refresh" ? 2 : 1, async (metric) => {
    try {
      if (mode === "refresh") {
        try {
          const live = await loadLiveRaw(metric, liveCaches);
          if (live?.points.length) {
            const headline =
              live.note.includes("(change)") ||
              live.note.includes("release page") ||
              live.note.includes("PPI bulletin");
            const rss = liveCaches.rssByMetric?.get(metric.id);
            const count = await persistMetricMerge(
              metric,
              live.points,
              live.note,
              {
                treatAsLevel: headline,
                docsUrl: rss?.link ?? metric.docsUrl,
              }
            );
            return { ok: true as const, metricId: metric.id, count, via: "live" as const };
          }
        } catch (err) {
          console.warn(
            `[live] ${metric.id} failed, falling back:`,
            err instanceof Error ? err.message : err
          );
        }

        const raw = await loadFredRaw(metric, fredCache);
        // Refresh only needs the recent tip from FRED — don't re-merge full history
        const tip = raw.slice(-36);
        const count = await persistMetricMerge(
          metric,
          tip,
          "FRED/catalog fallback (recent tip)",
          { docsUrl: liveCaches.rssByMetric?.get(metric.id)?.link ?? metric.docsUrl }
        );
        return { ok: true as const, metricId: metric.id, count, via: "fred" as const };
      }

      const raw = await loadFredRaw(metric, fredCache);
      let count = await persistMetricReplace(metric, raw, "Historical backfill");
      let via: "live" | "fred" = "fred";
      try {
        const live = await loadLiveRaw(metric, liveCaches);
        if (live?.points.length) {
          const overlay = await persistMetricMerge(metric, live.points, live.note, {
            docsUrl: liveCaches.rssByMetric?.get(metric.id)?.link ?? metric.docsUrl,
          });
          count = Math.max(count, overlay);
          via = "live";
        }
      } catch {
        // optional overlay
      }
      return { ok: true as const, metricId: metric.id, count, via };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[ingest] ${metric.id}: ${message}`);
      return { ok: false as const, metricId: metric.id, error: message };
    }
  });

  for (const r of results) {
    if (r.ok) {
      metricsProcessed += 1;
      observationsUpserted += r.count;
      if (r.via === "live") liveHits += 1;
      else fredFallbacks += 1;
    } else {
      failures.push({ metricId: r.metricId, error: r.error });
    }
  }

  const finishedAt = new Date().toISOString();
  await db
    .update(ingestRuns)
    .set({
      finishedAt,
      status: failures.length && metricsProcessed === 0 ? "error" : "ok",
      metricsProcessed,
      observationsUpserted,
      error: JSON.stringify({
        liveHits,
        fredFallbacks,
        failures: failures.slice(0, 30),
      }),
    })
    .where(eq(ingestRuns.id, runId));

  return {
    runId,
    mode,
    metricsProcessed,
    observationsUpserted,
    liveHits,
    fredFallbacks,
    failures,
  };
}

/** Prefer release row for the latest observation period; ignore other periods' calendar dates. */
function pickDisplayRelease(
  rows: Array<{
    periodDate: string;
    releasedAt: string;
    notes: string | null;
    expectedValue?: number | null;
    priorPeriodValue?: number | null;
    priorPeriodDate?: string | null;
    value?: number;
  }>,
  latestPeriod: string | null
) {
  const isInvesting = (r: (typeof rows)[number]) =>
    (r.notes ?? "").includes("investing calendar:");
  const score = (r: (typeof rows)[number]) =>
    (r.expectedValue != null ? 4 : 0) +
    (isInvesting(r) ? 2 : 0) +
    (r.priorPeriodValue != null ? 1 : 0);

  if (latestPeriod) {
    const pool = rows.filter((r) => r.periodDate === latestPeriod);
    if (pool.length) {
      return [...pool].sort((a, b) => score(b) - score(a))[0];
    }
  }
  const investing = rows.find(isInvesting);
  if (investing) return investing;
  return rows[0] ?? null;
}

export async function getReleaseTape(opts?: {
  days?: number;
  region?: string;
  kind?: "all" | "data" | "speakers" | "policy";
  forwardOnly?: boolean;
}) {
  await ensureSchema();
  const db = getDb();
  const days = opts?.days ?? 7;
  const now = new Date();
  const forwardOnly = opts?.forwardOnly !== false;
  const start = forwardOnly ? now : utcDayStart(now);
  const end = addUtcDays(start, days);

  const rows = await db
    .select({
      releasedAt: calendarEvents.releasedAt,
      periodDate: calendarEvents.periodDate,
      periodLabel: calendarEvents.periodLabel,
      eventName: calendarEvents.eventName,
      country: calendarEvents.country,
      currency: calendarEvents.currency,
      actual: calendarEvents.actual,
      forecast: calendarEvents.forecast,
      previous: calendarEvents.previous,
      rawActual: calendarEvents.rawActual,
      rawForecast: calendarEvents.rawForecast,
      rawPrevious: calendarEvents.rawPrevious,
      importance: calendarEvents.importance,
      metricId: calendarEvents.metricId,
      shortName: metrics.shortName,
      unit: metrics.unit,
      region: metrics.region,
      category: metrics.category,
    })
    .from(calendarEvents)
    .leftJoin(metrics, eq(metrics.id, calendarEvents.metricId))
    .where(
      and(
        gte(calendarEvents.releasedAt, start.toISOString()),
        lt(calendarEvents.releasedAt, end.toISOString())
      )
    )
    .orderBy(calendarEvents.releasedAt)
    .limit(800);

  const regionFilter = opts?.region ?? "ALL";
  const kindFilter = opts?.kind ?? "all";

  const filtered = dedupeCalendarRows(rows).filter((r) => {
    const tapeRegion = calendarCountryToRegion(r.country);
    if (regionFilter !== "ALL" && tapeRegion !== regionFilter) return false;

    const eventKind = classifyCalendarEvent(r.eventName);
    if (kindFilter === "data" && eventKind !== "data") return false;
    if (kindFilter === "speakers" && eventKind !== "speaker") return false;
    if (kindFilter === "policy" && eventKind !== "policy") return false;

    // Hide low-signal auctions unless viewing all
    if (kindFilter === "all" && eventKind === "auction") return false;
    return true;
  });

  const events = filtered.map((r) => {
    const scale = r.metricId ? investingToCatalogScale(r.metricId) : 1;
    const scaleVal = (v: number | null) =>
      v != null && Number.isFinite(v) ? round(v * scale) : null;
    const eventKind = classifyCalendarEvent(r.eventName);
    const tapeRegion = calendarCountryToRegion(r.country);
    const forecast = scaleVal(r.forecast);
    const actual = scaleVal(r.actual);
    const previous = scaleVal(r.previous);
    const status = actual != null ? "released" : "upcoming";

    return {
      releasedAt: r.releasedAt,
      periodDate: r.periodDate,
      periodLabel: r.periodLabel,
      eventName: r.eventName,
      country: r.country,
      currency: r.currency,
      metricId: r.metricId,
      shortName: r.shortName,
      unit: r.unit,
      region: r.region ?? tapeRegion,
      tapeRegion,
      category: r.category,
      importance: r.importance,
      eventKind,
      speakerInstitution: eventKind === "speaker" ? speakerInstitution(r.eventName) : null,
      actual,
      forecast,
      previous,
      rawActual: r.rawActual,
      rawForecast: r.rawForecast,
      rawPrevious: r.rawPrevious,
      status,
      hasForecast: forecast != null || Boolean(r.rawForecast?.trim()),
    };
  });

  const maxRow = await db
    .select({ maxAt: calendarEvents.releasedAt })
    .from(calendarEvents)
    .orderBy(desc(calendarEvents.releasedAt))
    .limit(1);

  const windowDays = Array.from({ length: days }, (_, i) => {
    const d = addUtcDays(utcDayStart(start), i);
    return d.toISOString().slice(0, 10);
  });

  return {
    events,
    meta: {
      from: start.toISOString(),
      to: end.toISOString(),
      days,
      forwardOnly,
      dataThrough: maxRow[0]?.maxAt ?? null,
      total: events.length,
      withForecast: events.filter((e) => e.hasForecast).length,
      speakers: events.filter((e) => e.eventKind === "speaker").length,
      windowDays,
    },
  };
}

/** @deprecated use getReleaseTape */
export async function getUpcomingCalendar(opts?: { days?: number; region?: string }) {
  const tape = await getReleaseTape({ ...opts, kind: "data", forwardOnly: false });
  return tape.events.filter((e) => e.metricId);
}

export async function getDashboardData(filters?: {
  region?: string;
  category?: string;
}) {
  await ensureSchema();
  const db = getDb();
  const allMetrics = await db.select().from(metrics);

  const filtered = allMetrics.filter((m) => {
    if (filters?.region && filters.region !== "ALL" && m.region !== filters.region) return false;
    if (filters?.category && filters.category !== "ALL" && m.category !== filters.category)
      return false;
    return true;
  });

  const cards = [];
  for (const m of filtered) {
    const latestRows = await db
      .select()
      .from(observations)
      .where(eq(observations.metricId, m.id))
      .orderBy(desc(observations.date))
      .limit(2);

    const latest = latestRows[0];
    const prior = latestRows[1];
    const releaseRows = await db
      .select()
      .from(releases)
      .where(eq(releases.metricId, m.id))
      .orderBy(desc(releases.periodDate))
      .limit(24);
    const displayRelease = pickDisplayRelease(releaseRows, latest?.date ?? null);
    const release = releaseRows[0] ?? null;
    const expectedValue = displayRelease?.expectedValue ?? null;
    const actualValue = latest?.value ?? displayRelease?.value ?? null;
    const surprise = computeSurprise(actualValue, expectedValue, m.unit);

    const live = LIVE_MAP[m.id];

    cards.push({
      id: m.id,
      region: m.region,
      category: m.category,
      subcategory: m.subcategory,
      name: m.name,
      shortName: m.shortName,
      unit: m.unit,
      frequency: m.frequency,
      importance: m.importance,
      officialUrl: m.officialUrl,
      docsUrl: m.docsUrl,
      releaseName: m.releaseName,
      earliestAvailable: m.earliestAvailable,
      observationCount: m.observationCount,
      lastIngestedAt: m.lastIngestedAt,
      liveProvider: live?.provider ?? (m.source === "fred" ? "fred-lagged" : m.source),
      feedNote: release?.notes ?? null,
      latest: latest ? { date: latest.date, value: latest.value } : null,
      prior: prior ? { date: prior.date, value: prior.value } : null,
      delta: latest && prior ? round(latest.value - prior.value) : null,
      release,
      displayReleasedAt: displayRelease?.releasedAt ?? null,
      expectedValue,
      surprise,
      priorPeriodValue: displayRelease?.priorPeriodValue ?? null,
      periodLabel: displayRelease?.periodDate ?? latest?.date ?? null,
    });
  }

  const importanceRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    supporting: 3,
  };
  cards.sort(
    (a, b) =>
      (importanceRank[a.importance] ?? 9) - (importanceRank[b.importance] ?? 9) ||
      a.region.localeCompare(b.region) ||
      a.name.localeCompare(b.name)
  );

  const lastRun = (
    await db.select().from(ingestRuns).orderBy(desc(ingestRuns.id)).limit(1)
  )[0];
  const handles = await db.select().from(sourceHandles);

  return { cards, lastRun, handles, totalMetrics: allMetrics.length };
}

export async function getSeriesHistory(metricId: string, limit = 240) {
  const db = getDb();
  const meta = (await db.select().from(metrics).where(eq(metrics.id, metricId)))[0];
  if (!meta) return null;

  const rows = await db
    .select()
    .from(observations)
    .where(eq(observations.metricId, metricId))
    .orderBy(desc(observations.date))
    .limit(limit);

  const history = rows.reverse();
  const releaseRows = await db
    .select()
    .from(releases)
    .where(eq(releases.metricId, metricId))
    .orderBy(desc(releases.releasedAt))
    .limit(48);

  const byPeriod = new Map<string, (typeof releaseRows)[number]>();
  for (const row of releaseRows) {
    const key = row.periodDate;
    const cur = byPeriod.get(key);
    const score = (r: (typeof releaseRows)[number]) =>
      (r.expectedValue != null ? 4 : 0) +
      (r.priorPeriodValue != null ? 2 : 0) +
      (r.priorReleaseValue != null ? 1 : 0);
    if (!cur || score(row) >= score(cur)) byPeriod.set(key, row);
  }
  const releasesDeduped = [...byPeriod.values()].sort((a, b) =>
    b.releasedAt.localeCompare(a.releasedAt)
  ).slice(0, 12);
  const latestPeriod = history[history.length - 1]?.date ?? null;
  const displayRelease = pickDisplayRelease(releasesDeduped, latestPeriod);
  const expectedValue = displayRelease?.expectedValue ?? null;
  const actualValue = latestPeriod
    ? (history[history.length - 1]?.value ?? displayRelease?.value ?? null)
    : null;
  const surprise = computeSurprise(actualValue, expectedValue, meta.unit);

  return {
    meta: {
      ...meta,
      liveProvider: LIVE_MAP[metricId]?.provider ?? meta.source,
    },
    history,
    releases: releasesDeduped,
    displayReleasedAt: displayRelease?.releasedAt ?? null,
    expectedValue,
    surprise,
    priorPeriodValue: displayRelease?.priorPeriodValue ?? null,
    priorPeriodDate: displayRelease?.priorPeriodDate ?? null,
  };
}

function buildMatrixColumns(months: number): string[] {
  const now = new Date();
  const cols: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    cols.push(`${y}-${m}-01`);
  }
  return cols;
}

function resolveColumnRule(
  row: { columnRule?: ColumnRule; columnRuleByRegion?: Partial<Record<DeskRegion, ColumnRule>>; surveyMonths?: number[] },
  region: DeskRegion
): { rule: ColumnRule; surveyMonths?: number[] } {
  const rule = row.columnRuleByRegion?.[region] ?? row.columnRule ?? "monthly";
  return { rule, surveyMonths: row.surveyMonths };
}

export async function getDeskMatrixData(opts?: { months?: number }) {
  await ensureSchema();
  const db = getDb();
  const months = opts?.months ?? 12;
  const columns = buildMatrixColumns(months);
  const start = columns[0];
  const metricIds = allDeskMatrixMetricIds();
  const metricMap = new Map(METRICS.filter((m) => metricIds.includes(m.id)).map((m) => [m.id, m]));

  const obsRows = await db
    .select({
      metricId: observations.metricId,
      date: observations.date,
      value: observations.value,
    })
    .from(observations)
    .where(and(inArray(observations.metricId, metricIds), gte(observations.date, start)));

  const releaseRows = await db
    .select({
      metricId: releases.metricId,
      periodDate: releases.periodDate,
      expectedValue: releases.expectedValue,
    })
    .from(releases)
    .where(
      and(inArray(releases.metricId, metricIds), gte(releases.periodDate, start))
    );

  const actualByMetric = new Map<string, Map<string, number>>();
  for (const row of obsRows) {
    const meta = metricMap.get(row.metricId);
    if (!actualByMetric.has(row.metricId)) actualByMetric.set(row.metricId, new Map());
    const bucket = actualByMetric.get(row.metricId)!;
    bucket.set(row.date, row.value);
    if (meta?.frequency === "quarterly") {
      bucket.set(toQuarterEndPeriod(row.date), row.value);
    }
  }

  const expectedByMetric = new Map<string, Map<string, number>>();
  for (const row of releaseRows) {
    if (row.expectedValue == null) continue;
    const meta = metricMap.get(row.metricId);
    if (!expectedByMetric.has(row.metricId)) expectedByMetric.set(row.metricId, new Map());
    const bucket = expectedByMetric.get(row.metricId)!;
    bucket.set(row.periodDate, row.expectedValue);
    if (meta?.frequency === "quarterly") {
      bucket.set(toQuarterEndPeriod(row.periodDate), row.expectedValue);
    }
  }

  const blocks = DESK_MATRIX_BLOCKS.map((block) => ({
    id: block.id,
    title: block.title,
    subblocks: block.subblocks.map((sub) => ({
      id: sub.id,
      title: sub.title,
      rows: sub.rows.flatMap((rowDef) => {
        const regions: DeskRegion[] = rowDef.onlyRegion
          ? [rowDef.onlyRegion]
          : ["US", "UK", "EA"];
        return regions.map((region) => {
          const metricId = rowDef[region.toLowerCase() as "us" | "uk" | "ea"];
          const meta = metricMap.get(metricId);
          const { rule, surveyMonths } = resolveColumnRule(rowDef, region);
          const actuals = actualByMetric.get(metricId) ?? new Map();
          const expected = expectedByMetric.get(metricId) ?? new Map();
          const unit = meta?.unit ?? "number";

          const cells = columns.map((period) => {
            if (!cellAllowed(period, rule, surveyMonths)) {
              return { period, actual: null, expected: null };
            }
            const lookup =
              rule === "quarter" ? toQuarterEndPeriod(period) : period;
            const actual = actuals.get(lookup) ?? null;
            const exp = expected.get(lookup) ?? null;
            return { period, actual, expected: exp };
          });

          return {
            rowId: rowDef.id,
            rowLabel: rowDef.label,
            region,
            metricId,
            shortName: meta?.shortName ?? metricId,
            unit,
            cells,
          };
        });
      }),
    })),
  }));

  return {
    columns,
    blocks,
    meta: { months, metricCount: metricIds.length },
  };
}

function lookbackStart(period: string, extraMonths: number): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - extraMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function stepMonthsForPeriodsPerYear(periodsPerYear: number): number {
  return periodsPerYear === 4 ? 3 : 1;
}

function computeSmoothedValue(
  method: SmoothMethod,
  seriesMap: Map<string, SeriesPoint>,
  anchorPeriod: string,
  periodsPerYear = 12
): number | null {
  const step = stepMonthsForPeriodsPerYear(periodsPerYear);

  if (method === "ma3") {
    const win = windowEndingAt(seriesMap, anchorPeriod, 3, step);
    if (!win) return null;
    const avg = movingAverage3(win.map((p) => p.value));
    return avg == null ? null : roundSmooth(avg);
  }
  if (method === "ann3m_mom") {
    const win = windowEndingAt(seriesMap, anchorPeriod, 3, step);
    if (!win) return null;
    const ann = annualized3mFromMom(win.map((p) => p.value), { periodsPerYear });
    return ann == null ? null : roundSmooth(ann);
  }
  if (method === "ann3m_index") {
    const win = windowEndingAt(seriesMap, anchorPeriod, 4, step);
    if (!win) return null;
    const ann = annualized3mFromIndex(win.map(indexLevel));
    return ann == null ? null : roundSmooth(ann);
  }
  return null;
}

export async function getDeskSmoothedData(opts?: { months?: number }) {
  await ensureSchema();
  const db = getDb();
  const months = opts?.months ?? 12;
  const columns = buildMatrixColumns(months);
  const start = columns[0]!;
  const lookback = lookbackStart(start, 8);
  const metricIds = allDeskSmoothedMetricIds();
  const metricMap = new Map(METRICS.filter((m) => metricIds.includes(m.id)).map((m) => [m.id, m]));

  const obsRows = await db
    .select({
      metricId: observations.metricId,
      date: observations.date,
      value: observations.value,
      rawValue: observations.rawValue,
    })
    .from(observations)
    .where(and(inArray(observations.metricId, metricIds), gte(observations.date, lookback)));

  const seriesMapsByMetric = new Map<string, Map<string, SeriesPoint>>();
  for (const row of obsRows) {
    const meta = metricMap.get(row.metricId);
    const point: SeriesPoint = {
      date: row.date,
      value: row.value,
      rawValue: row.rawValue,
    };

    if (!seriesMapsByMetric.has(row.metricId)) seriesMapsByMetric.set(row.metricId, new Map());
    const map = seriesMapsByMetric.get(row.metricId)!;
    map.set(row.date, point);
    if (meta?.frequency === "quarterly") {
      map.set(toQuarterEndPeriod(row.date), point);
    }
  }

  const blocks = DESK_SMOOTHED_ROWS.map((rowDef) => {
    const regions: DeskRegion[] = ["US", "UK", "EA"];
    const method = rowDef.method;
    const rows = regions.map((region) => {
      const metricId = rowDef[region.toLowerCase() as "us" | "uk" | "ea"];
      const meta = metricMap.get(metricId);
      const { rule } = resolveColumnRule(rowDef, region);
      const rowMethod = rowDef.methodByRegion?.[region] ?? method;
      const periodsPerYear = rowDef.periodsPerYearByRegion?.[region] ?? 12;
      const seriesMap = seriesMapsByMetric.get(metricId) ?? new Map();

      const cells = columns.map((period) => {
        if (!cellAllowed(period, rule)) {
          return { period, value: null };
        }
        const lookup = rule === "quarter" ? toQuarterEndPeriod(period) : period;
        const value = computeSmoothedValue(rowMethod, seriesMap, lookup, periodsPerYear);
        return { period, value };
      });

      return {
        rowId: rowDef.id,
        rowLabel: rowDef.label,
        method: rowMethod,
        methodLabel: SMOOTH_METHOD_SHORT[rowMethod],
        region,
        metricId,
        shortName: meta?.shortName ?? metricId,
        unit: meta?.unit ?? "percent",
        cells,
      };
    });

    return {
      id: rowDef.id,
      title: rowDef.label,
      method,
      methodLabel: SMOOTH_METHOD_SHORT[method],
      note: rowDef.note ?? null,
      rows,
    };
  });

  const rows = blocks.flatMap((b) => b.rows);

  return {
    columns,
    blocks,
    rows,
    methods: SMOOTH_METHOD_LABELS,
    meta: { months, metricCount: metricIds.length },
  };
}

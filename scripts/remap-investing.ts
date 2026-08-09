/**
 * Remap calendar_events.metric_id with tightened Investing→catalog rules.
 * Does NOT change actual / forecast / previous / event_name (raw Investing intact).
 * Rebuilds Investing-sourced releases with catalog unit scales (e.g. NFP ÷1000).
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { getClient } from "../src/db";
import {
  investingToCatalogScale,
  mapInvestingEvent,
} from "../src/catalog/investing-map";
import { ensureSchema, seedCatalog } from "../src/ingest/pipeline";

interface RematchStats {
  scanned: number;
  unchanged: number;
  remapped: number;
  unmapped: number;
  newlyMapped: number;
  byMetric: Record<string, number>;
  examples: Array<{
    event: string;
    country: string;
    from: string | null;
    to: string | null;
  }>;
}

async function rematchCalendarEvents(): Promise<RematchStats> {
  const client = getClient();
  const res = await client.execute(
    `SELECT id, country, currency, event_name, metric_id
     FROM calendar_events
     WHERE source = 'investing'`
  );

  const stats: RematchStats = {
    scanned: res.rows.length,
    unchanged: 0,
    remapped: 0,
    unmapped: 0,
    newlyMapped: 0,
    byMetric: {},
    examples: [],
  };

  for (const row of res.rows) {
    const id = Number(row.id);
    const eventName = String(row.event_name);
    const country = String(row.country);
    const currency = row.currency == null ? null : String(row.currency);
    const prev = row.metric_id == null ? null : String(row.metric_id);
    const next = mapInvestingEvent({ eventName, currency, country });

    if (next === prev) {
      stats.unchanged += 1;
      if (next) stats.byMetric[next] = (stats.byMetric[next] ?? 0) + 1;
      continue;
    }

    await client.execute({
      sql: `UPDATE calendar_events SET metric_id = ? WHERE id = ?`,
      args: [next, id],
    });

    if (!prev && next) stats.newlyMapped += 1;
    else if (prev && !next) stats.unmapped += 1;
    else stats.remapped += 1;

    if (next) stats.byMetric[next] = (stats.byMetric[next] ?? 0) + 1;

    if (stats.examples.length < 40) {
      stats.examples.push({ event: eventName, country, from: prev, to: next });
    }
  }

  return stats;
}

async function rebuildInvestingReleases(): Promise<{ deleted: number; inserted: number }> {
  const client = getClient();

  // Remove prior Investing promotions only (notes prefix). Official pipeline releases stay.
  const del = await client.execute({
    sql: `DELETE FROM releases WHERE notes LIKE ?`,
    args: ["investing calendar:%"],
  });

  const mapped = await client.execute(
    `SELECT metric_id, period_date, released_at, actual, forecast, previous, event_name
     FROM calendar_events
     WHERE source = 'investing'
       AND metric_id IS NOT NULL
       AND actual IS NOT NULL
       AND period_date IS NOT NULL`
  );

  let inserted = 0;
  for (const row of mapped.rows) {
    const metricId = String(row.metric_id);
    const scale = investingToCatalogScale(metricId);
    const actual = Number(row.actual) * scale;
    const forecast = row.forecast == null ? null : Number(row.forecast) * scale;
    const previous = row.previous == null ? null : Number(row.previous) * scale;
    const change =
      previous != null ? Math.round((actual - previous) * 1e6) / 1e6 : null;

    await client.execute({
      sql: `INSERT INTO releases (
              metric_id, period_date, released_at, value, expected_value,
              prior_period_value, change_vs_prior_period, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(metric_id, period_date, released_at) DO UPDATE SET
              value=excluded.value,
              expected_value=excluded.expected_value,
              prior_period_value=excluded.prior_period_value,
              change_vs_prior_period=excluded.change_vs_prior_period,
              notes=excluded.notes`,
      args: [
        metricId,
        String(row.period_date),
        String(row.released_at),
        actual,
        forecast,
        previous,
        change,
        `investing calendar: ${String(row.event_name)}`,
      ],
    });
    inserted += 1;
  }

  return { deleted: Number(del.rowsAffected ?? 0), inserted };
}

async function main() {
  await ensureSchema();
  await seedCatalog();

  console.log("Rematching calendar_events.metric_id (raw values untouched)…");
  const rematch = await rematchCalendarEvents();
  console.log("Rebuilding Investing releases with catalog scales…");
  const releases = await rebuildInvestingReleases();

  const outDir = path.join(process.cwd(), "data", "investing", "surprise");
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    note: "Remap only metric_id on calendar_events; actual/forecast/previous unchanged. Releases rebuilt with scales.",
    rematch,
    releases,
  };
  const outPath = path.join(outDir, "remap-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        rematch: {
          scanned: rematch.scanned,
          unchanged: rematch.unchanged,
          remapped: rematch.remapped,
          newlyMapped: rematch.newlyMapped,
          unmapped: rematch.unmapped,
          topMetrics: Object.entries(rematch.byMetric)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15),
        },
        releases,
        wrote: outPath,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

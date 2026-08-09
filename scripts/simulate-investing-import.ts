/**
 * End-to-end: import sample Investing dump (times as BST) and verify
 * UTC conversion + calendar_events → releases promotion.
 */
import "dotenv/config";
import path from "path";
import { getClient } from "../src/db";
import { ensureSchema, seedCatalog } from "../src/ingest/pipeline";
import {
  importInvestingDumpFiles,
  parseUtcOffsetMinutes,
  toIsoUtc,
} from "../src/ingest/investing-calendar";

const EXPECTED_UTC: Array<{
  event: string;
  bst: string;
  utc: string;
  metricId: string | null;
}> = [
  { event: "CPI (YoY) (May)", bst: "2025-06-11 13:30", utc: "2025-06-11T12:30:00.000Z", metricId: "us-cpi-yoy" },
  { event: "CPI (MoM) (May)", bst: "2025-06-11 13:30", utc: "2025-06-11T12:30:00.000Z", metricId: "us-cpi-mom" },
  { event: "Nonfarm Payrolls (May)", bst: "2025-06-06 13:30", utc: "2025-06-06T12:30:00.000Z", metricId: "us-nfp" },
  { event: "CPI (YoY) (May)", bst: "2025-06-18 07:00", utc: "2025-06-18T06:00:00.000Z", metricId: "uk-cpi-yoy" },
  { event: "CPI (YoY) (May)", bst: "2025-06-03 10:00", utc: "2025-06-03T09:00:00.000Z", metricId: "ea-hicp-yoy" },
  { event: "S&P Global Manufacturing PMI (May)", bst: "2025-06-02 00:30", utc: "2025-06-01T23:30:00.000Z", metricId: null },
];

async function main() {
  console.log("── Investing calendar E2E (timezone = BST) ──\n");

  const bstOffset = parseUtcOffsetMinutes("BST");
  console.log(`BST offset minutes east of UTC: ${bstOffset} (expect 60)`);
  if (bstOffset !== 60) throw new Error("BST offset parse failed");

  // Unit-check converter before DB
  const unitChecks: string[] = [];
  for (const row of EXPECTED_UTC) {
    const [date, time] = row.bst.split(" ");
    const got = toIsoUtc(date, time, "BST");
    if (got !== row.utc) {
      unitChecks.push(`toIsoUtc(${row.bst}): got ${got}, want ${row.utc}`);
    }
  }
  if (unitChecks.length) {
    console.error(unitChecks.join("\n"));
    throw new Error("BST→UTC unit checks failed");
  }
  console.log("BST→UTC unit checks: OK\n");

  await ensureSchema();
  await seedCatalog();

  const client = getClient();
  // Clear prior sample imports (e.g. old timezone) so the run is deterministic
  await client.execute({
    sql: `DELETE FROM releases WHERE notes LIKE 'investing calendar:%' AND released_at LIKE '2025-06%'`,
  });
  await client.execute({
    sql: `DELETE FROM calendar_events WHERE dump_file = ? OR (source = 'investing' AND released_at LIKE '2025-06%')`,
    args: ["sample-2025-06.json"],
  });

  const sample = path.join(process.cwd(), "data", "investing", "sample-2025-06.json");
  const summary = await importInvestingDumpFiles(sample);
  console.log("Import summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log();

  const cal = await client.execute({
    sql: `SELECT country, currency, event_name, released_at, period_date,
                 actual, forecast, previous, metric_id
          FROM calendar_events
          WHERE dump_file = ?
          ORDER BY released_at, event_name`,
    args: ["sample-2025-06.json"],
  });

  console.log("calendar_events (BST wall → stored UTC):");
  console.table(
    cal.rows.map((r) => ({
      country: r.country,
      event: r.event_name,
      released_at_utc: r.released_at,
      period: r.period_date,
      actual: r.actual,
      forecast: r.forecast,
      previous: r.previous,
      metric_id: r.metric_id,
    }))
  );

  const rel = await client.execute({
    sql: `SELECT metric_id, period_date, released_at, value, expected_value, prior_period_value, notes
          FROM releases
          WHERE notes LIKE 'investing calendar:%'
            AND released_at LIKE '2025-06%'
          ORDER BY released_at, metric_id`,
  });

  console.log("\nreleases (promoted from mapped actuals):");
  console.table(
    rel.rows.map((r) => ({
      metric_id: r.metric_id,
      period: r.period_date,
      released_at_utc: r.released_at,
      actual: r.value,
      expected: r.expected_value,
      previous: r.prior_period_value,
    }))
  );

  // Assert UTC stamps match expectations for mapped rows
  const failures: string[] = [];
  for (const exp of EXPECTED_UTC) {
    if (!exp.metricId) continue;
    const hit = cal.rows.find(
      (r) =>
        String(r.metric_id) === exp.metricId &&
        String(r.released_at) === exp.utc &&
        String(r.event_name) === exp.event
    );
    if (!hit) {
      failures.push(
        `missing calendar row ${exp.metricId} @ ${exp.utc} (${exp.event}, BST ${exp.bst})`
      );
    }
  }

  if (summary.mapped !== 5 || summary.unmapped !== 1 || summary.releasedUpserted !== 5) {
    failures.push(
      `counts: mapped=${summary.mapped} unmapped=${summary.unmapped} releases=${summary.releasedUpserted} (want 5/1/5)`
    );
  }

  // Spot-check values
  const nfp = rel.rows.find((r) => r.metric_id === "us-nfp");
  if (!nfp || Number(nfp.value) !== 139000 || Number(nfp.expected_value) !== 130000) {
    failures.push(`us-nfp values unexpected: ${JSON.stringify(nfp)}`);
  }
  const uk = rel.rows.find((r) => r.metric_id === "uk-cpi-yoy");
  if (!uk || Number(uk.value) !== 3.4 || Number(uk.expected_value) !== 3.3) {
    failures.push(`uk-cpi-yoy values unexpected: ${JSON.stringify(uk)}`);
  }

  if (failures.length) {
    console.error("\nE2E FAILURES:");
    for (const f of failures) console.error(" -", f);
    process.exitCode = 1;
    return;
  }

  console.log("\nE2E OK — BST times converted to UTC, mapped into releases.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

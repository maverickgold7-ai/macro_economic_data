import "dotenv/config";
import { METRICS } from "../src/catalog/metrics";
import { runIngest } from "../src/ingest/pipeline";

async function main() {
  const mode = (process.argv[2] as "backfill" | "refresh") || "backfill";
  const filterArg = process.argv[3]; // e.g. "uk-" or "uk-cpi-mom,uk-core-cpi-mom"
  let metricIds: string[] | undefined;
  if (filterArg) {
    if (filterArg.includes(",")) {
      metricIds = filterArg.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      metricIds = METRICS.filter((m) => m.id.includes(filterArg)).map((m) => m.id);
    }
    console.log(`Filter → ${metricIds.length} metrics: ${metricIds.join(", ")}`);
  }
  console.log(`Starting ${mode}…`);
  const summary = await runIngest(mode, { metricIds });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.metricsProcessed === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

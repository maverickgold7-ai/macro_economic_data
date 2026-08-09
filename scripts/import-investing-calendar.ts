import "dotenv/config";
import path from "path";
import { ensureSchema, seedCatalog } from "../src/ingest/pipeline";
import { importInvestingDumpFiles } from "../src/ingest/investing-calendar";

async function main() {
  const arg = process.argv[2];
  const target = arg
    ? path.resolve(arg)
    : path.join(process.cwd(), "data", "investing");

  await ensureSchema();
  await seedCatalog();

  console.log(`Importing Investing calendar dumps from ${target}…`);
  const summary = await importInvestingDumpFiles(target);
  console.log(JSON.stringify(summary, null, 2));

  if (summary.errors.length) {
    console.error(`\n${summary.errors.length} error(s)`);
    process.exitCode = 1;
  }
  if (summary.files === 0) {
    console.error("No JSON dumps found. Drop month files into data/investing/ (see sample).");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

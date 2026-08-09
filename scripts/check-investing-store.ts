import { getClient } from "../src/db";

async function main() {
  const c = getClient();
  const calendar = await c.execute("SELECT COUNT(*) AS n FROM calendar_events");
  const releases = await c.execute({
    sql: "SELECT COUNT(*) AS n FROM releases WHERE notes LIKE ?",
    args: ["investing%"],
  });
  const range = await c.execute(
    "SELECT MIN(released_at) AS mn, MAX(released_at) AS mx FROM calendar_events"
  );
  const byCountry = await c.execute(
    "SELECT country, COUNT(*) AS n FROM calendar_events GROUP BY country ORDER BY n DESC"
  );
  console.log(
    JSON.stringify(
      {
        calendar_events: calendar.rows[0],
        investing_releases: releases.rows[0],
        released_at_range: range.rows[0],
        by_country: byCountry.rows,
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

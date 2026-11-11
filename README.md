# Macro Economy Tracker

Fast, accurate tracker for **US**, **UK**, and **Euro Area** inflation, growth, and jobs metrics — including surveys, expectations, PMI, wages/ECI, and supporting release documents.

## What it does

- Catalogues headline **and** supporting series (CPI/PCE/HICP, trimmed means, consumer & market expectations, ISM/S&P PMI, ECI/AWE/wages, JOLTS, claims, GDP/GDPNow, retail, IP, etc.)
- **Backfills** each series to the earliest available observation (via FRED CSV/API, Eurostat, ONS)
- Stores history in local **SQLite** (LibSQL) for fast dashboard reads
- Shows **latest vs prior period** on every metric, with links to official bulletins
- Supports on-demand / scheduled **refresh** so new prints land quickly

## Quick start

```bash
npm install
cp .env.example .env        # .env is read by both the app and the CLI scripts
npm test                    # calculation tests
npm run backfill            # full history (first run)
npm run dev                 # http://localhost:3000
```

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run backfill` | Full historical ingest for all catalogued metrics |
| `npm run refresh` | Incremental refresh: live agency sources first, FRED/catalog tip as fallback |
| `npm run backfill -- uk-` / `npm run refresh -- us-cpi,us-nfp` | Limit to metrics whose id contains a string, or an explicit list |
| `npm test` | Transforms, smoothing, surprise tone, consensus scaling, country mapping |
| `npm run dev` / `build` / `start` | Next.js dashboard |
| `npm run import:investing` / `capture:investing` / `audit:surprise` | Investing.com calendar (consensus) import, capture, and surprise audit |

## Configuration (`.env`)

| Variable | Required | Purpose |
|---|---|---|
| `REFRESH_SECRET` | for `/api/refresh` | Shared secret; the endpoint returns 503 until it is set (there is no default) |
| `FRED_API_KEY`, `BLS_API_KEY`, `BEA_API_KEY` | optional | API access; public CSV/scrape fallbacks otherwise (BEA needs its key) |
| `INGEST_FETCH_TIMEOUT_MS` | optional | Per-request timeout, default 30000 |
| `INGEST_ALLOW_SHRINK` | optional | `1` allows a backfill that would shrink stored history by more than 10% |

## Refresh API (cron)

```bash
# incremental refresh (GET is refresh-only)
curl -s "http://localhost:3000/api/refresh?secret=$REFRESH_SECRET"

# full backfill: POST with the secret in a header
curl -s -X POST -H "x-refresh-secret: $REFRESH_SECRET" -H "content-type: application/json" \
  -d '{"mode":"backfill"}' http://localhost:3000/api/refresh
```

Responses: `200` with a run summary, `401` wrong secret, `409` another run is in progress,
`503` secret not configured.

## How the ingest protects the data

- **One run at a time:** `ingest_runs` is the lock. A run stuck as `running` for more than 30 minutes is marked `abandoned`.
- **Run status:**
  - `ok`: every metric succeeded
  - `partial`: some metrics failed (listed in the run's `error` field)
  - `error`: nothing succeeded, or the run crashed
- **Atomic writes:** each metric's delete, insert and metadata update run in one transaction.
- **Shrink guard:** a backfill that would shrink stored history by more than 10% is refused, which covers truncated source responses.
- **Timeouts:** every HTTP request has one.
- **Revisions are kept:** when an ingest changes a stored value, `observation_revisions` records the old and new value, the time and the source.
- **`released_at`** on a release row is the Investing.com calendar time when that calendar supplied the row. Otherwise it is the time the ingest first stored the period, not the official release time.

## Calculation conventions

| Item | Rule |
|---|---|
| YoY | Same month/quarter one year earlier (±3 days for weekly/daily); no value if it is missing |
| MoM / QoQ / diff | Immediately preceding period only; a gap gives no value (never a change over two periods) |
| Desk "3m/3m ann." | Monthly: 3 MoM prints compounded, ^4. Quarterly: latest QoQ, ^4 (one quarter = 3 months) |
| Desk "3m avg" | Mean of 3 monthly prints. UK ILO unemployment (already a 3-month average) shown as published. EA employment: latest quarterly change / 3 |
| Surprise | Actual − consensus, in catalog units (Investing values rescaled per metric, e.g. NFP thousands, claims persons) |
| Surprise tone | Rates reading: **hawkish** = higher inflation/activity or lower unemployment/claims than expected; **dovish** = the opposite |
| Calendar country | Taken from the country field; currency alone maps USD→US, GBP→UK. EUR alone is not mapped (it could be any member state) |

## Data sources

### Live (release-day) — preferred on `npm run refresh`
- **BLS Public API** — NFP, unemployment, CPI, PPI, JOLTS, ECI, AHE
- **DOL ETA** — initial / continuing claims (scraped / CSV)
- **ADP** — National Employment Report (site scrape)
- **Atlanta Fed** — GDPNow page
- **BEA API** — GDP / PCE (requires `BEA_API_KEY`)
- **ONS** — UK CPIH, AWE, vacancies, GDP
- **Eurostat** — EA HICP and related

### Historical backfill — `npm run backfill`
- **FRED** (and ONS/Eurostat history) for deep history to earliest observation
- Live tip is then overlaid so the latest print is not stuck on FRED lag

> FRED alone is **not** used for release-day freshness — it often lags official agencies by hours to a day.

## X / release-signal handles

Seeded in the app (official + market voices): `@BLS_gov`, `@BEA_News`, `@AtlantaFed`, `@NewYorkFed`, `@ONS`, `@bankofengland`, `@ecb`, `@EU_Eurostat`, `@S_PGlobalPMI`, `@NickTimiraos`, and others.

## Project layout

```
src/catalog/metrics.ts   # full metric universe
src/ingest/              # source fetchers + pipeline (persist, revisions, run lock)
src/lib/                 # transforms helpers, smoothing, surprise, http timeouts
src/db/                  # SQLite schema
src/app/                 # dashboard + API
scripts/ingest.ts        # CLI backfill/refresh
tests/                   # node:test suites (npm test)
```

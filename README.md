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
cp .env.example .env.local
# optional: add FRED_API_KEY from https://fred.stlouisfed.org/docs/api/api_key.html

npm run backfill
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run backfill` | Full historical ingest for all catalogued metrics |
| `npm run refresh` | Incremental refresh (same pipeline, latest data) |
| `npm run dev` | Next.js dashboard |
| `GET /api/refresh?secret=...&mode=refresh` | Cron-friendly refresh endpoint |

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
src/ingest/              # FRED / Eurostat / ONS + pipeline
src/db/                  # SQLite schema
src/app/                 # dashboard + API
scripts/ingest.ts        # CLI backfill/refresh
```

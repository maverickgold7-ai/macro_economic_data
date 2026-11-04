# CLAUDE.md: macro_economic_data (macro economy tracker)

Instructions for Claude Code working in this repository. The README has the full details.

## What it is
- Local-first Next.js 15 + SQLite (LibSQL) dashboard for US, UK and euro-area inflation, growth and jobs.
- Data lives in `data/macro.db`.
- The sibling repo `../rolls` reads its release calendar as roll-window events (`rolls/import_macro_events.py`; path set by `MACRO_DB_PATH`). Keep that schema stable.

## Commands
```bash
npm install
npm test                      # must pass before any commit (tsx --test tests/*.test.ts)
npm run backfill              # full history (first run)
npm run refresh               # incremental: live agency sources first, FRED as fallback
npm run dev                   # http://localhost:3000
```

**Scheduled refresh:**
- `npm run refresh`, or `GET /api/refresh?secret=$REFRESH_SECRET`.
- The endpoint returns 503 until `REFRESH_SECRET` is set.
- A run lock prevents overlapping refreshes.

## Rules
**Never invent data points, consensus or calculated values.**
- The ingest protects history:
  - atomic persist
  - a shrink guard against truncated feeds
  - revisions logged in `observation_revisions`
- Don't bypass these to "fix" a feed.

**Calculations follow the README "Calculation conventions".**
- Exact-period transforms only.
- Desk smoothing as documented.
- Change a transform only with a test that pins the expected value.

**Other**
- Don't edit `data/macro.db` by hand. Use the ingest scripts.
- Market and broker integrations are read-only unless the user asks otherwise.
- Keep the architecture simple. Prefer extending `src/catalog/*` and `src/ingest/pipeline.ts` over new layers.

## First thing in a session
1. Run `npm test`.
2. If `data/macro.db` is missing, say so and suggest `npm run backfill`.
3. If the user works on rolls, check that `../rolls/run_pipeline.py status` finds `macro.db` ("Macro events DB: found").

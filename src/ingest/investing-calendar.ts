import fs from "fs";
import path from "path";
import { z } from "zod";
import { getClient } from "@/db";
import {
  investingToCatalogScale,
  mapInvestingEvent,
  normalizeCalendarCountry,
  type CalendarCountry,
} from "@/catalog/investing-map";
import { ensureSchema } from "./pipeline";

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const dumpRowSchema = z.object({
  date: z.string().min(1), // YYYY-MM-DD or "Jun 2, 2025" / "Monday, June 2, 2025"
  time: z.string().optional().nullable(), // HH:MM local to dump timezone
  currency: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  event: z.string().min(1),
  importance: z.union([z.number(), z.string()]).optional().nullable(),
  actual: z.union([z.string(), z.number()]).optional().nullable(),
  forecast: z.union([z.string(), z.number()]).optional().nullable(),
  previous: z.union([z.string(), z.number()]).optional().nullable(),
});

const dumpFileSchema = z.object({
  source: z.string().default("investing"),
  /** Display timezone when times were copied. Default BST (UTC+1). Also: GMT, GMT+5:30, … */
  timezone: z.string().optional().default("BST"),
  range: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .optional(),
  rows: z.array(dumpRowSchema).min(1),
});

export type InvestingDump = z.infer<typeof dumpFileSchema>;
export type InvestingDumpRow = z.infer<typeof dumpRowSchema>;

export interface ImportSummary {
  files: number;
  rowsRead: number;
  upserted: number;
  mapped: number;
  unmapped: number;
  releasedUpserted: number;
  skippedNoActual: number;
  errors: string[];
}

function parseImportance(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(1, Math.min(3, Math.round(v)));
  const s = String(v).trim();
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(1, Math.min(3, Math.round(n)));
  // star glyphs / "high"
  if (/★★★|high/i.test(s)) return 3;
  if (/★★|medium/i.test(s)) return 2;
  if (/★|low/i.test(s)) return 1;
  return null;
}

/** Parse Investing-style numbers: 3.5%, 51.0, -0.1%, 126.4B, 1.5K, empty/- */
export function parseCalendarNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || s === "-" || s === "—" || /^n\/?a$/i.test(s)) return null;
  s = s.replace(/,/g, "").replace(/%/g, "").replace(/\s+/g, "");
  const mult =
    /t$/i.test(s) ? 1e12 : /b$/i.test(s) ? 1e9 : /m$/i.test(s) ? 1e6 : /k$/i.test(s) ? 1e3 : 1;
  s = s.replace(/[tbmK]$/i, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n * mult;
}

function parseLooseDate(input: string): { y: number; m: number; d: number } | null {
  const iso = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };

  // "Monday, June 2, 2025" or "Jun 2, 2025"
  const mdy = input.match(
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*,?\s*([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})/i
  );
  if (mdy) {
    const month = MONTHS[mdy[1].toLowerCase()];
    if (!month) return null;
    return { y: +mdy[3], m: month, d: +mdy[2] };
  }

  // "02/06/2025" or "6/2/2025" — ambiguous; prefer ISO dumps
  const slash = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    // Assume MDY (US Investing UI often uses this in some locales); prefer ISO in dumps
    return { y: +slash[3], m: +slash[1], d: +slash[2] };
  }
  return null;
}

/** Named zones used on Investing calendar dumps (fixed offsets; BST = UTC+1). */
const NAMED_OFFSET_MINUTES: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  BST: 60, // British Summer Time
  WEST: 60,
  CET: 60,
  CEST: 120,
  EST: -300,
  EDT: -240,
  IST: 330, // India Standard Time — not Irish
};

/** Offset like BST / GMT+5:30 / UTC+5:30 / +05:30 → minutes east of UTC. */
export function parseUtcOffsetMinutes(tz: string): number | null {
  const t = tz.trim();
  const named = NAMED_OFFSET_MINUTES[t.toUpperCase()];
  if (named != null) return named;
  const m = t.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const mins = Number(m[3] || 0);
  return sign * (hours * 60 + mins);
}

/** Interpret dump wall-clock time in `timezone` (default BST) and return UTC ISO. */
export function toIsoUtc(
  dateStr: string,
  timeStr: string | null | undefined,
  timezone: string = "BST"
): string | null {
  const d = parseLooseDate(dateStr);
  if (!d) return null;
  const tm = (timeStr || "00:00").match(/^(\d{1,2}):(\d{2})/);
  const hh = tm ? Number(tm[1]) : 0;
  const mm = tm ? Number(tm[2]) : 0;

  const offset = parseUtcOffsetMinutes(timezone);
  if (offset != null) {
    // Interpret wall time as timezone-local, convert to UTC
    const utcMs = Date.UTC(d.y, d.m - 1, d.d, hh, mm) - offset * 60_000;
    return new Date(utcMs).toISOString();
  }

  // Fallback: treat as UTC wall clock (document timezone in dump when possible)
  return new Date(Date.UTC(d.y, d.m - 1, d.d, hh, mm)).toISOString();
}

function extractPeriodLabel(eventName: string): string | null {
  // Prefer trailing "(May)" / "(Q2)" / "(Jun 2025)"
  const paren = [...eventName.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
  if (!paren.length) return null;
  const last = paren[paren.length - 1];
  if (/^(yoy|mom|qoq|sa|nsa|prelim|preliminary|final|flash)$/i.test(last)) {
    return paren.length > 1 ? paren[paren.length - 2] : null;
  }
  return last;
}

export function periodDateFromEvent(
  eventName: string,
  releasedAtIso: string
): { periodDate: string | null; periodLabel: string | null } {
  const label = extractPeriodLabel(eventName);
  if (!label) return { periodDate: null, periodLabel: null };

  const released = new Date(releasedAtIso);
  const ry = released.getUTCFullYear();
  const rm = released.getUTCMonth() + 1;

  const q = label.match(/^Q([1-4])(?:\s*['’]?(\d{2}|\d{4}))?$/i);
  if (q) {
    const quarter = Number(q[1]);
    let year = ry;
    if (q[2]) {
      year = q[2].length === 2 ? 2000 + Number(q[2]) : Number(q[2]);
    } else if (rm <= (quarter - 1) * 3) {
      // release early in year for prior-year Q4 etc.
      year = ry - 1;
    }
    const month = (quarter - 1) * 3 + 1;
    return {
      periodLabel: label,
      periodDate: `${year}-${String(month).padStart(2, "0")}-01`,
    };
  }

  const mon = label.match(/^([A-Za-z]+)(?:\s*['’]?(\d{2}|\d{4}))?$/);
  if (mon && MONTHS[mon[1].toLowerCase()]) {
    const month = MONTHS[mon[1].toLowerCase()];
    let year = ry;
    if (mon[2]) {
      year = mon[2].length === 2 ? 2000 + Number(mon[2]) : Number(mon[2]);
    } else if (month > rm) {
      // e.g. release in Jan for Dec period
      year = ry - 1;
    }
    return {
      periodLabel: label,
      periodDate: `${year}-${String(month).padStart(2, "0")}-01`,
    };
  }

  return { periodDate: null, periodLabel: label };
}

function countryForStorage(
  currency: string | null | undefined,
  country: string | null | undefined
): string {
  const bucket = normalizeCalendarCountry(currency, country);
  if (bucket !== "OTHER") return bucket;
  return (country || currency || "OTHER").toUpperCase();
}

export async function importInvestingDump(
  dump: InvestingDump,
  dumpFile?: string
): Promise<Omit<ImportSummary, "files" | "errors"> & { errors: string[] }> {
  await ensureSchema();
  const client = getClient();
  const importedAt = new Date().toISOString();
  const source = dump.source || "investing";
  const timezone = dump.timezone || "BST";

  let rowsRead = 0;
  let upserted = 0;
  let mapped = 0;
  let unmapped = 0;
  let releasedUpserted = 0;
  let skippedNoActual = 0;
  const errors: string[] = [];

  for (const row of dump.rows) {
    rowsRead += 1;
    try {
      const releasedAt = toIsoUtc(row.date, row.time, timezone);
      if (!releasedAt) {
        errors.push(`Bad date/time: ${row.date} ${row.time ?? ""} (${row.event})`);
        continue;
      }

      const country = countryForStorage(row.currency, row.country);
      const { periodDate, periodLabel } = periodDateFromEvent(row.event, releasedAt);
      const actual = parseCalendarNumber(row.actual);
      const forecast = parseCalendarNumber(row.forecast);
      const previous = parseCalendarNumber(row.previous);
      const importance = parseImportance(row.importance);

      const metricId = mapInvestingEvent({
        eventName: row.event,
        currency: row.currency,
        country: row.country ?? country,
      });

      if (metricId) mapped += 1;
      else unmapped += 1;

      await client.execute({
        sql: `INSERT INTO calendar_events (
                source, country, currency, event_name, importance, released_at,
                period_date, period_label, actual, forecast, previous,
                raw_actual, raw_forecast, raw_previous, metric_id, dump_file, imported_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(source, country, event_name, released_at) DO UPDATE SET
                currency=excluded.currency,
                importance=excluded.importance,
                period_date=excluded.period_date,
                period_label=excluded.period_label,
                actual=excluded.actual,
                forecast=excluded.forecast,
                previous=excluded.previous,
                raw_actual=excluded.raw_actual,
                raw_forecast=excluded.raw_forecast,
                raw_previous=excluded.raw_previous,
                metric_id=excluded.metric_id,
                dump_file=excluded.dump_file,
                imported_at=excluded.imported_at`,
        args: [
          source,
          country,
          row.currency ? String(row.currency).toUpperCase() : null,
          row.event.trim(),
          importance,
          releasedAt,
          periodDate,
          periodLabel,
          actual,
          forecast,
          previous,
          row.actual != null ? String(row.actual) : null,
          row.forecast != null ? String(row.forecast) : null,
          row.previous != null ? String(row.previous) : null,
          metricId,
          dumpFile ?? null,
          importedAt,
        ],
      });
      upserted += 1;

      // Promote mapped rows with an actual into releases (consensus enrichment)
      if (metricId && actual != null && periodDate) {
        const scale = investingToCatalogScale(metricId);
        const actualScaled = actual * scale;
        const forecastScaled = forecast != null ? forecast * scale : null;
        const previousScaled = previous != null ? previous * scale : null;
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
            periodDate,
            releasedAt,
            actualScaled,
            forecastScaled,
            previousScaled,
            previousScaled != null
              ? Math.round((actualScaled - previousScaled) * 1e6) / 1e6
              : null,
            `investing calendar: ${row.event}`,
          ],
        });
        releasedUpserted += 1;
      } else if (metricId && actual == null) {
        skippedNoActual += 1;
      }
    } catch (e) {
      errors.push(`${row.event}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    rowsRead,
    upserted,
    mapped,
    unmapped,
    releasedUpserted,
    skippedNoActual,
    errors,
  };
}

export async function importInvestingDumpFiles(
  dirOrFiles: string | string[]
): Promise<ImportSummary> {
  const files = resolveDumpFiles(dirOrFiles);
  const summary: ImportSummary = {
    files: files.length,
    rowsRead: 0,
    upserted: 0,
    mapped: 0,
    unmapped: 0,
    releasedUpserted: 0,
    skippedNoActual: 0,
    errors: [],
  };

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const dump = dumpFileSchema.parse(raw);
      const part = await importInvestingDump(dump, path.basename(file));
      summary.rowsRead += part.rowsRead;
      summary.upserted += part.upserted;
      summary.mapped += part.mapped;
      summary.unmapped += part.unmapped;
      summary.releasedUpserted += part.releasedUpserted;
      summary.skippedNoActual += part.skippedNoActual;
      summary.errors.push(...part.errors.map((e) => `${path.basename(file)}: ${e}`));
    } catch (e) {
      summary.errors.push(`${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return summary;
}

function resolveDumpFiles(dirOrFiles: string | string[]): string[] {
  if (Array.isArray(dirOrFiles)) {
    return dirOrFiles.filter((f) => f.endsWith(".json") && fs.existsSync(f));
  }
  const p = path.resolve(dirOrFiles);
  if (fs.statSync(p).isFile()) return [p];
  return fs
    .readdirSync(p)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => path.join(p, f))
    .sort();
}

export type { CalendarCountry };

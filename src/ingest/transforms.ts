import type { Transform } from "@/catalog/metrics";

export interface RawPoint {
  date: string;
  value: number;
}

export interface TransformedPoint {
  date: string;
  value: number;
  rawValue: number;
}

export type Frequency = "daily" | "weekly" | "monthly" | "quarterly" | "annual";

/**
 * Apply series transforms with exact period matching.
 *
 * - Period-on-period (pct_change, pct_change_mom, diff) uses the *immediately preceding*
 *   period: previous month for monthly, previous quarter for quarterly, ~7 days for weekly.
 *   If that period is missing, no value is produced (never a change over a longer gap).
 * - YoY uses the *same period one year earlier* (same month / same quarter; ±3 days for
 *   weekly and daily). If it is missing, no value is produced.
 *
 * `frequency` should come from the metric catalog; if omitted it is inferred from the
 * median spacing of the dates.
 */
export function applyTransform(
  points: RawPoint[],
  transform: Transform | "diff",
  frequency?: string
): TransformedPoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (transform === "level" || transform === "index") {
    return sorted.map((p) => ({ date: p.date, value: p.value, rawValue: p.value }));
  }
  const freq = normalizeFrequency(frequency) ?? inferFrequency(sorted);

  const out: TransformedPoint[] = [];
  if (transform === "pct_change_yoy") {
    const byKey = new Map(sorted.map((p) => [periodKey(p.date, freq), p] as const));
    for (const cur of sorted) {
      const prev = yearAgo(cur, sorted, byKey, freq);
      if (!prev || prev.value === 0) continue;
      out.push({ date: cur.date, value: pct(cur.value, prev.value), rawValue: cur.value });
    }
    return out;
  }

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    if (!isPreviousPeriod(prev.date, cur.date, freq)) continue;
    if (transform === "diff") {
      out.push({ date: cur.date, value: cur.value - prev.value, rawValue: cur.value });
    } else if (transform === "pct_change" || transform === "pct_change_mom") {
      if (prev.value === 0) continue;
      out.push({ date: cur.date, value: pct(cur.value, prev.value), rawValue: cur.value });
    }
  }
  return out.filter((p) => Number.isFinite(p.value));
}

function pct(cur: number, prev: number): number {
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m || 1, d || 1];
}

function monthIndex(date: string): number {
  const [y, m] = ymd(date);
  return y * 12 + (m - 1);
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(date.length === 7 ? `${date}-01` : date) / 86_400_000);
}

export function normalizeFrequency(f?: string): Frequency | null {
  if (!f) return null;
  const s = f.toLowerCase();
  if (s.startsWith("d")) return "daily";
  if (s.startsWith("w")) return "weekly";
  if (s.startsWith("m")) return "monthly";
  if (s.startsWith("q")) return "quarterly";
  if (s.startsWith("a") || s.startsWith("y")) return "annual";
  return null;
}

/** Infer frequency from the median gap between consecutive observations. */
export function inferFrequency(sorted: RawPoint[]): Frequency {
  if (sorted.length < 2) return "monthly";
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(dayNumber(sorted[i].date) - dayNumber(sorted[i - 1].date));
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor((gaps.length - 1) / 2)]; // lower median: gaps from missing data skew upward
  if (med <= 4) return "daily";
  if (med <= 10) return "weekly";
  if (med <= 45) return "monthly";
  if (med <= 120) return "quarterly";
  return "annual";
}

function isPreviousPeriod(prev: string, cur: string, freq: Frequency): boolean {
  switch (freq) {
    case "monthly":
      return monthIndex(cur) - monthIndex(prev) === 1;
    case "quarterly":
      return monthIndex(cur) - monthIndex(prev) === 3;
    case "annual":
      return ymd(cur)[0] - ymd(prev)[0] === 1;
    case "weekly": {
      const g = dayNumber(cur) - dayNumber(prev);
      return g >= 6 && g <= 8;
    }
    case "daily": {
      const g = dayNumber(cur) - dayNumber(prev);
      return g >= 1 && g <= 4; // allows weekends and single holidays
    }
  }
}

function periodKey(date: string, freq: Frequency): string {
  if (freq === "monthly" || freq === "quarterly") return date.slice(0, 7);
  if (freq === "annual") return date.slice(0, 4);
  return date;
}

function yearAgo(
  cur: RawPoint,
  sorted: RawPoint[],
  byKey: Map<string, RawPoint>,
  freq: Frequency
): RawPoint | null {
  const [y, m] = ymd(cur.date);
  if (freq === "monthly" || freq === "quarterly") {
    return byKey.get(`${y - 1}-${String(m).padStart(2, "0")}`) ?? null;
  }
  if (freq === "annual") return byKey.get(String(y - 1)) ?? null;
  // weekly / daily: nearest observation within ±3 days of one year earlier
  const target = dayNumber(cur.date) - 365;
  let best: RawPoint | null = null;
  let bestDist = Infinity;
  for (const p of sorted) {
    const dist = Math.abs(dayNumber(p.date) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best && bestDist <= 3 ? best : null;
}

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

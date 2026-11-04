/** Smoothed cross-economy desk rows — 3m averages / 3m/3m annualized. */

import type { ColumnRule, DeskRegion } from "./desk-matrix";

export type SmoothMethod =
  | "ann3m_mom" // CPI, core, retail, wages — 3 months annualized (monthly: 3 MoM; quarterly: 1 QoQ)
  | "ann3m_index" // index level t vs t-3 months, annualize
  | "ma3" // UE, payrolls — 3-month rolling average
  | "latest" // series that are already 3-month averages (UK LFS ILO rate)
  | "latest_per_month"; // quarterly changes expressed per month (EA LFS employment / 3)

export const SMOOTH_METHOD_SHORT: Record<SmoothMethod, string> = {
  ann3m_mom: "3m/3m ann.",
  ann3m_index: "3m/3m ann. (index)",
  ma3: "3m avg",
  latest: "latest (already 3m avg)",
  latest_per_month: "latest quarter / 3",
};

export interface DeskSmoothedRowDef {
  id: string;
  label: string;
  method: SmoothMethod;
  us: string;
  uk: string;
  ea: string;
  methodByRegion?: Partial<Record<DeskRegion, SmoothMethod>>;
  /** Annualization frequency — 12 for monthly MoM, 4 for quarterly QoQ (EA wages). */
  periodsPerYearByRegion?: Partial<Record<DeskRegion, number>>;
  columnRule?: ColumnRule;
  columnRuleByRegion?: Partial<Record<DeskRegion, ColumnRule>>;
  /** Optional footnote shown under the table title. */
  note?: string;
}

export const DESK_SMOOTHED_ROWS: DeskSmoothedRowDef[] = [
  {
    id: "cpi-ann3m",
    label: "CPI",
    method: "ann3m_mom",
    us: "us-cpi-mom",
    uk: "uk-cpi-mom",
    ea: "ea-hicp-mom",
  },
  {
    id: "core-cpi-ann3m",
    label: "Core CPI",
    method: "ann3m_mom",
    us: "us-core-cpi-mom",
    uk: "uk-core-cpi-mom",
    ea: "ea-core-hicp-mom",
  },
  {
    id: "unemployment-ma3",
    label: "Unemployment rate",
    method: "ma3",
    us: "us-unemployment",
    uk: "uk-unemployment",
    ea: "ea-unemployment",
    methodByRegion: { UK: "latest" },
    note: "UK: ILO rate is already a 3-month average (MGSX), shown as published; bulletin overlay when MGSX lags.",
  },
  {
    id: "payrolls-ma3",
    label: "Employment change",
    method: "ma3",
    us: "us-nfp",
    uk: "uk-employment-change",
    ea: "ea-employment-change",
    columnRule: "monthly",
    columnRuleByRegion: { EA: "quarter" },
    periodsPerYearByRegion: { EA: 4 },
    methodByRegion: { EA: "latest_per_month" },
    note: "Thousands per month. EA: latest quarterly LFS change / 3 (Mar/Jun/Sep/Dec cols).",
  },
  {
    id: "wages-ann3m",
    label: "Wages",
    method: "ann3m_mom",
    us: "us-ahe-mom",
    uk: "uk-paye-median-pay-mom",
    ea: "ea-wage-growth-qoq",
    periodsPerYearByRegion: { EA: 4 },
    columnRule: "monthly",
    columnRuleByRegion: { EA: "quarter" },
    note: "UK: PAYE RTI median pay MoM (timelier than LMS AWE). EA: latest QoQ annualized (one quarter = 3 months).",
  },
  {
    id: "retail-ann3m",
    label: "Retail sales",
    method: "ann3m_mom",
    us: "us-retail-sales",
    uk: "uk-retail-sales-mom",
    ea: "ea-retail-sales-mom",
  },
];

export const SMOOTH_METHOD_LABELS: Record<SmoothMethod, string> = {
  ann3m_mom: "Last 3 months, annualized: compound 3 MoM prints ^4, or one QoQ print ^4",
  ann3m_index: "Index level t / t−3 months → annualize (^4 − 1)",
  ma3: "Arithmetic mean of last 3 monthly prints",
  latest: "Latest print (series is already a 3-month average)",
  latest_per_month: "Latest quarterly change divided by 3 (monthly pace)",
};

export function allDeskSmoothedMetricIds(): string[] {
  const ids = new Set<string>();
  for (const row of DESK_SMOOTHED_ROWS) {
    ids.add(row.us);
    ids.add(row.uk);
    ids.add(row.ea);
  }
  return [...ids];
}

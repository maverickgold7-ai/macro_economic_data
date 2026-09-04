import type { RawPoint } from "./transforms";

const BASE = "https://data-api.ecb.europa.eu/service/data";

export type EcbSpfSeries =
  | "SPF_HICP_P12M"
  | "SPF_CORE_P12M"
  | "SPF_HICP_LT"
  | "SPF_ASSU_LAB_P12M";

const SPF_PATHS: Record<EcbSpfSeries, string> = {
  SPF_HICP_P12M: "SPF/M.U2.HICP.POINT.P12M.Q.AVG",
  SPF_CORE_P12M: "SPF/M.U2.CORE.POINT.P12M.Q.AVG",
  SPF_HICP_LT: "SPF/Q.U2.HICP.POINT.LT.Q.AVG",
  SPF_ASSU_LAB_P12M: "SPF/A.U2.ASSU.LAB.P12M.Q.AVG",
};

/** @deprecated use fetchEcbSpfSeries */
export async function fetchEcbSpfHicp1y(): Promise<RawPoint[]> {
  return fetchEcbSpfSeries("SPF_HICP_P12M");
}

export async function fetchEcbSpfSeries(series: EcbSpfSeries): Promise<RawPoint[]> {
  const path = SPF_PATHS[series];
  const url = `${BASE}/${path}?format=csvdata`;
  const res = await fetch(url, {
    headers: { Accept: "text/csv", "User-Agent": "macro-economy-tracker/1.0" },
  });
  if (!res.ok) throw new Error(`ECB SPF ${series} ${res.status}`);
  return parseEcbCsv(await res.text(), { publicationLagMonths: series.startsWith("SPF_") ? 13 : 0 });
}

export async function fetchEcbCesInflation1y(): Promise<RawPoint[]> {
  const url = `${BASE}/CES/M.Z18.ALL.T.C1120.NUM_VAR.WM?format=csvdata`;
  const res = await fetch(url, {
    headers: { Accept: "text/csv", "User-Agent": "macro-economy-tracker/1.0" },
  });
  if (!res.ok) throw new Error(`ECB CES ${res.status}`);
  return parseEcbCsv(await res.text(), { publicationLagMonths: 0 });
}

function parseEcbCsv(
  text: string,
  opts: { publicationLagMonths: number }
): RawPoint[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const periodIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  if (periodIdx < 0 || valueIdx < 0) throw new Error("ECB CSV missing columns");

  const points: RawPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const period = cols[periodIdx]?.trim();
    const value = Number(cols[valueIdx]);
    if (!period || !Number.isFinite(value)) continue;
    const date = ecbPeriodToDate(period, opts.publicationLagMonths);
    if (!date) continue;
    points.push({ date, value });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function ecbPeriodToDate(period: string, lagMonths: number): string | null {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    let year = Number(m[1]);
    let month = Number(m[2]) - lagMonths;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }
  const q = period.match(/^(\d{4})-?Q([1-4])$/i);
  if (q) {
    const surveyMonth = { 1: 2, 2: 5, 3: 8, 4: 11 }[Number(q[2]) as 1 | 2 | 3 | 4];
    return `${q[1]}-${String(surveyMonth).padStart(2, "0")}-01`;
  }
  if (/^\d{4}$/.test(period)) {
    // Annual SPF labour-cost assumption — published in the Q1 (February) survey round.
    return `${period}-02-01`;
  }
  return null;
}

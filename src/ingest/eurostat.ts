import type { RawPoint } from "./transforms";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

interface EurostatResponse {
  value?: Record<string, number>;
  dimension?: {
    time?: { category?: { index?: Record<string, number> } };
  };
  id?: string[];
  size?: number[];
  error?: unknown;
}

export async function fetchEurostatSeries(
  dataset: string,
  filters: Record<string, string> = {}
): Promise<RawPoint[]> {
  const params = new URLSearchParams({
    format: "JSON",
    lang: "en",
    ...filters,
  });
  const url = `${BASE}/${dataset}?${params}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "macro-economy-tracker/1.0" },
  });
  if (!res.ok) throw new Error(`Eurostat ${res.status} for ${dataset}`);
  const json = (await res.json()) as EurostatResponse;
  if (!json.id || !json.size) {
    throw new Error(`Eurostat empty/invalid payload for ${dataset}`);
  }
  return parseEurostat(json);
}

function parseEurostat(json: EurostatResponse): RawPoint[] {
  const timeIndex = json.dimension?.time?.category?.index ?? {};
  const values = json.value ?? {};
  const size = json.size ?? [];
  const ids = json.id ?? [];
  const timeDim = ids.indexOf("time");
  const points: RawPoint[] = [];

  if (timeDim < 0 || size.length === 0) return [];

  const periodByPos = new Map<number, string>();
  for (const [period, pos] of Object.entries(timeIndex)) {
    periodByPos.set(pos, period);
  }

  for (const [key, v] of Object.entries(values)) {
    if (!Number.isFinite(v)) continue;
    const flat = Number(key);
    if (!Number.isFinite(flat)) continue;
    const coords = unflatten(flat, size);
    const tPos = coords[timeDim];
    const period = periodByPos.get(tPos);
    if (!period) continue;
    const date = periodToDate(period);
    if (!date) continue;
    points.push({ date, value: v });
  }

  const byDate = new Map<string, number>();
  for (const p of points.sort((a, b) => a.date.localeCompare(b.date))) {
    byDate.set(p.date, p.value);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value }));
}

function unflatten(flat: number, size: number[]): number[] {
  const coords = new Array(size.length);
  let rem = flat;
  for (let i = size.length - 1; i >= 0; i--) {
    coords[i] = rem % size[i];
    rem = Math.floor(rem / size[i]);
  }
  return coords;
}

function periodToDate(period: string): string | null {
  const m1 = period.match(/^(\d{4})-(\d{2})$/);
  if (m1) return `${m1[1]}-${m1[2]}-01`;
  const m2 = period.match(/^(\d{4})M(\d{2})$/);
  if (m2) return `${m2[1]}-${m2[2]}-01`;
  const q = period.match(/^(\d{4})-?Q([1-4])$/i);
  if (q) {
    const month = String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${q[1]}-${month}-01`;
  }
  if (/^\d{4}$/.test(period)) return `${period}-01-01`;
  return null;
}

/** Preset filters for catalog seriesIds — all via Eurostat Statistics API (JSON-stat). */
export async function fetchEurostatPreset(seriesId: string): Promise<RawPoint[]> {
  switch (seriesId) {
    case "prc_hicp_minr":
    case "prc_hicp_manr":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "TOTAL",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_core":
    case "prc_hicp_manr_core":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "TOT_X_NRG_FOOD",
        unit: "RCH_A",
      });
    case "prc_hicp_mmor":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "TOTAL",
        unit: "RCH_M",
      });
    case "prc_hicp_mmor_core":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "TOT_X_NRG_FOOD",
        unit: "RCH_M",
      });
    case "prc_hicp_minr_serv":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "SERV",
        unit: "RCH_A",
      });
    case "prc_hicp_mmor_serv":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "SERV",
        unit: "RCH_M",
      });
    case "prc_hicp_minr_goods":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "GD",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_food":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "FOOD",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_nrg":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "EA",
        coicop18: "NRG",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_DE":
    case "prc_hicp_manr_DE":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "DE",
        coicop18: "TOTAL",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_FR":
    case "prc_hicp_manr_FR":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "FR",
        coicop18: "TOTAL",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_IT":
    case "prc_hicp_manr_IT":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "IT",
        coicop18: "TOTAL",
        unit: "RCH_A",
      });
    case "prc_hicp_minr_ES":
    case "prc_hicp_manr_ES":
      return fetchEurostatSeries("prc_hicp_minr", {
        geo: "ES",
        coicop18: "TOTAL",
        unit: "RCH_A",
      });
    case "sts_inpr_m":
      return fetchEurostatSeries("sts_inpr_m", {
        geo: "EA20",
        nace_r2: "B-D",
        s_adj: "SCA",
        unit: "I21",
      });
    case "sts_inpp_m":
      return fetchEurostatSeries("sts_inpp_m", {
        geo: "EA20",
        nace_r2: "B-E36",
        s_adj: "NSA",
        unit: "I21",
      });
    case "ei_isrr_m":
      return fetchEurostatSeries("ei_isrr_m", {
        geo: "EA20",
        unit: "RT12-CA",
        nace_r2: "G47",
        indic_bt: "VOL_SLS",
      });
    case "ei_isrr_mom":
      return fetchEurostatSeries("ei_isrr_m", {
        geo: "EA21",
        unit: "RT1-SCA",
        nace_r2: "G47",
        indic_bt: "VOL_SLS",
      });
    case "ei_bssi_esi":
      return fetchEurostatSeries("ei_bssi_m_r2", {
        geo: "EA21",
        s_adj: "SA",
        indic: "BS-ESI-I",
      });
    case "ei_bssi_ici":
      return fetchEurostatSeries("ei_bssi_m_r2", {
        geo: "EA21",
        s_adj: "SA",
        indic: "BS-ICI-BAL",
      });
    case "une_rt_m":
      return fetchEurostatSeries("ei_lmhr_m", {
        geo: "EA21",
        s_adj: "SA",
        indic: "LM-UN-T-TOT",
      });
    case "une_rt_m_youth":
      return fetchEurostatSeries("ei_lmhr_m", {
        geo: "EA21",
        s_adj: "SA",
        indic: "LM-UN-T-LE25",
      });
    case "ei_lmhu_m":
      return fetchEurostatSeries("ei_lmhu_m", {
        geo: "EA21",
        s_adj: "SA",
        indic: "LM-UN-T-TOT",
      });
    case "sts_inppd_m":
      return fetchEurostatSeries("sts_inpp_m", {
        geo: "EA20",
        nace_r2: "B-E36",
        s_adj: "NSA",
        unit: "I21",
      });
    case "jvs_q_nace2":
      return fetchEurostatSeries("ei_lmhr_m", {
        geo: "EA21",
        s_adj: "SA",
        indic: "LM-UN-T-TOT",
      });
    case "lfsi_emp_q_ea":
      return fetchEurostatSeries("lfsi_emp_q", {
        geo: "EA21",
        sex: "T",
        age: "Y15-74",
        unit: "THS_PER",
        s_adj: "SA",
        indic_em: "EMP_LFS",
      });
    case "lc_lci_wage_yoy":
      return fetchEurostatSeries("lc_lci_r2_q", {
        geo: "EA21",
        unit: "I20",
        s_adj: "SCA",
        nace_r2: "B-S",
        lcstruct: "D11",
      });
    case "lc_lci_wage_qoq":
      return fetchEurostatSeries("lc_lci_r2_q", {
        geo: "EA21",
        unit: "PCH_PRE",
        s_adj: "SCA",
        nace_r2: "B-S",
        lcstruct: "D11",
      });
    default:
      return fetchEurostatSeries(seriesId, { geo: "EA" });
  }
}

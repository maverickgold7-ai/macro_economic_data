import type { RawPoint } from "./transforms";

/**
 * ONS public CSV generator — more reliable than the legacy JSON API.
 * Example:
 * https://www.ons.gov.uk/generator?format=csv&uri=/economy/inflationandpriceindices/timeseries/d7g7/mm23
 */
const GENERATOR = "https://www.ons.gov.uk/generator";

const SERIES_URI: Record<string, string> = {
  D7G7: "/economy/inflationandpriceindices/timeseries/d7g7/mm23", // CPI annual rate
  D7OE: "/economy/inflationandpriceindices/timeseries/d7oe/mm23", // CPI monthly rate
  D7G8: "/economy/inflationandpriceindices/timeseries/d7g8/mm23", // food annual
  D7GT: "/economy/inflationandpriceindices/timeseries/d7gt/mm23", // electricity/gas/fuels annual
  D7GB: "/economy/inflationandpriceindices/timeseries/d7gb/mm23", // housing/water/fuels annual
  L55O: "/economy/inflationandpriceindices/timeseries/l55o/mm23", // CPIH annual rate
  CZBH: "/economy/inflationandpriceindices/timeseries/czbh/mm23", // RPI annual rate
  DKC7: "/economy/inflationandpriceindices/timeseries/dkc7/mm23", // CPI ex energy & unprocessed food index
  DKO8: "/economy/inflationandpriceindices/timeseries/dko8/mm23", // CPI core 12m % (ex energy/food/alcohol/tobacco)
  DKC6: "/economy/inflationandpriceindices/timeseries/dkc6/mm23", // CPI core index (for MoM)
  D7NN: "/economy/inflationandpriceindices/timeseries/d7nn/mm23", // CPI services annual
  D7MV: "/economy/inflationandpriceindices/timeseries/d7mv/mm23", // CPI services monthly
  D7NM: "/economy/inflationandpriceindices/timeseries/d7nm/mm23", // CPI goods annual
  D7MU: "/economy/inflationandpriceindices/timeseries/d7mu/mm23", // CPI goods monthly
  GHIP: "/economy/inflationandpriceindices/timeseries/ghip/ppi", // input PPI index (live)
  GB7S: "/economy/inflationandpriceindices/timeseries/gb7s/ppi", // output PPI index (live; mm22 path is lagged)
  JVZ7: "/economy/inflationandpriceindices/timeseries/jvz7/ppi", // legacy output index
  AP2Y: "/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/timeseries/ap2y/unem",
  KAC3: "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kac3/lms", // total pay 3m YoY %
  KAB9: "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kab9/lms",
  KAI8: "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kai8/lms", // regular pay 1m YoY %
  KAI9: "/employmentandlabourmarket/peopleinwork/earningsandworkinghours/timeseries/kai9/lms", // regular pay 3m YoY %
  MGSX: "/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms",
  MGRZ: "/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/timeseries/mgrz/lms",
  DIOP: "/economy/economicoutputandproductivity/output/timeseries/diop/diop",
  K222: "/economy/economicoutputandproductivity/output/timeseries/k222/diop", // IoP total B-E CVMSA
  J5EK: "/businessindustryandtrade/retailindustry/timeseries/j5ek/drsi",
  ECY4: "/economy/grossdomesticproductgdp/timeseries/ecy4/mgdp",
  ED3C: "/economy/grossdomesticproductgdp/timeseries/ed3c/mgdp",
  ECYX: "/economy/grossdomesticproductgdp/timeseries/ecyx/mgdp", // monthly GDP MoM %
  ECY2: "/economy/grossdomesticproductgdp/timeseries/ecy2/mgdp", // monthly GDP index
  ED9T: "/economy/grossdomesticproductgdp/timeseries/ed9t/mgdp", // monthly GDP 3m/3m YoY %
  L2KQ: "/economy/grossdomesticproductgdp/timeseries/l2kq/pn2",
  ABMI: "/economy/grossdomesticproductgdp/timeseries/abmi/qna",
  // Official growth rates from GDP first quarterly estimate (PN2) — not levels
  IHYR: "/economy/grossdomesticproductgdp/timeseries/ihyr/pn2", // q-on-q4 YoY %
  IHYQ: "/economy/grossdomesticproductgdp/timeseries/ihyq/pn2", // QoQ %
};

export async function fetchOnsSeries(seriesId: string): Promise<RawPoint[]> {
  const uri = SERIES_URI[seriesId];
  if (!uri) throw new Error(`No ONS URI mapping for ${seriesId}`);

  const url = `${GENERATOR}?format=csv&uri=${encodeURIComponent(uri)}`;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
    const res = await fetch(url, {
      headers: {
        Accept: "text/csv",
        "User-Agent": "macro-economy-tracker/1.0",
      },
    });
    if (res.status === 429) {
      lastErr = new Error(`ONS 429 for ${seriesId}`);
      continue;
    }
    if (!res.ok) throw new Error(`ONS ${res.status} for ${seriesId}`);
    const text = await res.text();
    if (text.includes("<!DOCTYPE") || text.includes("<html")) {
      throw new Error(`ONS returned HTML for ${seriesId}`);
    }
    return parseOnsCsv(text);
  }
  throw lastErr ?? new Error(`ONS failed for ${seriesId}`);
}

function parseOnsCsv(text: string): RawPoint[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const points: RawPoint[] = [];
  let inData = false;

  for (const line of lines) {
    // Skip metadata preamble until we hit a date-like row
    const m = line.match(/^"?(\d{4}(?:\s+[A-Z]{3}|\s+Q[1-4])?)"?\s*,\s*"?(-?[\d.]+)"?/i);
    if (!m) {
      if (/^"?Date"?/i.test(line) || /^"?CDID"?/i.test(line)) inData = true;
      continue;
    }
    inData = true;
    const date = onsDate(m[1]);
    const value = Number(m[2]);
    if (!date || !Number.isFinite(value)) continue;
    points.push({ date, value });
  }

  if (!inData && points.length === 0) {
    // Alternate: simple two-column CSV with header
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 2) continue;
      const date = onsDate(parts[0].replace(/"/g, "").trim());
      const value = Number(parts[1].replace(/"/g, "").trim());
      if (!date || !Number.isFinite(value)) continue;
      points.push({ date, value });
    }
  }

  return points.sort((a, b) => a.date.localeCompare(b.date));
}

function onsDate(d: string): string | null {
  const cleaned = d.replace(/"/g, "").trim();
  const m = cleaned.match(/^(\d{4})\s+([A-Z]{3})$/i);
  if (m) {
    const month = monthNum(m[2]);
    if (!month) return null;
    return `${m[1]}-${month}-01`;
  }
  const q = cleaned.match(/^(\d{4})\s+Q([1-4])$/i);
  if (q) {
    const month = String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${q[1]}-${month}-01`;
  }
  if (/^\d{4}$/.test(cleaned)) return `${cleaned}-01-01`;
  if (/^\d{4}-\d{2}/.test(cleaned)) return cleaned.slice(0, 10);
  return null;
}

function monthNum(mon: string): string | null {
  const map: Record<string, string> = {
    JAN: "01",
    FEB: "02",
    MAR: "03",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AUG: "08",
    SEP: "09",
    OCT: "10",
    NOV: "11",
    DEC: "12",
  };
  return map[mon.toUpperCase()] ?? null;
}

import type { RawPoint } from "./transforms";

const BEA_URL = "https://apps.bea.gov/api/data";

/**
 * Official BEA API — GDP, PCE, personal income at release time.
 * Free key: https://apps.bea.gov/API/signup/
 */
export async function fetchBeaNipa(
  tableName: string,
  lineNumber: string | number,
  opts?: { frequency?: "Q" | "M" | "A"; year?: string }
): Promise<RawPoint[]> {
  const apiKey = process.env.BEA_API_KEY;
  if (!apiKey) {
    throw new Error("BEA_API_KEY required for live BEA pulls");
  }

  const params = new URLSearchParams({
    UserID: apiKey,
    method: "GetData",
    DataSetName: "NIPA",
    TableName: tableName,
    Frequency: opts?.frequency ?? "Q",
    Year: opts?.year ?? "LAST5",
    ResultFormat: "JSON",
  });

  const res = await fetch(`${BEA_URL}?${params}`, {
    headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`BEA HTTP ${res.status}`);
  const json = (await res.json()) as BeaResponse;
  const err = json.BEAAPI?.Error;
  if (err?.ErrorDetail || err?.APIErrorDescription) {
    throw new Error(`BEA: ${err.APIErrorDescription ?? err.ErrorDetail?.Description}`);
  }

  const rows = json.BEAAPI?.Results?.Data ?? [];
  const want = String(lineNumber);
  const points: RawPoint[] = [];
  for (const row of rows) {
    if (String(row.LineNumber) !== want) continue;
    const value = Number(row.DataValue?.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const date = beaTimeToDate(row.TimePeriod);
    if (!date) continue;
    points.push({ date, value });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

interface BeaResponse {
  BEAAPI?: {
    Error?: {
      APIErrorDescription?: string;
      ErrorDetail?: { Description?: string };
    };
    Results?: {
      Data?: Array<{
        LineNumber?: string;
        DataValue?: string;
        TimePeriod?: string;
      }>;
    };
  };
}

function beaTimeToDate(period?: string): string | null {
  if (!period) return null;
  // 2024Q1, 2024M01, 2024
  const q = period.match(/^(\d{4})Q([1-4])$/);
  if (q) {
    const month = String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${q[1]}-${month}-01`;
  }
  const m = period.match(/^(\d{4})M(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-01`;
  if (/^\d{4}$/.test(period)) return `${period}-01-01`;
  return null;
}

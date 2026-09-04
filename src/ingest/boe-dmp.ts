import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawPoint } from "./transforms";

const DMP_INDEX =
  "https://www.bankofengland.co.uk/monetary-policy/decision-maker-panel-data";

export type DmpWageSeries =
  | "DMP_WAGE_REALISED_3M"
  | "DMP_WAGE_EXPECTED_3M"
  | "DMP_WAGE_REALISED_1M"
  | "DMP_WAGE_EXPECTED_1M";

const SERIES_COL: Record<DmpWageSeries, string> = {
  DMP_WAGE_REALISED_3M: "C",
  DMP_WAGE_REALISED_1M: "B",
  DMP_WAGE_EXPECTED_3M: "F",
  DMP_WAGE_EXPECTED_1M: "E",
};

let cachedXlsx: { url: string; buf: Buffer; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/** BoE Decision Maker Panel wage growth from the latest monthly aggregate xlsx. */
export async function fetchBoeDmpWages(seriesId: DmpWageSeries): Promise<RawPoint[]> {
  const col = SERIES_COL[seriesId];
  const buf = await loadLatestDmpXlsx();
  const rows = parseDmpWageSheet(buf, col);
  return rows
    .map((row) => {
      const date = dmpDateToIso(row.date);
      if (!date || row.value == null || !Number.isFinite(row.value)) return null;
      return { date, value: row.value };
    })
    .filter((p): p is RawPoint => p != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadLatestDmpXlsx(): Promise<Buffer> {
  const now = Date.now();
  if (cachedXlsx && now - cachedXlsx.at < CACHE_MS) return cachedXlsx.buf;
  const url = await resolveLatestDmpMonthlyXlsxUrl();
  const res = await fetch(url, {
    headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`BoE DMP xlsx ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  cachedXlsx = { url, buf, at: now };
  return buf;
}

async function resolveLatestDmpMonthlyXlsxUrl(): Promise<string> {
  const pages = [
    DMP_INDEX,
    "https://www.bankofengland.co.uk/decision-maker-panel",
  ];
  const year = new Date().getUTCFullYear();
  const months = [
    "august",
    "july",
    "june",
    "may",
    "april",
    "march",
    "february",
    "january",
    "december",
    "november",
    "october",
    "september",
  ];

  for (const page of pages) {
    try {
      const res = await fetch(page, {
        headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "text/html" },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const m = html.match(
        /href="(\/?-\/media\/boe\/files\/decision-maker-panel-survey\/\d{4}\/monthly-dmp-data-[a-z]+-\d{4}\.xlsx)"/i
      );
      if (m) {
        const href = m[1].startsWith("http") ? m[1] : `https://www.bankofengland.co.uk${m[1]}`;
        return href;
      }
    } catch {
      // try next
    }
  }

  for (const month of months) {
    const url = `https://www.bankofengland.co.uk/-/media/boe/files/decision-maker-panel-survey/${year}/monthly-dmp-data-${month}-${year}.xlsx`;
    try {
      const res = await fetch(url, { method: "HEAD", headers: { "User-Agent": "macro-economy-tracker/1.0" } });
      if (res.ok) return url;
    } catch {
      // continue
    }
  }

  throw new Error("BoE DMP monthly xlsx URL not found");
}

interface DmpRow {
  date: string;
  value: number | null;
}

function parseDmpWageSheet(xlsx: Buffer, column: string): DmpRow[] {
  const dir = mkdtempSync(join(tmpdir(), "boe-dmp-"));
  const file = join(dir, "dmp.xlsx");
  try {
    writeFileSync(file, xlsx);
    const shared = readZipEntry(file, "xl/sharedStrings.xml");
    const strings = parseSharedStrings(shared);
    const sheetXml = readZipEntry(file, "xl/worksheets/sheet8.xml");
    return parseWageSheetXml(sheetXml, strings, column);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseWageSheetXml(xml: string, shared: string[], column: string): DmpRow[] {
  const rows: DmpRow[] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml))) {
    const cells = parseRowCells(m[1] ?? "", shared);
    const dateCell = cells.find((c) => c.col === "A");
    const valCell = cells.find((c) => c.col === column);
    if (!dateCell || !valCell) continue;
    const date = dateCell.val.trim();
    if (!/^[A-Za-z]{3}-\d{2}$/.test(date)) continue;
    const raw = valCell.val.trim().toLowerCase();
    if (!raw || raw === "n/a") {
      rows.push({ date, value: null });
      continue;
    }
    const value = Number(raw);
    rows.push({ date, value: Number.isFinite(value) ? value : null });
  }
  return rows;
}

function readZipEntry(zipPath: string, entry: string): string {
  return execFileSync("unzip", ["-p", zipPath, entry], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const chunk = m[1] ?? "";
    const texts = [...chunk.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1] ?? "");
    out.push(texts.join(""));
  }
  return out;
}

function parseRowCells(
  rowXml: string,
  shared: string[]
): { col: string; val: string }[] {
  const cells: { col: string; val: string }[] = [];
  const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml))) {
    const col = m[1] ?? "";
    const attrs = m[3] ?? "";
    const inner = m[4] ?? "";
    const t = /t="([^"]+)"/.exec(attrs)?.[1];
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "";
    let val = v;
    if (t === "s" && v) val = shared[Number(v)] ?? "";
    cells.push({ col, val });
  }
  return cells;
}

function dmpDateToIso(label: string): string | null {
  const m = label.trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const month = monthNum(m[1]!);
  if (!month) return null;
  const yy = Number(m[2]);
  const year = yy >= 16 ? 2000 + yy : 2100 + yy;
  return `${year}-${month}-01`;
}

function monthNum(mon: string): string | null {
  const map: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return map[mon.toLowerCase()] ?? null;
}

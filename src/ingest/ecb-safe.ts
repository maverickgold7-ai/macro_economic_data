import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawPoint } from "./transforms";

const SAFE_ZIP =
  "https://www.ecb.europa.eu/stats/pdf/surveys/sme/SAFE_main_series.zip";

/** Chart 14 — euro area firms' expected wage growth over the next 12 months (mean, %). */
export async function fetchEcbSafeWageExpectations(): Promise<RawPoint[]> {
  const res = await fetch(SAFE_ZIP, {
    headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`ECB SAFE zip ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return parseSafeChart14Wages(buf);
}

function parseSafeChart14Wages(zipBuf: Buffer): RawPoint[] {
  const dir = mkdtempSync(join(tmpdir(), "ecb-safe-"));
  const zipPath = join(dir, "safe.zip");
  try {
    writeFileSync(zipPath, zipBuf);
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim();
    const xlsxName = listing.split("\n").find((n) => n.endsWith(".xlsx"));
    if (!xlsxName) throw new Error("SAFE zip missing xlsx");
    execFileSync("unzip", ["-o", zipPath, xlsxName, "-d", dir]);
    const xlsxPath = join(dir, xlsxName);
    const shared = readZipEntry(xlsxPath, "xl/sharedStrings.xml");
    const strings = parseSharedStrings(shared);
    const sheetXml = readZipEntry(xlsxPath, "xl/worksheets/sheet16.xml");
    return parseChart14WageMeans(sheetXml, strings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseChart14WageMeans(xml: string, shared: string[]): RawPoint[] {
  const points: RawPoint[] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml))) {
    const cells = parseRowCells(m[1] ?? "", shared);
    if (!cells.length) continue;
    const serial = Number(cells[0]);
    if (!Number.isFinite(serial) || serial < 40000) continue;
    const wageMean = Number(cells[9]);
    if (!Number.isFinite(wageMean)) continue;
    const date = excelSerialToMonth(serial);
    if (!date) continue;
    points.push({ date, value: Math.round(wageMean * 1000) / 1000 });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
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

function parseRowCells(rowXml: string, shared: string[]): string[] {
  const cells: { col: number; val: string }[] = [];
  const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml))) {
    const colLetters = m[1] ?? "";
    const col = colLettersToIndex(colLetters);
    const attrs = m[3] ?? "";
    const inner = m[4] ?? "";
    const t = /t="([^"]+)"/.exec(attrs)?.[1];
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "";
    let val = v;
    if (t === "s" && v) val = shared[Number(v)] ?? "";
    cells.push({ col, val });
  }
  cells.sort((a, b) => a.col - b.col);
  return cells.map((c) => c.val);
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function excelSerialToMonth(serial: number): string | null {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

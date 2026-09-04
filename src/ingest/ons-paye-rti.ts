import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cheerio from "cheerio";
import type { RawPoint } from "./transforms";

const DATASET_PAGE =
  "https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/earningsandworkinghours/datasets/realtimeinformationstatisticsreferencetableseasonallyadjusted/current";

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

let cachedXlsx: { url: string; buf: Buffer; at: number } | null = null;
const CACHE_MS = 15 * 60 * 1000;

/**
 * PAYE RTI payrolled employees — monthly change on previous month (UK, SA).
 */
export async function fetchOnsPayeEmploymentChange(): Promise<RawPoint[]> {
  const rows = await parsePayeSheet(2, (cells) => {
    if (cells.length < 3) return null;
    const change = Number(cells[2]);
    if (!Number.isFinite(change)) return null;
    return { date: cells[0]!, change };
  });
  return rows
    .map((row) => {
      const date = monthYearToDate(row.date);
      if (!date) return null;
      return { date, value: row.change / 1000 };
    })
    .filter((p): p is RawPoint => p != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** PAYE RTI median monthly pay level (UK, SA) — timelier than LMS AWE KAI7. */
export async function fetchOnsPayeMedianPayLevel(): Promise<RawPoint[]> {
  const rows = await parsePayeSheet(3, (cells) => {
    if (cells.length < 2) return null;
    const level = Number(cells[1]);
    if (!Number.isFinite(level)) return null;
    return { date: cells[0]!, change: level };
  });
  return rows
    .map((row) => {
      const date = monthYearToDate(row.date);
      if (!date) return null;
      return { date, value: row.change };
    })
    .filter((p): p is RawPoint => p != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadPayeXlsx(): Promise<Buffer> {
  const now = Date.now();
  if (cachedXlsx && now - cachedXlsx.at < CACHE_MS) return cachedXlsx.buf;
  const xlsxUrl = await resolveLatestPayeXlsxUrl();
  const buf = Buffer.from(await (await fetch(xlsxUrl)).arrayBuffer());
  cachedXlsx = { url: xlsxUrl, buf, at: now };
  return buf;
}

async function parsePayeSheet<T>(
  sheetIndex: number,
  mapRow: (cells: string[]) => T | null
): Promise<T[]> {
  const buf = await loadPayeXlsx();
  const dir = mkdtempSync(join(tmpdir(), "ons-paye-"));
  const file = join(dir, "paye.xlsx");
  try {
    writeFileSync(file, buf);
    const shared = readZipEntry(file, "xl/sharedStrings.xml");
    const strings = parseSharedStrings(shared);
    const sheetXml = readZipEntry(file, `xl/worksheets/sheet${sheetIndex}.xml`);
    return parseSheetXml(sheetXml, strings, mapRow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function resolveLatestPayeXlsxUrl(): Promise<string> {
  const res = await fetch(DATASET_PAGE, {
    headers: {
      Accept: "text/html",
      "User-Agent": "macro-economy-tracker/1.0",
    },
  });
  if (!res.ok) throw new Error(`ONS PAYE dataset page ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  let href: string | null = null;
  $("a[href]").each((_, el) => {
    const h = $(el).attr("href") ?? "";
    if (/rtisa[a-z]{3}20\d{2}\.xlsx$/i.test(h) && h.includes("/current/")) {
      href = h;
      return false;
    }
    return undefined;
  });
  if (!href) {
    const m = html.match(/href="(\/file\?uri=[^"]+rtisa[a-z]{3}20\d{2}\.xlsx)"/i);
    href = m?.[1] ?? null;
  }
  if (!href) throw new Error("ONS PAYE xlsx link not found on dataset page");
  return href.startsWith("http") ? href : `https://www.ons.gov.uk${href}`;
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

function parseSheetXml<T>(
  xml: string,
  shared: string[],
  mapRow: (cells: string[]) => T | null
): T[] {
  const rows: T[] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(xml))) {
    const cells = parseRowCells(m[1] ?? "", shared);
    if (cells.length < 2) continue;
    const date = cells[0]?.trim();
    if (!date || !/^\w+ \d{4}$/i.test(date)) continue;
    const mapped = mapRow(cells);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

function parseRowCells(rowXml: string, shared: string[]): string[] {
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
  cells.sort((a, b) => a.col.localeCompare(b.col));
  return cells.map((c) => c.val);
}

function monthYearToDate(label: string): string | null {
  const m = label.trim().match(/^(\w+)\s+(20\d{2})$/i);
  if (!m) return null;
  const mm = MONTHS[m[1]!.toLowerCase()];
  return mm ? `${m[2]}-${mm}-01` : null;
}

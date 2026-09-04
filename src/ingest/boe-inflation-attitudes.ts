import type { RawPoint } from "./transforms";

const SITEMAP =
  "https://www.bankofengland.co.uk/sitemap/inflation-attitudes-survey";

export type BoeIasQuestion = "1y" | "2y" | "5y";

const QUESTION_PATTERNS: Record<BoeIasQuestion, RegExp> = {
  "1y": /Question 2a[\s\S]{0,200}?were\s*([\d.]+)%/i,
  "2y": /Question 2b[\s\S]{0,220}?median answer of\s*([\d.]+)%/i,
  "5y": /Question 2c[\s\S]{0,220}?median answer of\s*([\d.]+)%/i,
};

export async function fetchBoeInflationExpectations1y(): Promise<RawPoint[]> {
  return fetchBoeInflationExpectations("1y");
}

export async function fetchBoeInflationExpectations(
  question: BoeIasQuestion
): Promise<RawPoint[]> {
  const res = await fetch(SITEMAP, {
    headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`BoE sitemap ${res.status}`);
  const html = await res.text();

  const urls = [
    ...html.matchAll(
      /href="(https:\/\/www\.bankofengland\.co\.uk\/inflation-attitudes-survey\/\d{4}\/[^"]+)"/g
    ),
    ...html.matchAll(/href="(\/inflation-attitudes-survey\/\d{4}\/[^"]+)"/g),
  ]
    .map((m) => (m[1].startsWith("http") ? m[1] : `https://www.bankofengland.co.uk${m[1]}`))
    .filter((u) => !u.endsWith(".pdf") && !u.endsWith(".xlsx"));

  const unique = [...new Set(urls)].sort().slice(-48);
  const points: RawPoint[] = [];
  const pattern = QUESTION_PATTERNS[question];

  for (const url of unique) {
    try {
      const pageRes = await fetch(url, {
        headers: { "User-Agent": "macro-economy-tracker/1.0", Accept: "text/html" },
      });
      if (!pageRes.ok) continue;
      const page = await pageRes.text();
      const m = page.match(pattern);
      const date = parseSurveyDate(page, url);
      if (!m || !date) continue;
      points.push({ date, value: Number(m[1]) });
      await new Promise((r) => setTimeout(r, 80));
    } catch {
      // skip
    }
  }

  const byDate = new Map<string, number>();
  for (const p of points.sort((a, b) => a.date.localeCompare(b.date))) {
    byDate.set(p.date, p.value);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value }));
}

function parseSurveyDate(html: string, url: string): string | null {
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "";
  const fromTitle = title.match(
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
  );
  if (fromTitle) {
    const month = monthNum(fromTitle[1]);
    if (month) return `${fromTitle[2]}-${month}-01`;
  }
  const fromUrl = url.match(/\/(\d{4})\/([a-z]+)-\d{4}/i);
  if (fromUrl) {
    const month = monthNum(fromUrl[2]);
    if (month) return `${fromUrl[1]}-${month}-01`;
  }
  return null;
}

function monthNum(name: string): string | null {
  const m: Record<string, string> = {
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
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return m[name.toLowerCase()] ?? null;
}

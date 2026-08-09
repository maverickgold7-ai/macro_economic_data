import type { RawPoint } from "./transforms";

/**
 * DOL ETA Unemployment Insurance Weekly Claims.
 * Prefers the official PDF release (www.dol.gov/ui/data.pdf), then HTML.
 */
export async function fetchDolClaims(): Promise<{
  initial: RawPoint[];
  continuing: RawPoint[];
}> {
  try {
    return await fromPdf();
  } catch (pdfErr) {
    console.warn(`[dol] PDF parse failed:`, pdfErr);
  }
  return fromHtml();
}

async function fromPdf(): Promise<{
  initial: RawPoint[];
  continuing: RawPoint[];
}> {
  const res = await fetch("https://www.dol.gov/ui/data.pdf", {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; macro-economy-tracker/1.0)",
      Accept: "application/pdf",
    },
  });
  if (!res.ok) throw new Error(`DOL PDF ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = extractPdfText(buf);

  const week =
    text.match(/week\s+ending\s+([A-Za-z]+\s+\d{1,2},\s+20\d{2})/i) ??
    text.match(/ENDED\s+([A-Za-z]+\s+\d{1,2},\s+20\d{2})/i);
  const date = week ? new Date(week[1]).toISOString().slice(0, 10) : null;
  if (!date) throw new Error("DOL PDF: no week ending date");

  // Seasonally adjusted advance initial claims — look for first large number after phrase
  const init =
    text.match(
      /Advance\s+seasonally\s+adjusted[^0-9]{0,40}([\d,]{3,})/i
    ) ??
    text.match(
      /seasonally\s+adjusted\s+initial\s+claims[^0-9]{0,40}([\d,]{3,})/i
    ) ??
    text.match(/INITIAL\s+CLAIMS[\s\S]{0,120}?([\d,]{3,})/i);

  const cont =
    text.match(
      /seasonally\s+adjusted\s+insured\s+unemployment[^0-9]{0,40}([\d,]{3,})/i
    ) ??
    text.match(
      /CONTINUED\s+CLAIMS[\s\S]{0,120}?([\d,]{3,})/i
    );

  const initial: RawPoint[] = [];
  const continuing: RawPoint[] = [];
  if (init) initial.push({ date, value: Number(init[1].replace(/,/g, "")) });
  if (cont) continuing.push({ date, value: Number(cont[1].replace(/,/g, "")) });
  if (!initial.length) throw new Error("DOL PDF: no initial claims figure");
  return { initial, continuing };
}

async function fromHtml(): Promise<{
  initial: RawPoint[];
  continuing: RawPoint[];
}> {
  const res = await fetch("https://www.dol.gov/newsroom/releases", {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  // Fallback: parse claims.asp body text for latest national figures if present
  const claims = await fetch("https://oui.doleta.gov/unemploy/claims.asp", {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
  });
  if (!claims.ok) throw new Error(`DOL claims HTML ${claims.status}`);
  const text = (await claims.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  // Page is mostly a form now — if no numbers, fail clearly
  const init = text.match(/Initial Claims[^0-9]{0,40}([\d,]{3,})/i);
  const week = text.match(
    /week(?:\s+ending|\s+ended)?\s+([A-Za-z]+\s+\d{1,2},\s+20\d{2})/i
  );
  if (!init || !week) {
    throw new Error(
      "DOL claims HTML has no latest print (form-only page) — PDF path preferred"
    );
  }
  const date = new Date(week[1]).toISOString().slice(0, 10);
  return {
    initial: [{ date, value: Number(init[1].replace(/,/g, "")) }],
    continuing: [],
  };
}

/** Minimal PDF text extraction for uncompressed content streams. */
function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const chunks: string[] = [];
  const re = /BT([\s\S]*?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const block = m[1];
    const parts = [
      ...block.matchAll(/\(([^\\)]*(?:\\.[^\\)]*)*)\)\s*Tj/g),
      ...block.matchAll(/\[(.*?)\]\s*TJ/g),
    ];
    for (const p of parts) {
      chunks.push(
        p[1]
          .replace(/\\n/g, " ")
          .replace(/\\(.)/g, "$1")
          .replace(/\((.*?)\)/g, "$1")
      );
    }
  }
  // Also grab literal strings outside text ops (some DOL PDFs)
  const literals = [...raw.matchAll(/\(([A-Za-z0-9 ,.%:\-]{4,80})\)/g)].map(
    (x) => x[1]
  );
  return `${chunks.join(" ")} ${literals.join(" ")}`;
}

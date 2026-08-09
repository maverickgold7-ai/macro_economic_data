"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SeriesChart } from "./SeriesChart";
import { formatDelta, formatValue } from "@/lib/format";

type SeriesPayload = {
  meta: {
    id: string;
    name: string;
    shortName: string;
    description: string;
    region: string;
    category: string;
    subcategory: string;
    unit: string;
    frequency: string;
    officialUrl: string;
    docsUrl: string;
    releaseName: string;
    earliestAvailable: string | null;
    observationCount: number | null;
    lastIngestedAt: string | null;
  };
  history: Array<{ date: string; value: number }>;
  releases: Array<{
    periodDate: string;
    releasedAt: string;
    value: number;
    priorPeriodValue: number | null;
    priorPeriodDate: string | null;
    changeVsPriorPeriod: number | null;
    supportingDocUrl: string | null;
    notes: string | null;
  }>;
};

export function MetricDetail({ id }: { id: string }) {
  const [data, setData] = useState<SeriesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/metrics/${id}?limit=360`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API ${res.status}`);
        setData(await res.json());
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16">
        <p className="text-[var(--down)]">{error}</p>
        <Link href="/" className="mt-4 inline-block text-[var(--accent-ink)]">
          ← Back
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-[var(--muted)]">Loading series…</div>
    );
  }

  const { meta, history, releases } = data;
  const latest = history[history.length - 1];
  const prior = history[history.length - 2];
  const delta =
    latest && prior ? latest.value - prior.value : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm text-[var(--accent-ink)] hover:underline">
        ← All metrics
      </Link>

      <header className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <div className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          {meta.region} · {meta.category} · {meta.subcategory}
        </div>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-[var(--ink)] sm:text-4xl">
          {meta.name}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
          {meta.description}
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-[var(--paper)]/70 p-4">
            <div className="text-xs text-[var(--muted)]">Latest</div>
            <div className="mt-1 font-[family-name:var(--font-mono)] text-3xl font-semibold">
              {formatValue(latest?.value, meta.unit)}
            </div>
            <div className="text-xs text-[var(--muted)]">{latest?.date}</div>
          </div>
          <div className="rounded-xl bg-[var(--paper)]/70 p-4">
            <div className="text-xs text-[var(--muted)]">vs prior period</div>
            <div className="mt-1 font-[family-name:var(--font-mono)] text-3xl font-semibold">
              {formatDelta(delta, meta.unit)}
            </div>
            <div className="text-xs text-[var(--muted)]">{prior?.date ?? "—"}</div>
          </div>
          <div className="rounded-xl bg-[var(--paper)]/70 p-4">
            <div className="text-xs text-[var(--muted)]">History</div>
            <div className="mt-1 font-[family-name:var(--font-mono)] text-3xl font-semibold">
              {meta.observationCount ?? history.length}
            </div>
            <div className="text-xs text-[var(--muted)]">
              from {meta.earliestAvailable ?? "—"}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <a
            href={meta.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 hover:border-[var(--accent)]"
          >
            Supporting release / bulletin
          </a>
          <a
            href={meta.officialUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 hover:border-[var(--accent)]"
          >
            Official source
          </a>
        </div>
      </header>

      <section className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-xl">Historical series</h2>
        <p className="mb-4 text-xs text-[var(--muted)]">
          Full backfill through earliest available observation · {meta.frequency}
        </p>
        <SeriesChart data={history} unit={meta.unit} />
      </section>

      <section className="mt-6 rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 sm:p-6">
        <h2 className="font-[family-name:var(--font-display)] text-xl">
          Release vs prior comparison
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-[var(--muted)]">
              <tr>
                <th className="pb-2 pr-3">Period</th>
                <th className="pb-2 pr-3">Value</th>
                <th className="pb-2 pr-3">Prior period</th>
                <th className="pb-2 pr-3">Δ</th>
                <th className="pb-2">Docs</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={`${r.periodDate}-${r.releasedAt}`} className="border-t border-[var(--line)]">
                  <td className="py-2.5 pr-3 font-[family-name:var(--font-mono)]">
                    {r.periodDate}
                  </td>
                  <td className="py-2.5 pr-3 font-[family-name:var(--font-mono)]">
                    {formatValue(r.value, meta.unit)}
                  </td>
                  <td className="py-2.5 pr-3 text-[var(--muted)]">
                    {r.priorPeriodDate
                      ? `${formatValue(r.priorPeriodValue, meta.unit)} (${r.priorPeriodDate})`
                      : "—"}
                  </td>
                  <td className="py-2.5 pr-3 font-[family-name:var(--font-mono)]">
                    {formatDelta(r.changeVsPriorPeriod, meta.unit)}
                  </td>
                  <td className="py-2.5">
                    {r.supportingDocUrl ? (
                      <a
                        href={r.supportingDocUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent-ink)] hover:underline"
                      >
                        Open
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

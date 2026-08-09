export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 2;
  if (unit === "percent") return `${value.toFixed(digits)}%`;
  if (unit === "thousands" || unit === "number") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  }
  return value.toFixed(digits);
}

export function formatDelta(delta: number | null | undefined, unit: string): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  if (unit === "percent") return `${sign}${delta.toFixed(2)}pp`;
  if (unit === "thousands" || unit === "number") {
    return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(delta)}`;
  }
  return `${sign}${delta.toFixed(2)}`;
}

export function regionLabel(region: string): string {
  if (region === "US") return "United States";
  if (region === "UK") return "United Kingdom";
  if (region === "EA") return "Euro Area";
  return region;
}

export function categoryLabel(category: string): string {
  if (category === "inflation") return "Inflation";
  if (category === "growth") return "Growth";
  if (category === "jobs") return "Jobs";
  return category;
}

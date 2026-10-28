export function fmtCorr(n: number): string {
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(n).toFixed(2);
}

export function fmtZ(z: number): string {
  const sign = z > 0 ? "+" : z < 0 ? "−" : "";
  return `${sign}${Math.abs(z).toFixed(1)}σ`;
}

export function fmtPct(n: number, digits = 1): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${(Math.abs(n) * 100).toFixed(digits)}%`;
}

export function fmtPctPlain(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)));
}

export function rarity(percentile: number, latest: number, average: number): string {
  if (percentile <= 0.005 && latest <= average) return "The lowest reading in the last 10 years.";
  if (percentile >= 0.995 && latest >= average) return "The highest reading in the last 10 years.";
  if (latest < average) {
    const pct = Math.max(1, Math.round(percentile * 100));
    return `Only ${pct}% of the last 10 years was lower than this.`;
  }
  const pct = Math.max(1, Math.round((1 - percentile) * 100));
  return `Only ${pct}% of the last 10 years was higher than this.`;
}

export function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

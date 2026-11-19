export interface PercentileSummary {
  count: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export function summarizeDurations(values: number[]): PercentileSummary {
  if (values.length === 0) {
    return { count: 0, avg: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const pick = (percentile: number) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
    return sorted[index] ?? null;
  };
  return {
    count: sorted.length,
    avg,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  };
}

export function resolveTimeRange(input: { range?: string; from?: string; to?: string }, now = Date.now()) {
  const to = input.to ? new Date(input.to) : new Date(now);
  if (Number.isNaN(to.getTime())) {
    throw new Error("INVALID_RANGE");
  }
  if (input.from) {
    const from = new Date(input.from);
    if (Number.isNaN(from.getTime()) || from > to) throw new Error("INVALID_RANGE");
    return { from, to };
  }
  const hours = input.range === "30d" ? 24 * 30 : input.range === "7d" ? 24 * 7 : 24;
  return { from: new Date(to.getTime() - hours * 60 * 60 * 1000), to };
}

export function throughputBucket(rangeMs: number): { unit: "minute" | "hour"; binSize: number } {
  if (rangeMs > 2 * 24 * 60 * 60 * 1000) return { unit: "hour", binSize: 1 };
  if (rangeMs > 6 * 60 * 60 * 1000) return { unit: "minute", binSize: 15 };
  return { unit: "minute", binSize: 5 };
}

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CorrelationCard, PathPoint } from "@/lib/market/types";
import { fmtCorr, prettyDate } from "@/lib/market/format";

const AXIS = "var(--color-faint)";
const GRID = "var(--color-line)";
const FG = "var(--color-fg)";
const BRASS = "var(--color-brass)";
const OXIDE = "var(--color-oxide)";
const GREEN = "var(--color-green)";

export function Spark({ values, stressed }: { values: number[]; stressed: boolean }) {
  if (values.length < 2) return null;
  const w = 160;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 6);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 h-9 w-full" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={stressed ? OXIDE : BRASS}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function axisLabel(iso: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(iso.slice(5, 7)) - 1] ?? "";
  return `${month} '${iso.slice(2, 4)}`;
}

export function CorrelationChart({ card }: { card: CorrelationCard }) {
  const ready = useClientReady();
  const data = card.history;
  if (!ready) return <div className="h-64 w-full sm:h-72" />;
  return (
    <div className="h-64 w-full min-w-0 sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={axisLabel}
            tick={{ fill: AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => fmtCorr(v)}
            tick={{ fill: AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <ReferenceLine
            y={card.average}
            stroke={BRASS}
            strokeDasharray="4 4"
            strokeOpacity={0.85}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as { t: string; v: number } | undefined;
              if (!row) return null;
              return (
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-fg shadow-none">
                  <div className="text-muted">{prettyDate(row.t)}</div>
                  <div className="mt-1 font-medium tabular-nums">{fmtCorr(row.v)}</div>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke={FG}
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type RangeKey = "3M" | "6M" | "YTD" | "1Y";

export function pathSlice(points: PathPoint[], range: RangeKey): PathPoint[] {
  if (points.length === 0) return [];
  let start = 0;
  if (range === "3M") start = Math.max(0, points.length - 64);
  else if (range === "6M") start = Math.max(0, points.length - 127);
  else if (range === "1Y") start = Math.max(0, points.length - 253);
  else {
    const year = points[points.length - 1]!.t.slice(0, 4);
    const idx = points.findIndex((p) => p.t.startsWith(year));
    start = idx < 0 ? 0 : idx;
  }
  const base = points[start]!;
  return points.slice(start).map((p) => ({
    t: p.t,
    spx: (p.spx / base.spx) * 100,
    ew: (p.ew / base.ew) * 100,
    exai: (p.exai / base.exai) * 100,
    qqq: (p.qqq / base.qqq) * 100,
    iwm: (p.iwm / base.iwm) * 100,
  }));
}

function useClientReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  return ready;
}

const PATH_KEYS = [
  { key: "spx", label: "S&P (SPX)", color: FG },
  { key: "ew", label: "Equal-weight (SPXEW)", color: BRASS },
  { key: "exai", label: "$SPXXAI", color: OXIDE },
  { key: "qqq", label: "Nasdaq 100 (QQQ)", color: GREEN },
  { key: "iwm", label: "Small caps (IWM)", color: "var(--color-faint)" },
] as const;

export function PathChart({
  points,
  showIwm,
}: {
  points: PathPoint[];
  showIwm: boolean;
}) {
  const ready = useClientReady();
  if (!ready) return <div className="h-72 w-full sm:h-80" />;
  return (
    <div className="h-72 w-full min-w-0 sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="t"
            tickFormatter={axisLabel}
            tick={{ fill: AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(0)}
            tick={{ fill: AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <ReferenceLine y={100} stroke={GRID} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as PathPoint | undefined;
              if (!row) return null;
              const keys = showIwm ? PATH_KEYS : PATH_KEYS.filter((k) => k.key !== "iwm");
              return (
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-fg">
                  <div className="mb-1 text-muted">{prettyDate(row.t)}</div>
                  {keys.map((item) => (
                    <div key={item.key} className="flex items-center justify-between gap-4 tabular-nums">
                      <span className="text-muted">{item.label}</span>
                      <span>{(row[item.key] - 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {PATH_KEYS.filter((item) => showIwm || item.key !== "iwm").map((item) => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={item.key === "spx" || item.key === "exai" ? 1.8 : 1.4}
              strokeDasharray={item.key === "iwm" ? "4 3" : undefined}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

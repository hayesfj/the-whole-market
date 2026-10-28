import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { getDesk } from "@/lib/market/get-desk";
import type { CorrelationId, DeskPayload, SectorRow } from "@/lib/market/types";
import {
  fmtCompact,
  fmtCorr,
  fmtPct,
  fmtPctPlain,
  fmtZ,
  prettyDate,
  rarity,
} from "@/lib/market/format";
import { CorrelationChart, PathChart, Spark, pathSlice } from "@/components/desk/charts";

const RANGES = [
  { key: "3M", label: "3 months" },
  { key: "6M", label: "6 months" },
  { key: "YTD", label: "This year" },
  { key: "1Y", label: "1 year" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

export function DeskView({ initial }: { initial: DeskPayload }) {
  const refresh = useServerFn(getDesk);
  const [desk, setDesk] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<CorrelationId>("ew");
  const [range, setRange] = useState<RangeKey>("6M");
  const [showIwm, setShowIwm] = useState(false);

  const card = desk.correlations.find((c) => c.id === active) ?? desk.correlations[0]!;
  const paths = pathSlice(desk.paths, range);
  const bandTone =
    desk.verdict.band === "splintered"
      ? "text-oxide"
      : desk.verdict.band === "fraying"
        ? "text-brass"
        : "text-fg";

  async function onRefresh() {
    setBusy(true);
    setError(null);
    try {
      const next = await refresh({ data: { fresh: true } });
      setDesk(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-6 h-0.5 w-16 bg-brass" />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-widest text-brass uppercase">Market check</p>
          <h1 className="mt-1 font-serif text-4xl font-medium text-fg sm:text-5xl">The Whole Market</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            A live look at whether the S&P still speaks for the whole market, or mostly for a handful of giant
            stocks.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-right text-sm text-muted">
            <span className={desk.session === "live" ? "text-brass" : undefined}>
              {desk.session === "live" ? "Live" : "Last close"}
            </span>
            <span className="mt-0.5 block font-medium text-fg tabular-nums">{prettyDate(desk.asOf)}</span>
          </p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm text-fg hover:bg-raised disabled:opacity-60"
          >
            <RefreshCw className={`size-4 ${busy ? "motion-safe:animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </header>
      {error ? <p className="mt-3 text-sm text-oxide">{error}</p> : null}

      <section className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-y border-line py-3 text-sm">
        <Quote label="S&P (SPX)" value={desk.quotes.spx.toLocaleString("en-US")} change={desk.quotes.spxChg} />
        <Quote label="Equal-weight (SPXEW)" value={desk.quotes.ew.toLocaleString("en-US")} change={desk.quotes.ewChg} />
        <Quote label="Nasdaq 100 (QQQ)" value={desk.quotes.qqq.toLocaleString("en-US")} change={desk.quotes.qqqChg} />
        <Quote
          label="Russell (IWM)"
          value={fmtPct(desk.quotes.iwmChg)}
          bare
          tone={desk.quotes.iwmChg}
        />
        <Quote label="Crude oil (CL)" value={desk.quotes.oil.toFixed(2)} bare />
        <Quote label="Brent (BZ)" value={desk.quotes.brent.toFixed(2)} bare />
        <Quote label="10-year (TNX)" value={`${desk.quotes.yield.toFixed(2)}%`} bare />
        <Quote label="20-year" value={`${desk.quotes.yield20.toFixed(2)}%`} bare />
        <Quote label="30-year (TYX)" value={`${desk.quotes.yield30.toFixed(2)}%`} bare />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-card border border-line bg-surface p-5 sm:p-6">
          <p className={`font-serif text-3xl leading-tight sm:text-4xl ${bandTone}`}>{desk.verdict.title}</p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted sm:text-base">{desk.verdict.lede}</p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            σ is how many standard deviations today’s correlation sits from its {desk.historyLabel} average. A
            1σ move lands that far on one side in about 16% of readings. 2σ is about 2.5%. 3σ is about 0.14%.
          </p>
        </div>
        <div className="rounded-card border border-line bg-surface p-5">
          <p className="text-xs tracking-widest text-muted uppercase">How split</p>
          <p className={`mt-1 font-serif text-5xl tabular-nums ${bandTone}`}>{desk.verdict.score}</p>
          <div
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"
            role="meter"
            aria-valuenow={desk.verdict.score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="How split the market looks"
          >
            <div
              className={`h-full ${desk.verdict.band === "splintered" ? "bg-oxide" : "bg-brass"}`}
              style={{ width: `${desk.verdict.score}%` }}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {desk.verdict.band === "aligned"
              ? "These correlations still look like one market."
              : desk.verdict.band === "fraying"
                ? "Some of these correlations are coming apart."
                : "The S&P (SPX) and the rest of the market have split."}{" "}
            The score runs from 0 to 100. Each input is scaled from its own history: 0 is in line with that
            history, 100 is an extreme. Weights are equal-weight (SPXEW) 26%, crude (CL) 14%, the 10-year (TNX)
            14%, corporate bonds (LQD) 12%, energy, staples, utilities, and health care 14%, and $SPXXAI versus
            the S&P (SPX) 20%. A correlation below its {desk.historyLabel} average raises the score, except
            credit, where a higher correlation does. The $SPXXAI piece also uses that book’s drawdown against
            SPX and how many stocks are above their 200-day.
          </p>
        </div>
      </section>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {desk.drivers.map((driver) => (
          <li key={driver.id} className="rounded-card border border-line bg-bg px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-fg">{driver.label}</p>
              <p className="text-xs text-muted tabular-nums">{Math.round(driver.stress * 100)}</p>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised">
              <div
                className={`h-full ${driver.stress >= 0.66 ? "bg-oxide" : "bg-brass"}`}
                style={{ width: `${Math.round(driver.stress * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{driver.detail}</p>
          </li>
        ))}
      </ul>

      <section className="mt-8">
        <h2 className="font-serif text-2xl text-fg">Three-month correlation</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Realized correlation of daily moves over the last {desk.window} trading days. Pick a series to open
          its {desk.historyLabel} history. The dashed gold line is the {desk.historyLabel} average. Near 1, they
          rise and fall on the same days. Near 0, they don’t. Below 0, they move in opposite directions. The σ
          figure is today’s correlation versus that {desk.historyLabel} history.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {desk.correlations.map((item) => {
            const stressed = item.stressed;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === card.id}
                onClick={() => setActive(item.id)}
                className={`rounded-card border p-4 text-left ${
                  item.id === card.id ? "border-brass bg-surface" : "border-line bg-surface hover:bg-raised"
                }`}
              >
                <p className="text-xs tracking-wide text-muted uppercase">{item.label}</p>
                <p
                  className={`mt-2 font-serif text-4xl tabular-nums ${stressed ? "text-oxide" : "text-fg"}`}
                >
                  {fmtCorr(item.latest)}
                </p>
                <p className="mt-1 text-xs text-muted tabular-nums">
                  {fmtZ(item.z)} · {desk.historyLabel} avg {fmtCorr(item.average)}
                </p>
                <Spark values={item.spark.map((p) => p.v)} stressed={stressed} />
                <p className="mt-2 text-xs text-faint">
                  {item.levelLabel} {item.level}
                </p>
              </button>
            );
          })}
        </div>
        <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-fg">{card.label}</h3>
            <p className="text-xs text-muted">{rarity(card.percentile, card.latest, card.average)}</p>
          </div>
          <p className="mb-3 text-sm text-muted">{card.question}</p>
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-0.5 w-5 bg-fg" />
              63-session correlation
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="inline-block h-0 w-5 border-t border-dashed border-brass" />
              {desk.historyLabel} average
            </span>
          </div>
          <CorrelationChart card={card} />
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-2xl text-fg">The S&P (SPX) and the market under it</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Each line starts at 100. $SPXXAI is the S&P (SPX) with the big AI stocks removed. Equal-weight
              (SPXEW) gives every company the same weight.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={range === item.key}
                onClick={() => setRange(item.key)}
                className={`min-h-11 rounded-full px-3 text-sm ${
                  range === item.key ? "bg-brass text-bg" : "border border-line text-fg hover:bg-raised"
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={showIwm}
              onClick={() => setShowIwm((v) => !v)}
              className={`min-h-11 rounded-full px-3 text-sm ${
                showIwm ? "bg-fg text-bg" : "border border-line text-fg hover:bg-raised"
              }`}
            >
              Small caps (IWM)
            </button>
          </div>
        </div>
        <div className="mt-4 rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <Legend swatch="bg-fg" label="S&P (SPX)" />
            <Legend swatch="bg-brass" label="Equal-weight (SPXEW)" />
            <Legend swatch="bg-oxide" label="$SPXXAI" />
            <Legend swatch="bg-green" label="Nasdaq 100 (QQQ)" />
            {showIwm ? <Legend swatch="bg-faint" label="Russell 2000 (IWM)" /> : null}
          </div>
          <PathChart points={paths} showIwm={showIwm} />
          <p className="mt-3 text-sm leading-relaxed text-muted">{desk.pathNote}</p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="S&P (SPX), 3 months" value={fmtPct(desk.exAi.spxReturn63)} n={desk.exAi.spxReturn63} />
          <Stat label="AI stocks" value={fmtPct(desk.exAi.complexReturn63)} n={desk.exAi.complexReturn63} />
          <Stat label="$SPXXAI" value={fmtPct(desk.exAi.restReturn63)} n={desk.exAi.restReturn63} />
          <Stat label="Equal-weight (SPXEW)" value={fmtPct(desk.exAi.ewReturn63)} n={desk.exAi.ewReturn63} />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-faint">
          Those AI stocks, weighted by their size in the S&P (SPX), account for{" "}
          {(desk.exAi.contribution63 * 100).toFixed(1)} percentage points of the S&P (SPX){" "}
          {fmtPct(desk.exAi.spxReturn63)} move over the last three months. Nasdaq 100 (QQQ){" "}
          {fmtPct(desk.exAi.qqqReturn63)}. Russell 2000 (IWM) {fmtPct(desk.exAi.iwmReturn63)}.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          Removed from $SPXXAI:{" "}
          {desk.exAi.names.map((n) => `${n.ticker} ${fmtPctPlain(n.weight)}`).join(" · ")}
        </p>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-5">
        <div className="rounded-card border border-line bg-surface p-5 lg:col-span-3">
          <h2 className="font-serif text-2xl text-fg">Sectors against the S&P (SPX)</h2>
          <p className="mt-1 text-sm text-muted">
            63-session correlation of each sector with the S&P (SPX). Energy (XLE), staples (XLP), utilities
            (XLU), and health care (XLV) are labeled brighter.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
            <Legend swatch="bg-oxide" label={`Now, well below its ${desk.historyLabel} average`} />
            <Legend swatch="bg-fg" label={`Now, near its ${desk.historyLabel} average`} />
            <Legend swatch="bg-brass" label={`${desk.historyLabel} average`} />
          </div>
          <p className="mt-3 text-xs text-faint">
            Scale runs from −1 to +1. Left of the zero line, the sector moves against the S&P (SPX). Zero is
            no correlation. Right means they move together.
          </p>
          <CorrScale />
          <ul className="mt-3 space-y-3">
            {desk.sectors.map((sector) => (
              <SectorLine key={sector.symbol} sector={sector} />
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="rounded-card border border-line bg-surface p-5">
            <h2 className="font-serif text-2xl text-fg">
              Breadth
              {desk.breadth.ok && desk.breadth.universe ? (
                <span className="ml-2 text-base text-muted tabular-nums">{desk.breadth.universe} stocks</span>
              ) : null}
            </h2>
            <p className="mt-1 text-sm text-muted">
              New highs and new lows are the total over the last five trading days: an S&P (SPX) stock counts
              each day its close sets a 52-week high or low. Above the 20-day, 50-day, and 200-day is the share
              whose last close is above that average.
            </p>
            {desk.breadth.ok && desk.breadth.universe ? (
              <div className="mt-4 space-y-4">
                <dl className="grid grid-cols-3 gap-3">
                  <BreadthStat label="5-day new highs" value={String(desk.breadth.newHighs ?? "—")} />
                  <BreadthStat label="5-day new lows" value={String(desk.breadth.newLows ?? "—")} />
                  <BreadthStat
                    label="5-day total"
                    value={netLabel(desk.breadth.newHighs, desk.breadth.newLows)}
                    stress={(desk.breadth.newHighs ?? 0) - (desk.breadth.newLows ?? 0) < 0}
                  />
                </dl>
                <dl className="grid grid-cols-3 gap-3 border-t border-line pt-3">
                  <BreadthStat
                    label="Above 20-day"
                    value={share(desk.breadth.above20, desk.breadth.universe)}
                  />
                  <BreadthStat
                    label="Above 50-day"
                    value={share(desk.breadth.above50, desk.breadth.universe)}
                  />
                  <BreadthStat
                    label="Above 200-day"
                    value={share(desk.breadth.above200, desk.breadth.universe)}
                  />
                </dl>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted">Five-day breadth did not load.</p>
            )}
          </div>
          <div className="rounded-card border border-line bg-surface p-5">
            <h2 className="font-serif text-2xl text-fg">Concentration</h2>
            <p className="mt-1 text-sm text-muted">
              How much of the S&P (SPX) sits in a few companies. Weight is index share, not earnings share.
              Alphabet is GOOG only.
            </p>
            <BarShare label="Artificial Intelligence related stocks’ share of the S&P (SPX)" value={desk.exAi.weight} />
            <BarShare label="Largest 10 companies" value={desk.top10Weight} />
            <ul className="mt-3 space-y-1">
              {desk.top10.map((name) => (
                <li key={name.ticker} className="flex justify-between gap-3 text-sm">
                  <span className="truncate text-fg">
                    <span className="tabular-nums text-muted">{name.ticker}</span> {name.name}
                  </span>
                  <span className="tabular-nums text-muted">{fmtPctPlain(name.weight)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-serif text-2xl text-fg">Trading in bonds</h2>
          <p className="mt-1 text-sm text-muted">
            These funds hold riskier corporate bonds, safer corporate bonds, and Treasuries. The multiple
            compares shares traded over the last 20 days with the 1-year average. Above 1× means busier than
            that average. This is share volume, not options volume.
          </p>
          <ul className="mt-4 space-y-3">
            {desk.volumes.map((row) => (
              <li key={row.symbol}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-fg">
                    {row.symbol} <span className="text-muted">{row.label}</span>
                  </span>
                  <span className={`tabular-nums ${row.ratio >= 1.35 ? "text-oxide" : "text-fg"}`}>
                    {row.ratio.toFixed(2)}×
                  </span>
                </div>
                <p className="text-xs text-faint tabular-nums">
                  {fmtCompact(row.avg20)} vs {fmtCompact(row.avg1y)} one-year average
                </p>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-card border border-line bg-surface p-5">
          <h2 className="font-serif text-2xl text-fg">How much prices have been swinging</h2>
          <p className="mt-1 text-sm text-muted">
            Not a price from the options market. It measures how bumpy each line has been over the last three
            months, then sketches the chance of a 5% rise over the next month if that same bumpiness continues
            and there is no upward or downward drift.
          </p>
          <ul className="mt-4 space-y-2">
            {desk.vols.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg">{row.label}</span>
                <span className="text-right text-muted tabular-nums">
                  {(row.vol63 * 100).toFixed(0)}% bounce
                  <span className="ml-3 text-fg">{fmtPctPlain(row.shadowP5, 0)} chance of +5%</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <details className="mt-6 rounded-card border border-line px-5 py-4">
        <summary className="cursor-pointer text-sm font-medium text-fg">How these numbers are built</summary>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          <p>
            The S&P (SPX) line is the cap-weighted index. Equal-weight (SPXEW) gives every S&P company the same
            weight. Crude oil is the WTI future (CL). The 10-year (TNX) correlation uses the daily change in
            yield against the daily S&P (SPX) return. The 30-year is the same kind of index (TYX). The 20-year
            is the Treasury par yield, which is published once a day. Brent is the Brent crude future (BZ).
            Corporate bonds are LQD versus IEF, signed so a rise means credit lagging Treasuries.
          </p>
          <p>
            Realized correlation is a {desk.window}-session window. Averages and σ use every overlapping window
            in the loaded history, about 10 years. σ is how many standard deviations today’s correlation sits
            from that average.
          </p>
          <p>
            $SPXXAI starts from today’s SPDR S&P 500 (SPY) weights, removes the AI stocks, and compounds what remains.
            Weights stay frozen. Alphabet is included once, as GOOG. Breadth totals 52-week closing highs and
            lows over the last five sessions, and counts stocks whose last close is above the 20-day, 50-day,
            and 200-day average.
          </p>
          <p>
            The score blends six readings: SPX versus SPXEW, crude oil (CL), the 10-year (TNX), corporate bonds
            (LQD), the four highlighted sectors, and how far $SPXXAI and equal-weight have fallen behind the
            S&P (SPX). It describes the tape. It is not a forecast and not advice.
          </p>
        </div>
      </details>
      <p className="mt-6 text-xs leading-relaxed text-faint">
        This report is AI generated and may or may not be accurate. It is not investment advice.
      </p>
    </main>
  );
}

function Quote({
  label,
  value,
  change,
  bare,
  tone,
}: {
  label: string;
  value: string;
  change?: number;
  bare?: boolean;
  tone?: number;
}) {
  return (
    <p className="text-muted">
      {label}{" "}
      <span className={`font-medium tabular-nums ${tone != null && tone < 0 ? "text-oxide" : "text-fg"}`}>
        {value}
      </span>
      {!bare && change != null ? (
        <span className={`ml-1 tabular-nums ${change < 0 ? "text-oxide" : "text-muted"}`}>
          {fmtPct(change)}
        </span>
      ) : null}
    </p>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block size-2 rounded-full ${swatch}`} />
      {label}
    </span>
  );
}

function Stat({ label, value, n }: { label: string; value: string; n: number }) {
  return (
    <div className="rounded-card border border-line px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 font-serif text-2xl tabular-nums ${n < 0 ? "text-oxide" : "text-fg"}`}>{value}</p>
    </div>
  );
}

function CorrScale() {
  const marks = [
    { n: -1, label: "−1" },
    { n: -0.5, label: "−0.5" },
    { n: 0, label: "0" },
    { n: 0.5, label: "+0.5" },
    { n: 1, label: "+1" },
  ];
  return (
    <div className="relative mt-1 h-8">
      <div className="absolute inset-x-0 top-0 h-px bg-line" />
      {marks.map((mark) => {
        const align =
          mark.n === -1
            ? "items-start"
            : mark.n === 1
              ? "-translate-x-full items-end"
              : "-translate-x-1/2 items-center";
        return (
          <span
            key={mark.label}
            className={`absolute top-0 flex flex-col ${align}`}
            style={{ left: `${((mark.n + 1) / 2) * 100}%` }}
          >
            <span className="h-1.5 w-px bg-line" />
            <span className="mt-1 text-xs leading-none text-faint tabular-nums">{mark.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function SectorLine({ sector }: { sector: SectorRow }) {
  const pos = (n: number) => `${((Math.max(-1, Math.min(1, n)) + 1) / 2) * 100}%`;
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className={sector.calledOut ? "text-fg" : "text-muted"}>
          {sector.name}
          <span className="ml-2 text-xs text-faint">{sector.symbol}</span>
        </span>
        <span className={`tabular-nums ${sector.latest < 0.15 ? "text-oxide" : "text-fg"}`}>
          {fmtCorr(sector.latest)}
          <span className="ml-2 text-xs text-faint">{fmtZ(sector.z)}</span>
        </span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-raised">
        <span className="absolute -inset-y-1 left-1/2 z-0 w-px -translate-x-1/2 bg-faint/70" />
        <span
          className="absolute top-1/2 z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass"
          style={{ left: pos(sector.average) }}
        />
        <span
          className={`absolute top-1/2 z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            sector.latest < sector.average - 0.15 ? "bg-oxide" : "bg-fg"
          }`}
          style={{ left: pos(sector.latest) }}
        />
      </div>
    </li>
  );
}

function BreadthStat({ label, value, stress }: { label: string; value: string; stress?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-serif text-2xl tabular-nums ${stress ? "text-oxide" : "text-fg"}`}>{value}</dd>
    </div>
  );
}

function BarShare({ label, value }: { label: string; value: number }) {
  return (
    <div className="mt-3">
      <div className="flex justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-fg">{fmtPctPlain(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-brass" style={{ width: `${Math.min(100, value * 100)}%` }} />
      </div>
    </div>
  );
}

function netLabel(highs: number | null, lows: number | null): string {
  if (highs == null || lows == null) return "—";
  const net = highs - lows;
  return `${net > 0 ? "+" : net < 0 ? "−" : ""}${Math.abs(net)}`;
}

function share(count: number | null, universe: number): string {
  if (count == null || universe <= 0) return "—";
  return `${Math.round((count / universe) * 100)}%`;
}

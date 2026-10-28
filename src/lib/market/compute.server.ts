import type {
  CorrelationCard,
  CorrelationId,
  DeskPayload,
  Driver,
  Holding,
  PathPoint,
  Point,
  SectorRow,
  VolRow,
  VolumeRow,
} from "./types";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const SNAPSHOT = "/tmp/clearing-price-desk.json";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const WINDOW = 63;
const AI_TICKERS = [
  "NVDA",
  "MSFT",
  "AMZN",
  "GOOG",
  "META",
  "AVGO",
  "ORCL",
  "AMD",
  "MU",
  "PLTR",
] as const;

const SECTORS: { symbol: string; name: string; calledOut: boolean }[] = [
  { symbol: "XLE", name: "Energy", calledOut: true },
  { symbol: "XLP", name: "Staples", calledOut: true },
  { symbol: "XLU", name: "Utilities", calledOut: true },
  { symbol: "XLV", name: "Health Care", calledOut: true },
  { symbol: "XLF", name: "Financials", calledOut: false },
  { symbol: "XLI", name: "Industrials", calledOut: false },
  { symbol: "XLB", name: "Materials", calledOut: false },
  { symbol: "XLRE", name: "Real Estate", calledOut: false },
  { symbol: "XLY", name: "Discretionary", calledOut: false },
  { symbol: "XLC", name: "Communications", calledOut: false },
  { symbol: "XLK", name: "Technology", calledOut: false },
];

const VOLUME_ETFS: { symbol: string; label: string }[] = [
  { symbol: "HYG", label: "Riskier corporate bonds" },
  { symbol: "LQD", label: "Safer corporate bonds" },
  { symbol: "TLT", label: "Long-term Treasuries" },
  { symbol: "IEF", label: "Medium-term Treasuries" },
];

type Series = { dates: string[]; close: number[]; volume: number[] };

let cache: { at: number; data: DeskPayload } | null = null;
let inflight: Promise<DeskPayload> | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function loadDesk(fresh: boolean): Promise<DeskPayload> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!fresh && inflight) {
    const saved = readSnapshot();
    if (saved) return saved;
    return inflight;
  }
  const saved = !fresh ? readSnapshot() : null;
  inflight = buildDesk()
    .then((data) => {
      cache = { at: Date.now(), data };
      writeSnapshot(data);
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  if (saved) return saved;
  return inflight;
}

function readSnapshot(): DeskPayload | null {
  try {
    const data = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as DeskPayload;
    if (!data?.asOf || !data.verdict || !Array.isArray(data.correlations)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSnapshot(data: DeskPayload) {
  try {
    writeFileSync(SNAPSHOT, JSON.stringify(data));
  } catch (err) {
    console.error("snapshot failed", err);
  }
}

async function buildDesk(): Promise<DeskPayload> {
  const nyYear = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()),
  );
  const treasuryPromise = loadTreasury20(nyYear - 10, nyYear);
  const weights = await loadWeights();
  const breadthPromise = loadBreadth(weights.map((w) => w.ticker)).catch((err) => {
    console.error("breadth failed", err);
    return null;
  });
  const aiHeld = AI_TICKERS.map((ticker) => weights.find((w) => w.ticker === ticker)).filter(
    (row): row is Holding => Boolean(row),
  );
  if (aiHeld.length < 6) {
    throw new Error("Could not match the AI stocks to current S&P weights.");
  }

  const symbols = [
    "^GSPC",
    "^SPXEW",
    "QQQ",
    "IWM",
    "CL=F",
    "BZ=F",
    "^TNX",
    "^TYX",
    "LQD",
    "IEF",
    ...SECTORS.map((s) => s.symbol),
    ...VOLUME_ETFS.map((s) => s.symbol),
    ...aiHeld.map((h) => h.ticker),
  ];
  const unique = [...new Set(symbols)];
  const books = await mapPool(unique, 8, (sym) => loadSeries(sym));
  const book = new Map(unique.map((sym, i) => [sym, books[i]!]));

  const spx = need(book, "^GSPC");
  const ew = need(book, "^SPXEW");
  const qqq = need(book, "QQQ");
  const iwm = need(book, "IWM");
  const oil = need(book, "CL=F");
  const brent = need(book, "BZ=F");
  const yld = need(book, "^TNX");
  const y30 = need(book, "^TYX");
  const y20 = await treasuryPromise;
  const lqd = need(book, "LQD");
  const ief = need(book, "IEF");

  const asOf = spx.dates[spx.dates.length - 1]!;
  const spanYears = (Date.parse(asOf) - Date.parse(spx.dates[0]!)) / (365.25 * 24 * 3600 * 1000);
  const historyLabel = spanYears >= 9 ? "10-year" : `${Math.max(1, Math.round(spanYears))}-year`;

  const ewCorr = corrCard({
    id: "ew",
    label: "Equal-weight S&P (SPXEW)",
    question: "Are the S&P (SPX) and the equal-weight S&P (SPXEW) still moving as one market?",
    a: spx,
    b: ew,
    mode: "log",
    levelLabel: "Equal-weight (SPXEW)",
    level: formatLevel(last(ew.close), 0),
    asOf,
  });
  const oilCorr = corrCard({
    id: "oil",
    label: "Crude oil (CL)",
    question: "Are the S&P (SPX) and crude oil (CL) still correlated?",
    a: spx,
    b: oil,
    mode: "log",
    levelLabel: "Crude oil (CL)",
    level: formatLevel(last(oil.close), 2),
    asOf,
  });
  const yieldCorr = corrCard({
    id: "yield",
    label: "10-year yield (TNX)",
    question: "Are the S&P (SPX) and the 10-year yield (TNX) still discounting the same news?",
    a: spx,
    b: yld,
    mode: "yield",
    levelLabel: "10-year (TNX)",
    level: `${last(yld.close).toFixed(2)}%`,
    asOf,
  });
  const yield30Corr = corrCard({
    id: "yield30",
    label: "30-year yield (TYX)",
    question: "Are the S&P (SPX) and the 30-year yield (TYX) still discounting the same news?",
    a: spx,
    b: y30,
    mode: "yield",
    levelLabel: "30-year (TYX)",
    level: `${last(y30.close).toFixed(2)}%`,
    asOf,
  });
  const yield20Corr = corrCard({
    id: "yield20",
    label: "20-year Treasury",
    question:
      "Are the S&P (SPX) and the 20-year Treasury par yield still discounting the same news? That yield is the daily Treasury curve, not an intraday index.",
    a: spx,
    b: y20,
    mode: "yield",
    levelLabel: "20-year",
    level: `${last(y20.close).toFixed(2)}%`,
    asOf,
  });
  const creditCorr = creditCard(spx, lqd, ief, asOf);
  const correlations = [ewCorr, oilCorr, yieldCorr, yield20Corr, yield30Corr, creditCorr];

  const sectors: SectorRow[] = SECTORS.map((sector) => {
    const series = need(book, sector.symbol);
    const card = corrCard({
      id: "ew",
      label: sector.name,
      question: "",
      a: spx,
      b: series,
      mode: "log",
      levelLabel: "",
      level: "",
      asOf,
    });
    return {
      symbol: sector.symbol,
      name: sector.name,
      calledOut: sector.calledOut,
      latest: card.latest,
      average: card.average,
      z: card.z,
    };
  });

  const aiMap = new Map(aiHeld.map((h) => [h.ticker, need(book, h.ticker)]));
  const built = buildPaths(spx, ew, qqq, iwm, aiHeld, aiMap);
  const exStats = pathStats(built);
  const aiWeight = aiHeld.reduce((sum, h) => sum + h.weight, 0);

  const breadth = (await breadthPromise) ?? {
    ok: false,
    universe: null,
    newHighs: null,
    newLows: null,
    above20: null,
    above50: null,
    above200: null,
  };

  const called = sectors.filter((s) => s.calledOut);
  const sectorStress = called.reduce((sum, s) => sum + stressFromLowZ(s.z, 2.5), 0) / called.length;
  const net =
    breadth.ok && breadth.newHighs != null && breadth.newLows != null
      ? breadth.newHighs - breadth.newLows
      : null;
  const divGap = exStats.drawdown126 - exStats.spxDrawdown126;
  const ewGap = exStats.ewDrawdown126 - exStats.spxDrawdown126;
  let divStress = Math.max(clamp(-divGap / 0.07, 0, 1), clamp(-ewGap / 0.07, 0, 1) * 0.85);
  const aboveShare =
    breadth.ok && breadth.above200 != null && breadth.universe
      ? breadth.above200 / breadth.universe
      : null;
  if (aboveShare != null && exStats.spxDrawdown126 > -0.03) {
    const participation = clamp((0.72 - aboveShare) / 0.4, 0, 1);
    const netStress = net == null ? 0 : clamp(-net / 200, 0, 1);
    divStress = 0.5 * divStress + 0.35 * participation + 0.15 * netStress;
  } else if (net != null && exStats.spxDrawdown252 > -0.04) {
    divStress = 0.7 * divStress + 0.3 * clamp(-net / 200, 0, 1);
  }

  const drivers: Driver[] = [
    driver("ew", "S&P (SPX) vs equal-weight (SPXEW)", stressFromLowZ(ewCorr.z, 3), ewCorr, historyLabel),
    driver("oil", "S&P (SPX) vs crude oil (CL)", stressFromLowZ(oilCorr.z, 3), oilCorr, historyLabel),
    driver("yield", "S&P (SPX) vs 10-year (TNX)", stressFromLowZ(yieldCorr.z, 3), yieldCorr, historyLabel),
    driver("credit", "S&P (SPX) vs corporate bonds (LQD)", stressFromHighZ(creditCorr.z, 2.5), creditCorr, historyLabel),
    {
      id: "sectors",
      label: "Energy, staples, utilities, health",
      stress: round(sectorStress, 4),
      detail: `Those four average a ${fmtCorr(
        called.reduce((s, row) => s + row.latest, 0) / called.length,
      )} correlation with the S&P (SPX).`,
    },
    {
      id: "book",
      label: "S&P ex-AI ($SPXXAI)",
      stress: round(divStress, 4),
      detail: pathDetail(exStats, net, aboveShare),
    },
  ];

  const score = Math.round(
    100 *
      (0.26 * drivers[0]!.stress +
        0.14 * drivers[1]!.stress +
        0.14 * drivers[2]!.stress +
        0.12 * drivers[3]!.stress +
        0.14 * drivers[4]!.stress +
        0.2 * drivers[5]!.stress),
  );
  const band = score >= 62 ? "splintered" : score >= 36 ? "fraying" : "aligned";
  const title =
    band === "splintered"
      ? "The S&P is not the whole market"
      : band === "fraying"
        ? "The market is starting to split"
        : "Stocks are mostly moving together";
  const lede = `Over the last three months, the correlation between the S&P (SPX) and the equal-weight S&P (SPXEW) is ${fmtCorr(
    ewCorr.latest,
  )}, ${fmtZ(ewCorr.z)} versus a ${historyLabel} average of ${fmtCorr(
    ewCorr.average,
  )}. Crude oil (CL) is ${fmtCorr(oilCorr.latest)} versus a ${historyLabel} average of ${fmtCorr(
    oilCorr.average,
  )}, and the 10-year yield (TNX) is ${fmtCorr(yieldCorr.latest)} versus ${fmtCorr(
    yieldCorr.average,
  )}. Correlation near 1 means the same days up and down. Near 0 means no relationship. Below 0 means they move in opposite directions.`;

  const top10 = [...weights].sort((a, b) => b.weight - a.weight).slice(0, 10);

  return {
    asOf,
    session: marketSession(asOf),
    historyLabel,
    generatedAt: new Date().toISOString(),
    verdict: { score, band, title, lede },
    drivers,
    quotes: {
      spx: round(last(spx.close), 2),
      spxChg: round(dayChange(spx.close), 6),
      ew: round(last(ew.close), 2),
      ewChg: round(dayChange(ew.close), 6),
      qqq: round(last(qqq.close), 2),
      qqqChg: round(dayChange(qqq.close), 6),
      iwmChg: round(dayChange(iwm.close), 6),
      oil: round(last(oil.close), 2),
      brent: round(last(brent.close), 2),
      yield: round(last(yld.close), 3),
      yield20: round(last(y20.close), 3),
      yield30: round(last(y30.close), 3),
    },
    correlations,
    sectors,
    paths: built.points,
    pathNote: pathNote(exStats),
    exAi: {
      names: aiHeld.map(roundHolding),
      weight: round(aiWeight, 6),
      return63: exStats.exReturn63,
      spxReturn63: exStats.spxReturn63,
      ewReturn63: exStats.ewReturn63,
      qqqReturn63: exStats.qqqReturn63,
      iwmReturn63: exStats.iwmReturn63,
      complexReturn63: round(exStats.contribution63 / Math.max(1e-6, aiWeight), 6),
      contribution63: exStats.contribution63,
      restReturn63: exStats.restReturn63,
      drawdown126: exStats.drawdown126,
      spxDrawdown126: exStats.spxDrawdown126,
      ewDrawdown126: exStats.ewDrawdown126,
      peakDate: exStats.peakDate,
    },
    top10: top10.map(roundHolding),
    top10Weight: round(
      top10.reduce((s, h) => s + h.weight, 0),
      6,
    ),
    breadth,
    volumes: VOLUME_ETFS.map((etf) => volumeRow(etf, need(book, etf.symbol))),
    vols: volRows(built.points),
    window: WINDOW,
  };
}

function driver(
  id: string,
  label: string,
  stress: number,
  card: CorrelationCard,
  historyLabel: string,
): Driver {
  return {
    id,
    label,
    stress: round(stress, 4),
    detail: `${linkWords(card.latest)} ${fmtCorr(card.latest)} now, ${fmtCorr(card.average)} ${historyLabel} average (${fmtZ(card.z)}).`,
  };
}

type PathStats = {
  exReturn63: number;
  spxReturn63: number;
  ewReturn63: number;
  qqqReturn63: number;
  iwmReturn63: number;
  contribution63: number;
  restReturn63: number;
  drawdown126: number;
  spxDrawdown126: number;
  ewDrawdown126: number;
  spxDrawdown252: number;
  peakDate: string;
};

function pathStats(built: {
  points: PathPoint[];
  contribution63: number;
  restReturn63: number;
}): PathStats {
  const pts = built.points;
  const ret = (key: keyof Omit<PathPoint, "t">, n: number) => {
    const a = pts[pts.length - 1 - n]?.[key];
    const b = pts[pts.length - 1]?.[key];
    if (a == null || b == null || a === 0) return 0;
    return b / a - 1;
  };
  const dd = (key: keyof Omit<PathPoint, "t">, n: number) => {
    const slice = pts.slice(-n);
    let peak = -Infinity;
    let peakDate = slice[0]?.t ?? pts[pts.length - 1]!.t;
    for (const point of slice) {
      if (point[key] > peak) {
        peak = point[key];
        peakDate = point.t;
      }
    }
    const lastV = slice[slice.length - 1]![key];
    return { dd: peak > 0 ? lastV / peak - 1 : 0, peakDate };
  };
  const exDd = dd("exai", 126);
  return {
    exReturn63: round(ret("exai", WINDOW), 6),
    spxReturn63: round(ret("spx", WINDOW), 6),
    ewReturn63: round(ret("ew", WINDOW), 6),
    qqqReturn63: round(ret("qqq", WINDOW), 6),
    iwmReturn63: round(ret("iwm", WINDOW), 6),
    contribution63: round(built.contribution63, 6),
    restReturn63: round(built.restReturn63, 6),
    drawdown126: round(exDd.dd, 6),
    spxDrawdown126: round(dd("spx", 126).dd, 6),
    ewDrawdown126: round(dd("ew", 126).dd, 6),
    spxDrawdown252: round(dd("spx", 252).dd, 6),
    peakDate: exDd.peakDate,
  };
}

function linkWords(latest: number): string {
  if (latest >= 0.5) return "Still moving together.";
  if (latest >= 0.15) return "Still moving together, but loosely.";
  if (latest > -0.15) return "Barely moving together.";
  return "Moving in opposite directions.";
}

function pathDetail(stats: PathStats, net: number | null, aboveShare: number | null): string {
  const breadth =
    net == null
      ? ""
      : ` Five-day total of 52-week highs minus lows: ${net > 0 ? "+" : "−"}${Math.abs(net)}.`;
  const participation =
    aboveShare == null
      ? ""
      : ` ${Math.round(aboveShare * 100)}% of S&P (SPX) stocks are above their 200-day average.`;
  const spx =
    stats.spxDrawdown126 >= -0.0005
      ? "The S&P (SPX) is at a high."
      : `The S&P (SPX) is ${fmtPct(stats.spxDrawdown126)} from its high.`;
  return `$SPXXAI is ${fmtPct(stats.drawdown126)} from its six-month high. ${spx}${participation}${breadth}`;
}

function pathNote(stats: PathStats): string {
  const spx =
    stats.spxDrawdown126 >= -0.0005
      ? "The S&P (SPX) is at its high for that stretch."
      : `The S&P (SPX) is ${fmtPct(stats.spxDrawdown126)} from its high.`;
  return `Since ${prettyDate(stats.peakDate)}, $SPXXAI is ${fmtPct(
    stats.drawdown126,
  )} from its high of the last six months. ${spx} The equal-weight S&P (SPXEW) is ${fmtPct(
    stats.ewDrawdown126,
  )} from its high. $SPXXAI holds today’s S&P (SPX) weights fixed and removes the AI stocks. It is not an official index.`;
}

function buildPaths(
  spx: Series,
  ew: Series,
  qqq: Series,
  iwm: Series,
  ai: Holding[],
  aiMap: Map<string, Series>,
): { points: PathPoint[]; contribution63: number; restReturn63: number } {
  const maps = {
    spx: toMap(spx),
    ew: toMap(ew),
    qqq: toMap(qqq),
    iwm: toMap(iwm),
  };
  const aiMaps = ai.map((h) => ({ w: h.weight, px: toMap(aiMap.get(h.ticker)!) }));
  const wSum = ai.reduce((sum, h) => sum + h.weight, 0);
  const dates = spx.dates.filter(
    (d) => maps.ew.has(d) && maps.qqq.has(d) && maps.iwm.has(d) && aiMaps.every((a) => a.px.has(d)),
  );
  if (dates.length < WINDOW + 10) {
    throw new Error("Not enough overlapping history to rebuild the ex-AI book.");
  }

  const points: PathPoint[] = [];
  let lvlSpx = 100;
  let lvlEw = 100;
  let lvlEx = 100;
  let lvlQ = 100;
  let lvlI = 100;
  points.push({ t: dates[0]!, spx: 100, ew: 100, exai: 100, qqq: 100, iwm: 100 });
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1]!;
    const d1 = dates[i]!;
    const rSpx = maps.spx.get(d1)! / maps.spx.get(d0)! - 1;
    const rEw = maps.ew.get(d1)! / maps.ew.get(d0)! - 1;
    const rQ = maps.qqq.get(d1)! / maps.qqq.get(d0)! - 1;
    const rI = maps.iwm.get(d1)! / maps.iwm.get(d0)! - 1;
    let weighted = 0;
    for (const arm of aiMaps) weighted += arm.w * (arm.px.get(d1)! / arm.px.get(d0)! - 1);
    const rEx = (rSpx - weighted) / (1 - wSum);
    lvlSpx *= 1 + rSpx;
    lvlEw *= 1 + rEw;
    lvlEx *= 1 + clamp(rEx, -0.5, 0.5);
    lvlQ *= 1 + rQ;
    lvlI *= 1 + rI;
    points.push({
      t: d1,
      spx: round(lvlSpx, 4),
      ew: round(lvlEw, 4),
      exai: round(lvlEx, 4),
      qqq: round(lvlQ, 4),
      iwm: round(lvlI, 4),
    });
  }

  const tail = Math.min(WINDOW, dates.length - 1);
  const d0 = dates[dates.length - 1 - tail]!;
  const d1 = dates[dates.length - 1]!;
  let contribution = 0;
  for (const arm of aiMaps) contribution += arm.w * (arm.px.get(d1)! / arm.px.get(d0)! - 1);
  const spxRet = maps.spx.get(d1)! / maps.spx.get(d0)! - 1;
  const rest = (spxRet - contribution) / (1 - wSum);
  return {
    points: points.slice(-420),
    contribution63: contribution,
    restReturn63: rest,
  };
}

function volRows(pts: PathPoint[]): VolRow[] {
  const specs: { id: string; label: string; key: keyof Omit<PathPoint, "t"> }[] = [
    { id: "spx", label: "S&P (SPX)", key: "spx" },
    { id: "exai", label: "$SPXXAI", key: "exai" },
    { id: "ew", label: "Equal-weight (SPXEW)", key: "ew" },
    { id: "qqq", label: "Nasdaq 100 (QQQ)", key: "qqq" },
    { id: "iwm", label: "Russell 2000 (IWM)", key: "iwm" },
  ];
  return specs.map((spec) => {
    const rets: number[] = [];
    const start = Math.max(1, pts.length - WINDOW);
    for (let i = start; i < pts.length; i++) {
      const a = pts[i - 1]![spec.key];
      const b = pts[i]![spec.key];
      if (a > 0 && b > 0) rets.push(Math.log(b / a));
    }
    const vol = sampleStd(rets) * Math.sqrt(252);
    const sigma = vol * Math.sqrt(21 / 252);
    const shadow = sigma > 0 ? 1 - normCdf(Math.log(1.05) / sigma) : 0;
    return { id: spec.id, label: spec.label, vol63: round(vol, 4), shadowP5: round(shadow, 4) };
  });
}

function volumeRow(etf: { symbol: string; label: string }, series: Series): VolumeRow {
  const vols = series.volume.filter((v) => v > 0);
  const avg1y = mean(vols.slice(-252));
  const avg20 = mean(vols.slice(-20));
  return {
    symbol: etf.symbol,
    label: etf.label,
    ratio: avg1y > 0 ? round(avg20 / avg1y, 3) : 0,
    avg20: Math.round(avg20),
    avg1y: Math.round(avg1y),
  };
}

function creditCard(spx: Series, lqd: Series, ief: Series, asOf: string): CorrelationCard {
  const a = toMap(spx);
  const b = toMap(lqd);
  const c = toMap(ief);
  const dates = spx.dates.filter((d) => b.has(d) && c.has(d));
  const x: number[] = [];
  const y: number[] = [];
  const rd: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1]!;
    const d1 = dates[i]!;
    const px0 = a.get(d0);
    const px1 = a.get(d1);
    const l0 = b.get(d0)!;
    const l1 = b.get(d1)!;
    const i0 = c.get(d0)!;
    const i1 = c.get(d1)!;
    if (!px0 || !px1 || px0 <= 0 || px1 <= 0 || l0 <= 0 || l1 <= 0 || i0 <= 0 || i1 <= 0) continue;
    x.push(Math.log(px1 / px0));
    y.push(-(Math.log(l1 / l0) - Math.log(i1 / i0)));
    rd.push(d1);
  }
  return finishCard({
    id: "credit",
    label: "Corporate bonds (LQD)",
    question:
      "Are the S&P (SPX) and corporate-bond stress still correlated? LQD versus IEF, signed so a rise means wider credit.",
    levelLabel: "Bond funds",
    level: "LQD vs IEF",
    asOf,
    stressHigh: true,
    returnsX: x,
    returnsY: y,
    returnDates: rd,
  });
}

function corrCard(args: {
  id: CorrelationId;
  label: string;
  question: string;
  a: Series;
  b: Series;
  mode: "log" | "yield";
  levelLabel: string;
  level: string;
  asOf: string;
}): CorrelationCard {
  const am = toMap(args.a);
  const bm = toMap(args.b);
  const dates = args.a.dates.filter((d) => bm.has(d));
  const x: number[] = [];
  const y: number[] = [];
  const rd: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const d0 = dates[i - 1]!;
    const d1 = dates[i]!;
    const a0 = am.get(d0)!;
    const a1 = am.get(d1)!;
    const b0 = bm.get(d0)!;
    const b1 = bm.get(d1)!;
    if (a0 <= 0 || a1 <= 0) continue;
    const sx = Math.log(a1 / a0);
    if (args.mode === "yield") {
      x.push(sx);
      y.push(b1 - b0);
      rd.push(d1);
    } else if (b0 > 0 && b1 > 0) {
      x.push(sx);
      y.push(Math.log(b1 / b0));
      rd.push(d1);
    }
  }
  return finishCard({
    id: args.id,
    label: args.label,
    question: args.question,
    levelLabel: args.levelLabel,
    level: args.level,
    asOf: args.asOf,
    returnsX: x,
    returnsY: y,
    returnDates: rd,
  });
}

function finishCard(args: {
  id: CorrelationId;
  label: string;
  question: string;
  levelLabel: string;
  level: string;
  asOf: string;
  stressHigh?: boolean;
  returnsX: number[];
  returnsY: number[];
  returnDates: string[];
}): CorrelationCard {
  const roll: Point[] = [];
  for (let i = WINDOW - 1; i < args.returnsX.length; i++) {
    const c = pearson(
      args.returnsX.slice(i - WINDOW + 1, i + 1),
      args.returnsY.slice(i - WINDOW + 1, i + 1),
    );
    if (c == null) continue;
    roll.push({ t: args.returnDates[i]!, v: c });
  }
  if (roll.length < 40) throw new Error(`Not enough history to correlate ${args.label}.`);
  const latest = roll[roll.length - 1]!.v;
  const vals = roll.map((p) => p.v);
  const average = mean(vals);
  const stdev = sampleStd(vals);
  const z = stdev > 1e-8 ? (latest - average) / stdev : 0;
  let below = 0;
  for (const v of vals) if (v < latest) below += 1;
  const cutoff = shiftMonths(args.asOf, -18);
  const sparkSrc = roll.filter((p) => p.t >= cutoff);
  return {
    id: args.id,
    label: args.label,
    question: args.question,
    latest: round(latest, 4),
    average: round(average, 4),
    stdev: round(stdev, 4),
    z: round(z, 3),
    percentile: round(below / vals.length, 4),
    stressed: args.stressHigh ? latest > average : latest < average,
    history: downsample(roll, 420).map((p) => ({ t: p.t, v: round(p.v, 4) })),
    spark: downsample(sparkSrc.length > 10 ? sparkSrc : roll.slice(-180), 90).map((p) => ({
      t: p.t,
      v: round(p.v, 4),
    })),
    levelLabel: args.levelLabel,
    level: args.level,
  };
}

async function loadWeights(): Promise<Holding[]> {
  const url =
    "https://www.ssga.com/us/en/intermediary/etfs/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx";
  const files = readZip(await fetchBytes(url));
  const shared = sharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
  const sheet = files.get("xl/worksheets/sheet1.xml")?.toString("utf8") ?? "";
  const table = sheetRows(sheet, shared);
  const headerAt = table.findIndex((row) => row.includes("Ticker") && row.includes("Weight"));
  if (headerAt < 0) throw new Error("S&P holdings file did not include tickers.");
  const header = table[headerAt]!;
  const nameCol = header.indexOf("Name");
  const tickerCol = header.indexOf("Ticker");
  const weightCol = header.indexOf("Weight");
  const byTicker = new Map<string, { ticker: string; name: string; cap: number }>();
  for (const row of table.slice(headerAt + 1)) {
    const raw = (row[tickerCol] ?? "").trim().toUpperCase();
    const weight = Number(row[weightCol] ?? "");
    if (!/^[A-Z][A-Z0-9.-]{0,7}$/.test(raw) || !Number.isFinite(weight) || weight <= 0) continue;
    const ticker = raw.replace(/\./g, "-");
    const name = (row[nameCol] ?? "").trim() || ticker;
    const prev = byTicker.get(ticker);
    byTicker.set(ticker, { ticker, name: prev?.name ?? name, cap: (prev?.cap ?? 0) + weight });
  }
  const rows = collapseDualClass(preferGoog([...byTicker.values()]));
  if (rows.length < 450) throw new Error("S&P constituent table came back short.");
  const sum = rows.reduce((total, row) => total + row.cap, 0);
  return rows.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    weight: row.cap / sum,
  }));
}

function preferGoog(
  rows: { ticker: string; name: string; cap: number }[],
): { ticker: string; name: string; cap: number }[] {
  const goog = rows.find((row) => row.ticker === "GOOG");
  const googl = rows.find((row) => row.ticker === "GOOGL");
  const rest = rows.filter((row) => row.ticker !== "GOOG" && row.ticker !== "GOOGL");
  if (goog && googl) {
    const hi = Math.max(goog.cap, googl.cap);
    const lo = Math.min(goog.cap, googl.cap);
    const cap = lo > 0 && hi / lo < 1.05 ? hi : goog.cap + googl.cap;
    rest.push({ ticker: "GOOG", name: "Alphabet", cap });
  } else if (goog) rest.push(goog);
  else if (googl) rest.push({ ...googl, ticker: "GOOG", name: "Alphabet" });
  return rest;
}

function collapseDualClass(
  rows: { ticker: string; name: string; cap: number }[],
): { ticker: string; name: string; cap: number }[] {
  const groups = new Map<string, { ticker: string; name: string; cap: number }[]>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: { ticker: string; name: string; cap: number }[] = [];
  for (const list of groups.values()) {
    const hi = Math.max(...list.map((row) => row.cap));
    const lo = Math.min(...list.map((row) => row.cap));
    const duplicated = list.length > 1 && lo > 0 && hi / lo < 1.05;
    if (!duplicated) {
      out.push(...list);
      continue;
    }
    const each = hi / list.length;
    for (const row of list) out.push({ ...row, cap: each });
  }
  return out;
}

function stressFromHighZ(z: number, fullAt: number): number {
  if (z <= 0) return 0;
  return clamp(z / fullAt, 0, 1);
}

function marketSession(asOf: string): "live" | "close" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const nyDate = `${get("year")}-${get("month")}-${get("day")}`;
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const open = weekday !== "Sat" && weekday !== "Sun" && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  return asOf === nyDate && open ? "live" : "close";
}

async function loadTreasury20(fromYear: number, toYear: number): Promise<Series> {
  const years: number[] = [];
  for (let year = fromYear; year <= toYear; year++) years.push(year);
  const pages = await mapPool(years, 4, async (year) => {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    return fetchText(url);
  });
  const points: { t: string; v: number }[] = [];
  for (const csv of pages) {
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).filter(Boolean);
    const header = splitCsv(lines[0] ?? "");
    const dateIdx = header.findIndex((cell) => cell.toLowerCase() === "date");
    const col = header.findIndex((cell) => cell === "20 Yr");
    if (dateIdx < 0 || col < 0) continue;
    for (const line of lines.slice(1)) {
      const cells = splitCsv(line);
      const raw = cells[col] ?? "";
      const value = Number(raw);
      const iso = usDateToIso(cells[dateIdx] ?? "");
      if (!iso || !Number.isFinite(value) || value <= 0) continue;
      points.push({ t: iso, v: value });
    }
  }
  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const dates: string[] = [];
  const close: number[] = [];
  for (const point of points) {
    if (dates[dates.length - 1] === point.t) {
      close[close.length - 1] = point.v;
      continue;
    }
    dates.push(point.t);
    close.push(point.v);
  }
  if (close.length < WINDOW + 30) throw new Error("20-year Treasury history is too short.");
  return { dates, close, volume: close.map(() => 0) };
}

function splitCsv(line: string): string[] {
  return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

function usDateToIso(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

const BREADTH_DAYS = 5;
const BREADTH_YEAR = 252;

async function loadBreadth(tickers: string[]): Promise<DeskPayload["breadth"]> {
  const empty = {
    ok: false,
    universe: null,
    newHighs: null,
    newLows: null,
    above20: null,
    above50: null,
    above200: null,
  };
  const unique = [...new Set(tickers.map((ticker) => ticker.replace(/\./g, "-")))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 20) chunks.push(unique.slice(i, i + 20));
  const parts = await mapPool(chunks, 4, (chunk) => sparkCloses(chunk));
  const closes: number[][] = [];
  for (const part of parts) closes.push(...part);
  if (closes.length < 400) return empty;
  let universe = 0;
  let newHighs = 0;
  let newLows = 0;
  let above20 = 0;
  let above50 = 0;
  let above200 = 0;
  for (const series of closes) {
    const n = series.length;
    if (n < BREADTH_YEAR + BREADTH_DAYS) continue;
    universe += 1;
    const lastClose = series[n - 1]!;
    if (lastClose > mean(series.slice(n - 20))) above20 += 1;
    if (lastClose > mean(series.slice(n - 50))) above50 += 1;
    if (lastClose > mean(series.slice(n - 200))) above200 += 1;
    for (let i = n - BREADTH_DAYS; i < n; i++) {
      let priorHigh = -Infinity;
      let priorLow = Infinity;
      for (let j = i - BREADTH_YEAR; j < i; j++) {
        const px = series[j]!;
        if (px > priorHigh) priorHigh = px;
        if (px < priorLow) priorLow = px;
      }
      if (series[i]! >= priorHigh) newHighs += 1;
      if (series[i]! <= priorLow) newLows += 1;
    }
  }
  if (universe < 400) return empty;
  return { ok: true, universe, newHighs, newLows, above20, above50, above200 };
}

async function sparkCloses(symbols: string[]): Promise<number[][]> {
  if (symbols.length === 0) return [];
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.join(",")}&range=2y&interval=1d`;
    const json = JSON.parse(await fetchYahoo(url)) as {
      spark?: {
        result?: {
          symbol?: string;
          response?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[];
        }[];
      };
    };
    const out: number[][] = [];
    for (const item of json.spark?.result ?? []) {
      const raw = item.response?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const clean = raw.filter((n): n is number => n != null && Number.isFinite(n) && n > 0);
      if (clean.length > 0) out.push(clean);
    }
    return out;
  } catch {
    if (symbols.length === 1) return [];
    const mid = Math.ceil(symbols.length / 2);
    const [left, right] = await Promise.all([
      sparkCloses(symbols.slice(0, mid)),
      sparkCloses(symbols.slice(mid)),
    ]);
    return [...left, ...right];
  }
}

async function loadSeries(symbol: string): Promise<Series> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10y`;
  const json = JSON.parse(await fetchYahoo(url)) as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
      }[];
    };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const volumes = quote?.volume ?? [];
  const dates: string[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const px = closes[i];
    if (px == null || !Number.isFinite(px) || px <= 0) continue;
    dates.push(nyDate(ts[i]!));
    close.push(px);
    const vol = volumes[i];
    volume.push(vol != null && Number.isFinite(vol) ? vol : 0);
  }
  if (close.length < WINDOW + 30) {
    throw new Error(`History for ${symbol} is too short.`);
  }
  return { dates, close, volume };
}

async function fetchText(url: string, extra?: Record<string, string>): Promise<string> {
  const res = await fetchOk(url, extra);
  return await res.text();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetchOk(url);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchOk(url: string, extra?: Record<string, string>): Promise<Response> {
  let last = "Market data request failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", ...extra },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status >= 500) {
        last = `Market data returned ${res.status}`;
        await delay(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Market data returned ${res.status}`);
      return res;
    } catch (err) {
      last = err instanceof Error ? err.message : "Market data request failed";
      if (/^Market data returned (?!429|5)/.test(last)) throw new Error(last);
      await delay(300 * (attempt + 1));
    }
  }
  throw new Error(last);
}

let yahooCookie = "";
let yahooCrumb = "";
let yahooAuth: Promise<void> | null = null;

function ensureYahoo(): Promise<void> {
  if (yahooCrumb) return Promise.resolve();
  if (!yahooAuth) {
    yahooAuth = (async () => {
      try {
        const res = await fetch("https://fc.yahoo.com", {
          headers: { "User-Agent": UA },
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        });
        const parts =
          typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        yahooCookie = parts
          .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
          .filter((cookie) => cookie.includes("="))
          .join("; ");
        if (!yahooCookie) return;
        const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
          headers: { "User-Agent": UA, Accept: "*/*", Cookie: yahooCookie },
          signal: AbortSignal.timeout(15000),
        });
        if (!crumbRes.ok) return;
        const crumb = (await crumbRes.text()).trim();
        if (crumb && !crumb.startsWith("<") && !crumb.startsWith("{")) yahooCrumb = crumb;
      } catch {
        yahooCookie = "";
        yahooCrumb = "";
      } finally {
        yahooAuth = null;
      }
    })();
  }
  return yahooAuth;
}

async function fetchYahoo(url: string): Promise<string> {
  await ensureYahoo();
  if (!yahooCrumb) return fetchText(url);
  const authed = `${url}${url.includes("?") ? "&" : "?"}crumb=${encodeURIComponent(yahooCrumb)}`;
  try {
    return await fetchText(authed, { Cookie: yahooCookie });
  } catch (err) {
    yahooCrumb = "";
    yahooCookie = "";
    if (err instanceof Error && /returned 401|returned 403/.test(err.message)) return fetchText(url);
    throw err;
  }
}

function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("S&P holdings file was not a spreadsheet.");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed));
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) =>
      decodeXml(part[1] ?? ""),
    );
    out.push(texts.join(""));
  }
  return out;
}

function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const ref = /r="([A-Z]+)/.exec(attrs)?.[1] ?? "";
      const col = colIndex(ref);
      const kind = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const inner = cell[2] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
      let value = decodeXml(raw);
      if (kind === "s") value = strings[Number(value)] ?? "";
      else if (kind === "inlineStr") {
        value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1] ?? "")).join("");
      }
      cells[col] = value;
    }
    rows.push(cells.map((value) => value ?? ""));
  }
  return rows;
}

function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function decodeXml(value: string): string {
  return value
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "'");
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function need(book: Map<string, Series>, symbol: string): Series {
  const series = book.get(symbol);
  if (!series) throw new Error(`Missing ${symbol}`);
  return series;
}

function toMap(series: Series): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < series.dates.length; i++) map.set(series.dates[i]!, series.close[i]!);
  return map;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 20 || n !== ys.length) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 1e-18 || vy <= 1e-18) return null;
  return Math.max(-1, Math.min(1, (sxy - (sx * sy) / n) / Math.sqrt(vx * vy)));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr.slice();
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  let prev = -1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    if (idx === prev) continue;
    prev = idx;
    out.push(arr[idx]!);
  }
  return out;
}

function nyDate(unix: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unix * 1000));
}

function shiftMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function dayChange(close: number[]): number {
  if (close.length < 2) return 0;
  const a = close[close.length - 2]!;
  const b = close[close.length - 1]!;
  return a > 0 ? b / a - 1 : 0;
}

function last(xs: number[]): number {
  return xs[xs.length - 1] ?? 0;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundHolding(h: Holding): Holding {
  return { ticker: h.ticker, name: h.name, weight: round(h.weight, 6) };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function stressFromLowZ(z: number, fullAt: number): number {
  if (z >= 0) return 0;
  return clamp(-z / fullAt, 0, 1);
}

function fmtCorr(n: number): string {
  return (n < 0 ? "−" : "") + Math.abs(n).toFixed(2);
}

function fmtZ(z: number): string {
  const sign = z > 0 ? "+" : z < 0 ? "−" : "";
  return `${sign}${Math.abs(z).toFixed(1)}σ`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${(Math.abs(n) * 100).toFixed(1)}%`;
}

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)));
}

function formatLevel(n: number, digits: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1]?.endsWith("compute.server.ts")) {
  loadDesk(true)
    .then((desk) => {
      console.log(
        JSON.stringify(
          {
            asOf: desk.asOf,
            score: desk.verdict.score,
            band: desk.verdict.band,
            title: desk.verdict.title,
            lede: desk.verdict.lede,
            corrs: desk.correlations.map((c) => ({
              id: c.id,
              latest: c.latest,
              average: c.average,
              z: c.z,
              pct: c.percentile,
            })),
            sectors: desk.sectors.map((s) => ({ n: s.name, v: s.latest, a: s.average, z: s.z })),
            ex: desk.exAi,
            top10: desk.top10Weight,
            breadth: desk.breadth,
            volumes: desk.volumes,
            vols: desk.vols,
            pathNote: desk.pathNote,
            quotes: desk.quotes,
            drivers: desk.drivers,
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

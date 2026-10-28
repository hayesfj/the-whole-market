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

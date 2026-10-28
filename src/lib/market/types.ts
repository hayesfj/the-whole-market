export type Point = { t: string; v: number };

export type CorrelationId = "ew" | "oil" | "yield" | "yield20" | "yield30" | "credit";

export type CorrelationCard = {
  id: CorrelationId;
  label: string;
  question: string;
  latest: number;
  average: number;
  stdev: number;
  z: number;
  percentile: number;
  stressed: boolean;
  history: Point[];
  spark: Point[];
  levelLabel: string;
  level: string;
};

export type SectorRow = {
  symbol: string;
  name: string;
  calledOut: boolean;
  latest: number;
  average: number;
  z: number;
};

export type Holding = { ticker: string; name: string; weight: number };

export type PathPoint = {
  t: string;
  spx: number;
  ew: number;
  exai: number;
  qqq: number;
  iwm: number;
};

export type VolumeRow = {
  symbol: string;
  label: string;
  ratio: number;
  avg20: number;
  avg1y: number;
};

export type VolRow = {
  id: string;
  label: string;
  vol63: number;
  shadowP5: number;
};

export type Driver = {
  id: string;
  label: string;
  stress: number;
  detail: string;
};

export type DeskPayload = {
  asOf: string;
  session: "live" | "close";
  historyLabel: string;
  generatedAt: string;
  verdict: {
    score: number;
    band: "aligned" | "fraying" | "splintered";
    title: string;
    lede: string;
  };
  drivers: Driver[];
  quotes: {
    spx: number;
    spxChg: number;
    ew: number;
    ewChg: number;
    qqq: number;
    qqqChg: number;
    iwmChg: number;
    oil: number;
    brent: number;
    yield: number;
    yield20: number;
    yield30: number;
  };
  correlations: CorrelationCard[];
  sectors: SectorRow[];
  paths: PathPoint[];
  pathNote: string;
  exAi: {
    names: Holding[];
    weight: number;
    return63: number;
    spxReturn63: number;
    ewReturn63: number;
    qqqReturn63: number;
    iwmReturn63: number;
    complexReturn63: number;
    contribution63: number;
    restReturn63: number;
    drawdown126: number;
    spxDrawdown126: number;
    ewDrawdown126: number;
    peakDate: string;
  };
  top10: Holding[];
  top10Weight: number;
  breadth: {
    ok: boolean;
    universe: number | null;
    newHighs: number | null;
    newLows: number | null;
    above20: number | null;
    above50: number | null;
    above200: number | null;
  };
  volumes: VolumeRow[];
  vols: VolRow[];
  window: number;
};

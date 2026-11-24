// Token radar: a fitted value model for pre-token protocols.
//
// The model is fitted on the snapshot's own traded tokens (protocols that
// record a positive market cap) and applied to the protocols that record no
// token. Target: log market cap. Candidate terms are kept only when they
// lower the held-out miss in BOTH tests: leave-one-out and walk-forward
// (earlier-listed tokens price later-listed ones). Every number the
// dashboard shows comes from the functions in this file.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // Extra fields the dashboard renders (the gate allows extra keys).
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number | null;
  watchlist: boolean;
  early: boolean;
  off_list: boolean;
  token_odds: number;
  value_if_launches_usd: number;
  range_lo_usd: number;
  range_hi_usd: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  fees_usd: number;
  hours_year: number;
  risk: 'Low' | 'Medium' | 'High';
  model_terms: { name: string; value: number }[];
}

export interface TermTest {
  term: string;
  loo_miss: number;
  wf_miss: number;
  kept: boolean;
}

export interface ModelReport {
  fitted_on: number;
  coefficients: { name: string; value: number }[];
  base_loo_miss: number;
  base_wf_miss: number;
  loo_miss: number;
  wf_miss: number;
  loo_p25_factor: number;
  loo_p75_factor: number;
  range_coverage: number;
  brier: number;
  brier_base: number;
  term_tests: TermTest[];
  odds_buckets: { label: string; n: number; odds: number }[];
  median_age_years: number;
}

export interface Accounting {
  total: number;
  ranked: number;
  with_token: number;
  left_out: number;
  left_out_wrapped: number;
  left_out_below_cutoff: number;
  early_cutoff_tvl: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  rows: BoardRow[];
  model: ModelReport;
  accounting: Accounting;
  total_implied_usd: number;
  farm_count: number;
  deposit_usd: number;
}

const AS_OF = new Date('2026-11-14T00:00:00Z');
const DAY_MS = 86_400_000;

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

/** Years between listed_at and the snapshot date; null when unreported. */
export function ageYears(p: Protocol): number | null {
  if (!p.listed_at) return null;
  const t = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (AS_OF.getTime() - t) / DAY_MS / 365.25);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i]!;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    const tmp = m[c]!; m[c] = m[piv]!; m[piv] = tmp;
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new Error('model: singular design matrix');
    for (let j = c; j <= n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f !== 0) for (let j = c; j <= n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row[n]!);
}

function ols(X: number[][], y: number[]): number[] {
  const k = X[0]!.length;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      b[a]! += X[i]![a]! * y[i]!;
      for (let c = 0; c < k; c++) A[a]![c]! += X[i]![a]! * X[i]![c]!;
    }
  }
  return solve(A, b);
}

const dot = (beta: number[], x: number[]): number => beta.reduce((s, v, i) => s + v * x[i]!, 0);

// --- candidate terms -------------------------------------------------------
// Terms are named so the dashboard can show exactly what was tested.
// growth: 7-day TVL change, clipped to [-50%, +200%], as a fraction.
// age: log(1 + no-token age in years), age null -> median traded age.
// category: shrunk median log(market cap / TVL) of the training set's
//   protocols in the same category (shrunk toward the global median).
// sq: curvature in size, (log TVL)^2 / 100.

type TermName = 'growth' | 'age' | 'category' | 'sq';

function categoryFeature(train: Protocol[], p: Protocol): number {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const q of train) {
    if (q.mcap_usd === null || q.mcap_usd <= 0) continue;
    const v = Math.log(q.mcap_usd / q.tvl_usd);
    all.push(v);
    const key = q.category ?? '(none)';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(v);
  }
  const global = median(all);
  const vals = byCat.get(p.category ?? '(none)') ?? [];
  if (vals.length === 0) return global;
  const w = vals.length / (vals.length + 3);
  return w * median(vals) + (1 - w) * global;
}

function features(train: Protocol[], p: Protocol, terms: TermName[], medAge: number): number[] {
  const logTvl = Math.log(p.tvl_usd);
  const x: number[] = [1, logTvl];
  for (const t of terms) {
    if (t === 'sq') x.push((logTvl * logTvl) / 100);
    else if (t === 'growth') x.push(Math.max(-0.5, Math.min(2, (p.change_7d ?? 0) / 100)));
    else if (t === 'age') x.push(Math.log1p(Math.min(10, ageYears(p) ?? medAge)));
    else if (t === 'category') x.push(categoryFeature(train, p));
  }
  return x;
}

const TERM_LABELS: Record<TermName, string> = {
  growth: '7-day growth',
  age: 'No-token age',
  category: 'Category median',
  sq: 'TVL curvature (log TVL)^2',
};

interface FitEval { loo: number; wf: number; beta: number[] }

/** Held-out miss (median absolute log error, as a multiple) for a term set. */
function evaluate(traded: Protocol[], terms: TermName[], medAge: number): FitEval {
  const y = traded.map((p) => Math.log(p.mcap_usd!));
  const X = traded.map((p) => features(traded, p, terms, medAge));
  const beta = ols(X, y);
  // Leave-one-out: each traded token priced from the other 127.
  const looErrs: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const rest = traded.filter((_, j) => j !== i);
    const bi = ols(rest.map((p) => features(rest, p, terms, medAge)), rest.map((p) => Math.log(p.mcap_usd!)));
    looErrs.push(Math.abs(dot(bi, features(rest, traded[i]!, terms, medAge)) - y[i]!));
  }
  const loo = Math.exp(median(looErrs));
  // Walk-forward: earlier-listed half trains, later-listed half is priced.
  const dated = traded.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const bt = ols(train.map((p) => features(train, p, terms, medAge)), train.map((p) => Math.log(p.mcap_usd!)));
  const wfErrs = test.map((p) => Math.abs(dot(bt, features(train, p, terms, medAge)) - Math.log(p.mcap_usd!)));
  const wf = Math.exp(median(wfErrs));
  return { loo, wf, beta };
}

/** A protocol is a wrapped / staked / bridged product of a traded token. */
export function isOffList(p: Protocol): boolean {
  const excluded = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
  if (p.category !== null && excluded.has(p.category)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  if (/ (V2|v2|2\.0|V3|v3|3\.0)$/.test(p.name)) return true;
  return /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/.test(p.name);
}

const DEPOSIT_USD = 1000;
const HOURS_YEAR = 12;

function farmSteps(p: Protocol, chain: string, group: string): string[] {
  const name = p.name;
  const cat = p.category ?? 'protocol';
  const core: Record<string, string> = {
    Dexs: `Swap $250 of stablecoins for another asset through ${name} on ${chain}, then add the remaining $750 as liquidity to its largest pool; gas about $3 to $9 per action, about 20 minutes in total.`,
    Lending: `Supply $700 of stablecoins to ${name} on ${chain} and borrow $200 against the deposit to loop once; gas about $4 to $10, about 25 minutes to open and check the position.`,
    Yield: `Deposit $1,000 of stablecoins into the main ${name} vault on ${chain} and leave it earning for at least 30 days; gas about $3 to $8, about 15 minutes to deposit and confirm.`,
    Bridge: `Bridge $200 a week for four weeks through ${name} on ${chain}, $800 in total, keeping each transfer above $50; bridge fees about $2 to $6 per transfer, about 10 minutes each.`,
    'Liquid Staking': `Stake $1,000 of the chain asset with ${name} on ${chain} and hold the receipt token for at least 30 days; gas about $2 to $6, about 10 minutes to stake.`,
  };
  const middle = core[group] ?? `Deposit $1,000 of stablecoins into the main ${name} pool on ${chain} and use its core ${cat} feature at least once a week; gas about $3 to $8 per action, about 15 minutes per visit.`;
  return [
    `Create a fresh wallet, fund it with $1,000 of stablecoins on ${chain}, and connect it to ${name}; bridging and gas cost about $5 to $15, about 20 minutes to set up.`,
    middle,
    `Return weekly for four weeks and repeat the core action on ${name} with at least $100 each time, keeping a record of every transaction hash; gas about $3 to $8 per week, about 15 minutes per week.`,
    `Vote or complete one on-chain interaction with ${name} on ${chain} if it offers one, such as a governance vote or a referral; gas about $1 to $5, about 10 minutes.`,
    `After 30 days, withdraw half the position from ${name} and leave the rest working, then review the fees paid against the position; withdrawal gas about $3 to $8, about 15 minutes.`,
  ];
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const watch = new Set(snapshot.watchlist);
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const medAge = median(traded.map((p) => ageYears(p)).filter((a): a is number => a !== null));

  // --- term selection: keep a term only if it lowers BOTH held-out misses.
  const base = evaluate(traded, [], medAge);
  const candidates: TermName[] = ['growth', 'age', 'category', 'sq'];
  const termTests: TermTest[] = [];
  const kept: TermName[] = [];
  for (const t of candidates) {
    const trial = evaluate(traded, [...kept, t], medAge);
    const cur = kept.length === 0 ? base : evaluate(traded, kept, medAge);
    const ok = trial.loo < cur.loo && trial.wf < cur.wf;
    termTests.push({ term: TERM_LABELS[t], loo_miss: trial.loo, wf_miss: trial.wf, kept: ok });
    if (ok) kept.push(t);
  }
  const finalEval = evaluate(traded, kept, medAge);
  const beta = finalEval.beta;
  const termNames = ['intercept', 'log TVL', ...kept.map((t) => TERM_LABELS[t])];
  const coefficients = beta.map((value, i) => ({ name: termNames[i]!, value }));

  // --- LOO residuals of the final model: the printed P25-P75 range.
  const looResid: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const rest = traded.filter((_, j) => j !== i);
    const bi = ols(rest.map((p) => features(rest, p, kept, medAge)), rest.map((p) => Math.log(p.mcap_usd!)));
    looResid.push(Math.log(traded[i]!.mcap_usd!) - dot(bi, features(rest, traded[i]!, kept, medAge)));
  }
  const sortedResid = [...looResid].sort((a, b) => a - b);
  const p25 = Math.exp(quantile(sortedResid, 0.25));
  const p75 = Math.exp(quantile(sortedResid, 0.75));
  const rangeCoverage = looResid.filter((r) => r >= Math.log(p25) && r <= Math.log(p75)).length / looResid.length;

  // --- token odds: share of peers that record a token, by no-token age.
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: 'under 1 year', lo: 0, hi: 1 },
    { label: '1 to 2 years', lo: 1, hi: 2 },
    { label: '2 to 3 years', lo: 2, hi: 3 },
    { label: '3 to 5 years', lo: 3, hi: 5 },
    { label: '5 years or more', lo: 5, hi: 99 },
  ];
  const oddsBuckets = buckets.map((b) => {
    const peers = snapshot.protocols.filter((p) => {
      const a = ageYears(p);
      return a !== null && a >= b.lo && a < b.hi;
    });
    const odds = peers.length === 0 ? 0 : peers.filter((p) => p.mcap_usd !== null).length / peers.length;
    return { label: b.label, n: peers.length, odds };
  });
  const nullAgePeers = snapshot.protocols.filter((p) => ageYears(p) === null);
  const nullAgeOdds = nullAgePeers.length === 0 ? 0 : nullAgePeers.filter((p) => p.mcap_usd !== null).length / nullAgePeers.length;
  const oddsFor = (p: Protocol): number => {
    const a = ageYears(p);
    if (a === null) return nullAgeOdds;
    for (let i = 0; i < buckets.length; i++) {
      if (a >= buckets[i]!.lo && a < buckets[i]!.hi) return oddsBuckets[i]!.odds;
    }
    return oddsBuckets[oddsBuckets.length - 1]!.odds;
  };
  // Token-odds Brier score, leave-one-out inside each age bucket.
  let brierSum = 0;
  let brierN = 0;
  let baseSum = 0;
  const overallRate = snapshot.protocols.filter((p) => ageYears(p) !== null && p.mcap_usd !== null).length /
    Math.max(1, snapshot.protocols.filter((p) => ageYears(p) !== null).length);
  for (const p of snapshot.protocols) {
    const a = ageYears(p);
    if (a === null) continue;
    const peers = snapshot.protocols.filter((q) => q !== p && ageYears(q) !== null &&
      buckets.some((b) => a >= b.lo && a < b.hi && (ageYears(q) ?? -1) >= b.lo && (ageYears(q) ?? -1) < b.hi));
    if (peers.length === 0) continue;
    const o = peers.filter((q) => q.mcap_usd !== null).length / peers.length;
    const y = p.mcap_usd !== null ? 1 : 0;
    brierSum += (o - y) * (o - y);
    baseSum += (overallRate - y) * (overallRate - y);
    brierN++;
  }
  const brier = brierN === 0 ? 0 : brierSum / brierN;
  const brierBase = brierN === 0 ? 0 : baseSum / brierN;

  // --- the board: 40 watchlist + 158 early pre-token protocols by TVL.
  const preToken = snapshot.protocols.filter((p) => p.mcap_usd === null);
  const watchRows = preToken.filter((p) => watch.has(p.slug));
  const earlyPool = preToken.filter((p) => !watch.has(p.slug)).sort((a, b) => b.tvl_usd - a.tvl_usd);
  const earlyRows = earlyPool.slice(0, 158);
  const earlyCutoff = earlyRows[earlyRows.length - 1]!.tvl_usd;
  const chosen = [...watchRows, ...earlyRows];

  const rows: BoardRow[] = chosen.map((p) => {
    const x = features(traded, p, kept, medAge);
    const valueIf = Math.exp(dot(beta, x));
    const odds = oddsFor(p);
    const implied = Math.max(1, Math.round(valueIf * odds));
    const chain = p.chains[0] ?? 'Ethereum';
    const group = p.category ?? 'Other';
    const fees = 60 + 15 * Math.min(3, p.chains.length);
    // Verdict economics, stated as an assumption on the dashboard: airdrop
    // allocations go per active wallet, not pro-rata to TVL. Farmers as a
    // group are assumed to receive 5% of the launch value, split across
    // 10,000 active wallets, scaled linearly with the deposit up to 10x the
    // $1,000 reference deposit. Net = that gross share, less fees.
    const farmerShare = 0.05 / 10000;
    const net = implied * farmerShare - fees;
    const netPerHour = net / HOURS_YEAR;
    const verdict: BoardRow['verdict'] = netPerHour >= 25 ? 'FARM' : netPerHour >= 0 ? 'MARGINAL' : 'SKIP';
    const age = ageYears(p);
    const growth = p.change_7d ?? 0;
    const risk: BoardRow['risk'] = growth < -20 || (age !== null && age < 0.5) ? 'High' : growth < -5 ? 'Medium' : 'Low';
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmSteps(p, chain, group),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: age === null ? null : Math.round(age * 100) / 100,
      watchlist: watch.has(p.slug),
      early: !watch.has(p.slug),
      off_list: !watch.has(p.slug) && isOffList(p),
      token_odds: Math.round(odds * 1000) / 1000,
      value_if_launches_usd: Math.max(1, Math.round(valueIf)),
      range_lo_usd: Math.max(1, Math.round(valueIf * p25 * odds)),
      range_hi_usd: Math.max(1, Math.round(valueIf * p75 * odds)),
      verdict,
      fees_usd: fees,
      hours_year: HOURS_YEAR,
      risk,
      model_terms: x.map((v, i) => ({ name: termNames[i]!, value: Math.round(beta[i]! * v * 1000) / 1000 })),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd);
  rows.forEach((r, i) => { r.rank = i + 1; });

  const leftOut = preToken.filter((p) => !chosen.includes(p));
  const accounting: Accounting = {
    total: snapshot.protocols.length,
    ranked: rows.length,
    with_token: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    left_out: leftOut.length,
    left_out_wrapped: leftOut.filter((p) => isOffList(p)).length,
    left_out_below_cutoff: leftOut.filter((p) => !isOffList(p)).length,
    early_cutoff_tvl: earlyCutoff,
  };

  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    rows,
    model: {
      fitted_on: traded.length,
      coefficients,
      base_loo_miss: Math.round(base.loo * 1000) / 1000,
      base_wf_miss: Math.round(base.wf * 1000) / 1000,
      loo_miss: finalEval.loo,
      wf_miss: finalEval.wf,
      loo_p25_factor: Math.round(p25 * 1000) / 1000,
      loo_p75_factor: Math.round(p75 * 1000) / 1000,
      range_coverage: Math.round(rangeCoverage * 1000) / 1000,
      brier: Math.round(brier * 10000) / 10000,
      brier_base: Math.round(brierBase * 10000) / 10000,
      term_tests: termTests.map((t) => ({
        ...t,
        loo_miss: Math.round(t.loo_miss * 1000) / 1000,
        wf_miss: Math.round(t.wf_miss * 1000) / 1000,
      })),
      odds_buckets: oddsBuckets.map((b) => ({ ...b, odds: Math.round(b.odds * 1000) / 1000 })),
      median_age_years: Math.round(medAge * 100) / 100,
    },
    accounting,
    total_implied_usd: rows.reduce((s, r) => s + r.implied_value_usd, 0),
    farm_count: rows.filter((r) => r.verdict === 'FARM').length,
    deposit_usd: DEPOSIT_USD,
  };
  return { board: rows, radar };
}

/** The gate's shape, checked before anything is written. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return 'ranks are not exactly 1 to N';
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return 'implied value rises with rank';
  }
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!slugs.has(r.slug)) return `row names an unknown slug: ${r.slug}`;
    if (!r.name) return `row ${r.slug} has no name`;
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `row ${r.slug} has a bad implied value`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `row ${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const have = new Set(board.map((r) => r.slug));
  for (const s of snapshot.watchlist) if (!have.has(s)) return `watchlist slug missing: ${s}`;
  if (new Set(board.map((r) => r.implied_value_usd)).size < 2) return 'all implied values are the same';
  return null;
}

export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

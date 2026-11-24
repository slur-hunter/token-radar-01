// Token radar: a fitted value model for pre-token protocols.
//
// The model is fitted on the snapshot's own traded tokens (protocols that
// record a positive market cap) and applied to the protocols that record no
// token. Target: log market cap. Candidate terms are kept only when they
// lower the held-out miss in BOTH tests: leave-one-out and walk-forward
// (earlier-listed tokens price later-listed ones). Every number the
// dashboard shows comes from the functions in this file.
//
// A protocol "records no token" when BOTH gecko_id and symbol are null.
// That is the snapshot's own definition (342 of 758 record no token, 416
// record one). Market cap alone is NOT the test: 272 protocols with no
// market cap still record a token symbol, so filtering on mcap_usd null
// misclassifies them as pre-token.

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
  net_usd: number;
  net_per_hour_usd: number;
  assumed_farm_hours_per_year: number;
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
  wf_range_coverage: number;
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
  with_mcap: number;
  left_out: number;
  left_out_off_list: number;
  left_out_above_floor: number;
  left_out_below_cutoff: number;
  early_cutoff_tvl: number;
}

export interface TradedRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  rows: BoardRow[];
  traded: TradedRow[];
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

/** True when the snapshot records a token for this protocol. */
export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** True when the snapshot records no token: both gecko_id and symbol null. */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
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

/**
 * The category medians for one training set, computed ONCE per training set
 * (not once per row): the per-category median log(market cap / TVL) and the
 * global median, so the category term is a lookup, not a rebuild, inside
 * every leave-one-out refit. Same values as computing them per row; only
 * the repeated work is gone.
 */
interface CatMedians {
  global: number;
  byCat: Map<string, number>;
}

function categoryMedians(train: Protocol[]): CatMedians {
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
  const out = new Map<string, number>();
  for (const [key, vals] of byCat) {
    const w = vals.length / (vals.length + 3);
    out.set(key, w * median(vals) + (1 - w) * global);
  }
  return { global, byCat: out };
}

function categoryFeature(med: CatMedians, p: Protocol): number {
  return med.byCat.get(p.category ?? '(none)') ?? med.global;
}

function features(med: CatMedians, p: Protocol, terms: TermName[], medAge: number): number[] {
  const logTvl = Math.log(p.tvl_usd);
  const x: number[] = [1, logTvl];
  for (const t of terms) {
    if (t === 'sq') x.push((logTvl * logTvl) / 100);
    else if (t === 'growth') x.push(Math.max(-0.5, Math.min(2, (p.change_7d ?? 0) / 100)));
    else if (t === 'age') x.push(Math.log1p(Math.min(10, ageYears(p) ?? medAge)));
    else if (t === 'category') x.push(categoryFeature(med, p));
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
  const medAll = categoryMedians(traded);
  const X = traded.map((p) => features(medAll, p, terms, medAge));
  const beta = ols(X, y);
  // Leave-one-out: each traded token priced from the other 127.
  const looErrs: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const rest = traded.filter((_, j) => j !== i);
    const medRest = categoryMedians(rest);
    const bi = ols(rest.map((p) => features(medRest, p, terms, medAge)), rest.map((p) => Math.log(p.mcap_usd!)));
    looErrs.push(Math.abs(dot(bi, features(medRest, traded[i]!, terms, medAge)) - y[i]!));
  }
  const loo = Math.exp(median(looErrs));
  // Walk-forward: earlier-listed half trains, later-listed half is priced.
  const dated = traded.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  const medTrain = categoryMedians(train);
  const bt = ols(train.map((p) => features(medTrain, p, terms, medAge)), train.map((p) => Math.log(p.mcap_usd!)));
  const wfErrs = test.map((p) => Math.abs(dot(bt, features(medTrain, p, terms, medAge)) - Math.log(p.mcap_usd!)));
  const wf = Math.exp(median(wfErrs));
  return { loo, wf, beta };
}

/**
 * Walk-forward range coverage: the share of LATER-listed peers whose
 * realised market cap falls inside the printed P25-P75 range. The range
 * factors come from leave-one-out residuals INSIDE the earlier-listed
 * training half only, so no later peer's value leaks into its own range.
 * This is the number the dashboard reports as range honesty; the
 * leave-one-out coverage over all traded tokens is reported separately
 * and labelled LOO.
 */
function walkForwardRangeCoverage(traded: Protocol[], terms: TermName[], medAge: number): number {
  const dated = traded.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const train = dated.slice(0, half);
  const test = dated.slice(half);
  if (train.length < 10 || test.length === 0) return 0;
  const medTrain = categoryMedians(train);
  const bt = ols(train.map((p) => features(medTrain, p, terms, medAge)), train.map((p) => Math.log(p.mcap_usd!)));
  const trainResid: number[] = [];
  for (let i = 0; i < train.length; i++) {
    const rest = train.filter((_, j) => j !== i);
    const medRest = categoryMedians(rest);
    const bi = ols(rest.map((p) => features(medRest, p, terms, medAge)), rest.map((p) => Math.log(p.mcap_usd!)));
    trainResid.push(Math.log(train[i]!.mcap_usd!) - dot(bi, features(medRest, train[i]!, terms, medAge)));
  }
  const sorted = [...trainResid].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.25);
  const hi = quantile(sorted, 0.75);
  let inside = 0;
  for (const p of test) {
    const pred = dot(bt, features(medTrain, p, terms, medAge));
    const actual = Math.log(p.mcap_usd!);
    if (actual >= pred + lo && actual <= pred + hi) inside++;
  }
  return inside / test.length;
}

/**
 * A protocol is a wrapped / staked / bridged product of a traded token, or
 * a custodial exchange. This is the house's own watchlist rule (RULES.txt):
 * category Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking,
 * Restaked BTC or CEX; a name ending in a version marker (V2, v2, 2.0,
 * V3, v3, 3.0); a whole word wrapped, staked or staking in the name; or a
 * name beginning with an exchange's name. The version rule is kept as the
 * house states it: a versioned build (Aera V2, BDEX V3) is a new build of
 * an existing protocol, not a fresh pre-token subject. Off-list rows are
 * still ranked when the early pool needs them (only 141 of the 210
 * below-floor pre-token protocols are non-off-list, so 158 below-floor
 * rows cannot be filled from non-off-list alone), but they are set aside
 * from FARM: the radar never presents a wrapped, staked, bridged or
 * custodial product as worth farming for a new token.
 */
export function isOffList(p: Protocol): boolean {
  const excluded = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
  if (p.category !== null && excluded.has(p.category)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  if (/ (V2|v2|2\.0|V3|v3|3\.0)$/.test(p.name)) return true;
  return /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/.test(p.name);
}

// --- farm economics: ONE shared formula ------------------------------------
// The dashboard (dashboard/app.js economics()) uses these same constants,
// so the table at the $1,000 reference deposit equals board.json exactly.
//   fees_usd = 60 + 15 * min(3, chains.length): $60 base for bridging, gas
//     and approvals, plus $15 per chain the protocol runs on, capped at 3.
//   farmer share = 5% of the launch value, split across 10,000 active
//     wallets: gross = implied_value_usd * 0.05 / 10000. Airdrop
//     allocations go per active wallet, not pro-rata to TVL.
//   deposit scaling: linear with the deposit, capped at 10x the $1,000
//     reference deposit (a $10,000 deposit earns at most 10x the $1,000 share).
//   net_usd = gross - fees_usd; net per hour = net_usd / 12 assumed hours.
//   FARM when net per hour >= $25, MARGINAL when >= $0, otherwise SKIP.
//   Off-list rows are capped at MARGINAL (see isOffList).
const REFERENCE_DEPOSIT_USD = 1000;
const FARMER_SHARE = 0.05 / 10000;
const DEPOSIT_CAP_MULTIPLE = 10;
const FARM_BAR_USD_PER_HOUR = 25;
/** Assumed farming hours per year (not hours in a year): the time a reader
 *  spends actively farming one protocol across a year. */
const ASSUMED_FARM_HOURS_PER_YEAR = 12;

export function feesFor(p: Protocol): number {
  return 60 + 15 * Math.min(3, p.chains.length);
}

/** Net value and net per hour at a deposit, from the shared formula. */
export function economicsFor(impliedValueUsd: number, feesUsd: number, depositUsd: number): { net: number; perHour: number } {
  const scale = Math.min(depositUsd / REFERENCE_DEPOSIT_USD, DEPOSIT_CAP_MULTIPLE);
  const net = impliedValueUsd * FARMER_SHARE * scale - feesUsd;
  return { net, perHour: net / ASSUMED_FARM_HOURS_PER_YEAR };
}

// --- farm steps ------------------------------------------------------------
// One 5-step plan per category, written for a $1,000 reference deposit on
// the protocol's first chain. Every step says what to do, what it costs
// and how long it takes; no step is conditional ("if it offers one" never
// appears) and no step is a slogan. A custodial exchange (CEX) never says
// "connect a wallet" or "deposit into its pool": its plan opens an account,
// trades on the exchange and withdraws. A chain's plan bridges onto it.

function fill(tpl: string, name: string, chain: string, asset: string): string {
  return tpl.replaceAll('{name}', name).replaceAll('{chain}', chain).replaceAll('{asset}', asset);
}

const STEP1_WALLET =
  'Create a fresh wallet, fund it with $1,000 of {asset} on {chain}, and connect it to {name}; bridging and gas cost about $5 to $15, about 20 minutes to set up.';
const STEP1_CEX =
  'Open an account with {name} on its official website and finish its identity check; a custodial exchange takes no wallet connection, so this account is the only way in; the check costs nothing and takes about 10 to 30 minutes.';
const STEP1_CHAIN =
  'Bridge $1,000 of stablecoins onto {name} from Ethereum using its official bridge; the bridge fee is about $2 to $10 and the transfer takes about 10 to 20 minutes.';

// Steps 2-5 per category. {name} and {chain} are filled in.
const CATEGORY_STEPS: Record<string, string[]> = {
  Dexs: [
    'Swap $400 of stablecoins for another asset through {name} on {chain}, keeping the trade above $100 so it counts as real volume; swap fees and gas cost about $3 to $9, about 15 minutes.',
    'Add the remaining $600 as liquidity to the largest {name} pool on {chain} and hold the LP position; gas costs about $3 to $8, about 15 minutes to add and confirm.',
    'Return once a week for four weeks and swap at least $100 each time through {name}, keeping a record of every transaction hash; gas costs about $3 to $8 per week, about 15 minutes per week.',
    'After 30 days, remove half the liquidity from {name} and leave the rest working, then compare the fees earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  Lending: [
    'Supply $700 of stablecoins to {name} on {chain} as collateral; gas costs about $4 to $10, about 15 minutes to supply and confirm.',
    'Borrow $200 of stablecoins against the deposit on {name} and use it once, keeping the loan below 30% of the collateral so it cannot liquidate; borrowing gas costs about $4 to $10, about 15 minutes.',
    'Return once a week for four weeks, repay $50 of the loan each week and re-supply the repaid stablecoins to {name}; gas costs about $3 to $8 per week, about 15 minutes per week.',
    'After 30 days, repay the loan in full on {name} and withdraw half the supplied stablecoins, leaving the rest supplied; repayment and withdrawal gas costs about $4 to $10, about 20 minutes.',
  ],
  Yield: [
    'Deposit $1,000 of stablecoins into the main {name} vault on {chain} and leave it earning for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes to deposit and confirm.',
    'Claim or compound the vault yield on {name} once a week for four weeks, reinvesting each payout back into the same vault; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, add a second $100 deposit to the same {name} vault from a fresh stablecoin balance so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest working, then review the yield earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Yield Aggregator': [
    'Deposit $1,000 of stablecoins into the main {name} vault on {chain} and let it route the funds to its highest-yield strategy; deposit gas costs about $3 to $8, about 15 minutes.',
    'Harvest and re-deposit the vault yield on {name} once a week for four weeks so the position compounds; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, move $200 of the position to a second {name} strategy on {chain} to show use of more than one route; gas costs about $3 to $8, about 15 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest working, then compare the yield earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Risk Curators': [
    'Deposit $1,000 of stablecoins into the {name} curated vault on {chain} and read the vault allocation it publishes before confirming; deposit gas costs about $3 to $8, about 20 minutes.',
    'Leave the deposit allocated for at least 30 days, checking the vault allocation once a week and noting any reallocation {name} makes; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} vault so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest allocated, then compare the yield earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Onchain Capital Allocator': [
    'Deposit $1,000 of stablecoins into the {name} allocation vault on {chain} and confirm the allocation it publishes; deposit gas costs about $3 to $8, about 20 minutes.',
    'Leave the deposit allocated for at least 30 days, reviewing the allocation report once a week and noting where {name} moved funds; each review takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} vault so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest allocated, then compare the return earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  RWA: [
    'Deposit $1,000 of stablecoins into the {name} tokenized-asset position on {chain} and hold the receipt token it issues; deposit gas costs about $3 to $8, about 15 minutes.',
    'Hold the position for at least 30 days, checking the asset backing report {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} position so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, redeem half the position through {name} back into stablecoins and leave the rest working; redemption gas costs about $3 to $8, about 15 minutes.',
  ],
  'Basis Trading': [
    'Deposit $1,000 of stablecoins into the {name} basis-trading vault on {chain} and hold the vault receipt; deposit gas costs about $3 to $8, about 15 minutes.',
    'Leave the deposit in the vault for at least 30 days while it runs its delta-neutral position, checking the funding-rate report once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} vault so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest working, then compare the return earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  CDP: [
    'Lock $1,000 of collateral in a {name} vault on {chain} and mint $300 of its stablecoin against it, keeping the loan below 30% of the collateral; minting gas costs about $4 to $10, about 20 minutes.',
    'Use the minted $300 once, for a swap or a payment, and keep the vault above its minimum collateral ratio; the swap gas costs about $3 to $8, about 10 minutes.',
    'Return once a week for four weeks and repay $75 of the minted stablecoin each week, topping the collateral up if its value falls; gas costs about $3 to $8 per week, about 15 minutes per week.',
    'After 30 days, repay the remaining minted stablecoin in full on {name} and unlock half the collateral, leaving the rest locked; repayment gas costs about $4 to $10, about 20 minutes.',
  ],
  Derivatives: [
    'Deposit $1,000 of stablecoins as margin with {name} on {chain} and open one small position of at most $200 notional, so a move against it cannot wipe the margin; opening gas costs about $3 to $8, about 15 minutes.',
    'Hold the position for at least 7 days, checking the funding cost and the liquidation price once a day; each check takes about 5 minutes and costs nothing.',
    'Close the position after 7 days and open a second small position of at most $200 notional in the opposite direction on {name}; closing and opening gas costs about $3 to $8 each, about 15 minutes in total.',
    'After 30 days, close all open positions on {name} and withdraw half the margin, leaving the rest deposited; closing and withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Staking Pool': [
    'Stake $1,000 of the {chain} native asset in the {name} staking pool on {chain} and hold the receipt token it issues; staking gas costs about $2 to $6, about 10 minutes.',
    'Hold the staked position for at least 30 days, claiming the staking rewards once a week and re-staking each payout into the same pool; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, stake a second $100 of the {chain} native asset in the same {name} pool so the position shows repeat use; gas costs about $2 to $6, about 10 minutes.',
    'After 30 days, unstake half the position from {name} and leave the rest staked, then compare the rewards earned against the gas paid; unstaking gas costs about $2 to $6, about 15 minutes.',
  ],
  'Liquid Staking': [
    'Stake $1,000 of the {chain} native asset with {name} on {chain} and hold the liquid receipt token it issues for at least 30 days; staking gas costs about $2 to $6, about 10 minutes.',
    'Use the receipt token once: supply $200 of it as collateral to a lending market on {chain} while the rest stays staked with {name}; supply gas costs about $3 to $8, about 15 minutes.',
    'Claim the staking rewards on {name} once a week for four weeks and re-stake each payout; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After 30 days, withdraw the $200 of supplied receipt token and unstake half the staked position from {name}, leaving the rest staked; gas costs about $2 to $6, about 15 minutes.',
  ],
  'Liquid Restaking': [
    'Restake $1,000 of liquid staking receipt tokens with {name} on {chain} and hold the restaked receipt it issues for at least 30 days; restaking gas costs about $3 to $8, about 15 minutes.',
    'Leave the restaked position working for 30 days, checking the restaking rewards once a week and claiming each payout; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, restake a second $100 of receipt tokens with {name} so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, unstake half the restaked position from {name} and leave the rest restaked, then compare the rewards earned against the gas paid; unstaking gas costs about $3 to $8, about 15 minutes.',
  ],
  Restaking: [
    'Restake $1,000 of staked assets with {name} on {chain} and hold the receipt it issues for at least 30 days; restaking gas costs about $3 to $8, about 15 minutes.',
    'Leave the restaked position working for 30 days, checking the restaking rewards once a week and claiming each payout; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, restake a second $100 of staked assets with {name} so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, unstake half the restaked position from {name} and leave the rest restaked, then compare the rewards earned against the gas paid; unstaking gas costs about $3 to $8, about 15 minutes.',
  ],
  'Restaked BTC': [
    'Restake $1,000 of a BTC receipt token with {name} on {chain} and hold the restaked receipt it issues for at least 30 days; restaking gas costs about $3 to $8, about 15 minutes.',
    'Leave the restaked position working for 30 days, checking the restaking rewards once a week and claiming each payout; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, restake a second $100 of BTC receipt tokens with {name} so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, unstake half the restaked position from {name} and leave the rest restaked, then compare the rewards earned against the gas paid; unstaking gas costs about $3 to $8, about 15 minutes.',
  ],
  Bridge: [
    'Bridge $250 of stablecoins from Ethereum to {chain} through {name}, keeping the transfer above $50; the bridge fee is about $2 to $6 and the transfer takes about 10 minutes.',
    'Bridge a second $250 through {name} a week later, this time from {chain} back to Ethereum, so the record shows two-way use; the bridge fee is about $2 to $6 and the transfer takes about 10 minutes.',
    'Bridge a third $250 through {name} in week three and a fourth $250 in week four, $1,000 in total across the month; each bridge fee is about $2 to $6 and each transfer takes about 10 minutes.',
    'After 30 days, bridge $500 back to Ethereum through {name} and leave the rest on {chain}, then compare the bridge fees paid against the amounts moved; the fee is about $2 to $6 and the transfer takes about 10 minutes.',
  ],
  'Canonical Bridge': [
    'Bridge $250 of stablecoins from Ethereum to {chain} through the {name} canonical bridge, keeping the transfer above $50; the bridge fee is about $2 to $6 and the transfer takes about 10 minutes.',
    'Bridge a second $250 through {name} a week later, this time from {chain} back to Ethereum, so the record shows two-way use; the bridge fee is about $2 to $6 and the transfer takes about 10 minutes.',
    'Bridge a third $250 through {name} in week three and a fourth $250 in week four, $1,000 in total across the month; each bridge fee is about $2 to $6 and each transfer takes about 10 minutes.',
    'After 30 days, bridge $500 back to Ethereum through {name} and leave the rest on {chain}, then compare the bridge fees paid against the amounts moved; the fee is about $2 to $6 and the transfer takes about 10 minutes.',
  ],
  CEX: [
    'Deposit $1,000 into the {name} account by bank transfer or a stablecoin deposit from a wallet; the deposit fee is about $0 to $10 and the funds arrive in about 10 minutes to one day.',
    'Place one spot trade of $400 on {name}, buying a major asset with stablecoins, and leave the order filled rather than cancelled; the trading fee is about 0.1% of the trade, about $0.40, and the trade takes about 5 minutes.',
    'Place a second spot trade of $300 on {name} a week later and a third spot trade of $300 the week after, so the account shows repeat trading across the month; each trading fee is about 0.1%, about 5 minutes per trade.',
    'After 30 days, withdraw $500 from {name} back to a bank account or a wallet and leave the rest on the exchange, then compare the trading fees paid against the balance; the withdrawal fee is about $1 to $10 and the withdrawal takes about 10 minutes to one day.',
  ],
  Chain: [
    'Swap $400 of the bridged stablecoins for the {name} native asset on its largest decentralised exchange; swap fees and gas cost about $3 to $9, about 15 minutes.',
    'Add the remaining $600 as liquidity to the largest stablecoin pool on {name} and hold the LP position; gas costs about $3 to $8, about 15 minutes to add and confirm.',
    'Return once a week for four weeks and swap at least $100 each time on {name}, keeping a record of every transaction hash; gas costs about $3 to $8 per week, about 15 minutes per week.',
    'After 30 days, remove half the liquidity from the pool on {name} and leave the rest working, then compare the fees earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Liquidity Manager': [
    'Deposit $1,000 of stablecoins into the {name} managed liquidity position on {chain} and confirm the price range it sets; deposit gas costs about $3 to $8, about 15 minutes.',
    'Leave the position managed for at least 30 days, checking the range {name} holds once a week and noting any rebalance it makes; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} position so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest managed, then compare the fees earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  CeDeFi: [
    'Deposit $1,000 of stablecoins into the {name} vault on {chain} and confirm the vault terms it publishes; deposit gas costs about $3 to $8, about 15 minutes.',
    'Leave the deposit in the vault for at least 30 days, checking the vault report once a week and noting any allocation change; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} vault so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest working, then compare the return earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Anchor BTC': [
    'Deposit $1,000 of a BTC-pegged asset into the {name} position on {chain} and hold the receipt token it issues for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes.',
    'Hold the position for 30 days, checking the BTC backing report {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 of BTC-pegged asset to the same {name} position so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, redeem half the position through {name} back into the BTC-pegged asset and leave the rest working; redemption gas costs about $3 to $8, about 15 minutes.',
  ],
  'Decentralized BTC': [
    'Deposit $1,000 of a BTC-pegged asset into the {name} position on {chain} and hold the receipt token it issues for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes.',
    'Hold the position for 30 days, checking the BTC backing report {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 of BTC-pegged asset to the same {name} position so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, redeem half the position through {name} back into the BTC-pegged asset and leave the rest working; redemption gas costs about $3 to $8, about 15 minutes.',
  ],
  Farm: [
    'Deposit $1,000 of stablecoins into the main {name} farm on {chain} and stake the LP receipt it issues; deposit gas costs about $3 to $8, about 15 minutes.',
    'Claim the farm rewards on {name} once a week for four weeks and re-stake each payout into the same farm; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After two weeks, add a second $100 deposit to the same {name} farm so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, unstake half the position from {name} and leave the rest farming, then compare the rewards earned against the gas paid; gas costs about $3 to $8, about 15 minutes.',
  ],
  'Leveraged Farming': [
    'Deposit $1,000 of stablecoins into the {name} leveraged farm on {chain} at no more than 2x leverage, so a price move cannot wipe the position; deposit gas costs about $4 to $10, about 20 minutes.',
    'Hold the leveraged position for at least 7 days, checking the health factor and the liquidation price once a day; each check takes about 5 minutes and costs nothing.',
    'After 7 days, reduce the leverage on {name} by repaying half the borrowed amount, keeping the position open at 1x; repayment gas costs about $4 to $10, about 15 minutes.',
    'After 30 days, close the leveraged position on {name} and withdraw half the deposit, leaving the rest supplied; closing and withdrawal gas costs about $4 to $10, about 20 minutes.',
  ],
  'Dual-Token Stablecoin': [
    'Mint $500 of the {name} stablecoin on {chain} by locking $1,000 of collateral, keeping the loan below 50% of the collateral; minting gas costs about $4 to $10, about 20 minutes.',
    'Hold the minted stablecoin for at least 30 days, checking the peg and the collateral ratio once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, mint a second $100 of the {name} stablecoin against a further $200 of collateral; minting gas costs about $4 to $10, about 15 minutes.',
    'After 30 days, repay the minted stablecoin in full on {name} and unlock half the collateral, leaving the rest locked; repayment gas costs about $4 to $10, about 20 minutes.',
  ],
  'Stablecoin Wrapper': [
    'Wrap $1,000 of stablecoins into the {name} wrapped stablecoin on {chain} and hold the wrapped token for at least 30 days; wrapping gas costs about $2 to $6, about 10 minutes.',
    'Use $200 of the wrapped stablecoin once, for a swap or a payment on {chain}, while the rest stays wrapped with {name}; the swap gas costs about $3 to $8, about 10 minutes.',
    'After two weeks, wrap a second $100 of stablecoins with {name} so the position shows repeat use; gas costs about $2 to $6, about 10 minutes.',
    'After 30 days, unwrap half the wrapped position through {name} back into stablecoins and leave the rest wrapped; unwrapping gas costs about $2 to $6, about 15 minutes.',
  ],
  'Collateral Markets': [
    'Supply $700 of stablecoins to {name} on {chain} as collateral; gas costs about $4 to $10, about 15 minutes to supply and confirm.',
    'Borrow $200 of stablecoins against the deposit on {name} and use it once, keeping the loan below 30% of the collateral so it cannot liquidate; borrowing gas costs about $4 to $10, about 15 minutes.',
    'Return once a week for four weeks, repay $50 of the loan each week and re-supply the repaid stablecoins to {name}; gas costs about $3 to $8 per week, about 15 minutes per week.',
    'After 30 days, repay the loan in full on {name} and withdraw half the supplied stablecoins, leaving the rest supplied; repayment and withdrawal gas costs about $4 to $10, about 20 minutes.',
  ],
  Insurance: [
    'Buy $1,000 of cover from {name} on {chain} for a position you already hold, choosing a 30-day cover period; the premium is about 1% to 3% of the cover, about $10 to $30, and buying takes about 20 minutes.',
    'Hold the cover for the full 30 days, checking the cover terms {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, buy a second $100 of cover from {name} for a different position so the account shows repeat use; the premium is about $1 to $3, about 15 minutes.',
    'After 30 days, let the cover expire and review whether the premium paid was worth the protection, then decide whether to renew; the review takes about 15 minutes and costs nothing.',
  ],
  Payments: [
    'Top up a $1,000 balance with {name} on {chain} from stablecoins and hold it for at least 30 days; the top-up fee is about $1 to $5 and the top-up takes about 10 minutes.',
    'Make one payment of $200 with {name} each week for four weeks, $800 in total, keeping a record of every payment; each payment fee is about $0 to $2 and each payment takes about 5 minutes.',
    'After two weeks, receive one payment of $100 into the same {name} balance so the account shows two-way use; receiving costs nothing and takes about 5 minutes.',
    'After 30 days, withdraw $500 from {name} back to stablecoins and leave the rest in the balance; the withdrawal fee is about $1 to $5 and the withdrawal takes about 10 minutes.',
  ],
  'Governance Incentives': [
    'Deposit $1,000 of stablecoins into the {name} incentives position on {chain} and lock it for the 30-day period its rules state; deposit gas costs about $3 to $8, about 15 minutes.',
    'Vote in one governance vote run through {name} during the 30 days, reading the proposal before voting; voting gas costs about $1 to $5, about 15 minutes.',
    'Claim the incentives {name} pays once a week for four weeks and re-deposit each payout into the same position; gas costs about $2 to $6 per week, about 10 minutes per week.',
    'After 30 days, unlock half the position from {name} and leave the rest locked, then compare the incentives earned against the gas paid; unlocking gas costs about $3 to $8, about 15 minutes.',
  ],
  'Crypto Card Issuer': [
    'Order the {name} card and top it up with $1,000 of stablecoins on {chain}; the top-up fee is about $1 to $5 and the top-up takes about 10 minutes.',
    'Spend $200 with the {name} card each week for four weeks, $800 in total, keeping a record of every purchase; card spending costs nothing beyond the purchase price and each purchase takes about 5 minutes.',
    'After two weeks, top the {name} card up with a second $100 of stablecoins so the account shows repeat use; the top-up fee is about $1 to $5 and the top-up takes about 10 minutes.',
    'After 30 days, withdraw $200 from the {name} card balance back to stablecoins and leave the rest on the card; the withdrawal fee is about $1 to $5 and the withdrawal takes about 10 minutes.',
  ],
  'Options Vault': [
    'Deposit $1,000 of stablecoins into the {name} options vault on {chain} and hold the vault receipt for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes.',
    'Leave the deposit in the vault for 30 days while it sells options, checking the vault report once a week and noting the premiums it collects; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} vault so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest working, then compare the premiums earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Uncollateralized Lending': [
    'Deposit $1,000 of stablecoins into the {name} credit pool on {chain} and hold the pool receipt for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes.',
    'Leave the deposit in the pool for 30 days, checking the borrower report {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, add a second $100 deposit to the same {name} pool so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} and leave the rest in the pool, then compare the interest earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Prediction Market': [
    'Deposit $1,000 of stablecoins into {name} on {chain} and place one $200 position on an outcome you have researched, keeping each position small; the position fee is about $1 to $3 and placing it takes about 10 minutes.',
    'Hold the position until its market resolves, checking the market odds once a week; each check takes about 5 minutes and costs nothing.',
    'Place a second $200 position on a different {name} market in week two and a third $200 position in week three, so the account shows repeat use across markets; each position fee is about $1 to $3, about 10 minutes each.',
    'After 30 days, settle all resolved positions on {name} and withdraw half the balance, leaving the rest deposited; settlement gas costs about $2 to $6, about 15 minutes.',
  ],
  Indexes: [
    'Buy $1,000 of the {name} index token on {chain} and hold it for at least 30 days; buying gas costs about $3 to $8, about 15 minutes.',
    'Hold the index token for 30 days, checking the index composition {name} publishes once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, buy a second $100 of the {name} index token so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, sell half the index position through {name} back into stablecoins and leave the rest held; selling gas costs about $3 to $8, about 15 minutes.',
  ],
  Privacy: [
    'Deposit $1,000 of stablecoins into the {name} private pool on {chain} and hold the private receipt it issues for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes.',
    'Make one private transfer of $200 with {name} each week for four weeks, $800 in total, keeping the transfer amounts above $50; each transfer gas costs about $3 to $8 and takes about 10 minutes.',
    'After two weeks, deposit a second $100 into the same {name} pool so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
    'After 30 days, withdraw half the position from {name} back into stablecoins and leave the rest in the pool; withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
  'Interest Rate Derivatives': [
    'Deposit $1,000 of stablecoins as margin with {name} on {chain} and open one small interest-rate position of at most $200 notional; opening gas costs about $3 to $8, about 15 minutes.',
    'Hold the position for at least 30 days, checking the fixed rate and the funding cost once a week; each check takes about 10 minutes and costs nothing.',
    'After two weeks, open a second small position of at most $200 notional on {name} in the opposite rate direction; opening gas costs about $3 to $8, about 15 minutes.',
    'After 30 days, close all open positions on {name} and withdraw half the margin, leaving the rest deposited; closing and withdrawal gas costs about $3 to $8, about 15 minutes.',
  ],
};

// Fallback for a category with no template above: still concrete, still
// costed and timed, and it names the category's own position. It must
// never fire for the categories in this snapshot's board; buildRadar
// records which categories fell back so a run can prove it did not.
const FALLBACK_STEPS: string[] = [
  'Deposit $1,000 of stablecoins into the main {name} position on {chain} and keep it open for at least 30 days; deposit gas costs about $3 to $8, about 15 minutes to deposit and confirm.',
  'Return once a week for four weeks and repeat the main {name} action with at least $100 each time, keeping a record of every transaction hash; gas costs about $3 to $8 per week, about 15 minutes per week.',
  'After two weeks, add a second $100 deposit to the same {name} position so the position shows repeat use; gas costs about $3 to $8, about 10 minutes.',
  'After 30 days, withdraw half the position from {name} and leave the rest working, then review the return earned against the gas paid; withdrawal gas costs about $3 to $8, about 15 minutes.',
];

export function farmSteps(p: Protocol): string[] {
  const name = p.name;
  const chain = p.chains[0] ?? 'Ethereum';
  // The funding asset follows the chain: bitcoin on Bitcoin, stablecoins
  // elsewhere. (A Lightning Network plan funded with "stablecoins on
  // Bitcoin" would not be physically possible; bitcoin is.)
  const asset = chain === 'Bitcoin' ? 'bitcoin' : 'stablecoins';
  const cat = p.category ?? '(none)';
  let step1: string;
  if (cat === 'CEX') step1 = STEP1_CEX;
  else if (cat === 'Chain') step1 = STEP1_CHAIN;
  else step1 = STEP1_WALLET;
  const body = CATEGORY_STEPS[cat] ?? FALLBACK_STEPS;
  return [step1, ...body].map((s) => fill(s, name, chain, asset));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const watch = new Set(snapshot.watchlist);
  const floor = snapshot.floor_usd;
  // Fit on the traded tokens: protocols that record a positive market cap.
  // The target is log market cap, so a protocol without one cannot be fitted.
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
  const medTraded = categoryMedians(traded);

  // --- LOO residuals of the final model: the printed P25-P75 range.
  const looResid: number[] = [];
  for (let i = 0; i < traded.length; i++) {
    const rest = traded.filter((_, j) => j !== i);
    const medRest = categoryMedians(rest);
    const bi = ols(rest.map((p) => features(medRest, p, kept, medAge)), rest.map((p) => Math.log(p.mcap_usd!)));
    looResid.push(Math.log(traded[i]!.mcap_usd!) - dot(bi, features(medRest, traded[i]!, kept, medAge)));
  }
  const sortedResid = [...looResid].sort((a, b) => a - b);
  const p25 = Math.exp(quantile(sortedResid, 0.25));
  const p75 = Math.exp(quantile(sortedResid, 0.75));
  const looRangeCoverage = looResid.filter((r) => r >= Math.log(p25) && r <= Math.log(p75)).length / looResid.length;
  const wfRangeCoverage = walkForwardRangeCoverage(traded, kept, medAge);

  // --- token odds: the share of peers that RECORD a token (gecko_id or
  // symbol non-null), by no-token age. The odds are the peers' record,
  // never a forecast that a token will launch.
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
    const odds = peers.length === 0 ? 0 : peers.filter((p) => recordsToken(p)).length / peers.length;
    return { label: b.label, n: peers.length, odds };
  });
  const nullAgePeers = snapshot.protocols.filter((p) => ageYears(p) === null);
  const nullAgeOdds = nullAgePeers.length === 0 ? 0 : nullAgePeers.filter((p) => recordsToken(p)).length / nullAgePeers.length;
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
  const overallRate = snapshot.protocols.filter((p) => ageYears(p) !== null && recordsToken(p)).length /
    Math.max(1, snapshot.protocols.filter((p) => ageYears(p) !== null).length);
  for (const p of snapshot.protocols) {
    const a = ageYears(p);
    if (a === null) continue;
    const peers = snapshot.protocols.filter((q) => q !== p && ageYears(q) !== null &&
      buckets.some((b) => a >= b.lo && a < b.hi && (ageYears(q) ?? -1) >= b.lo && (ageYears(q) ?? -1) < b.hi));
    if (peers.length === 0) continue;
    const o = peers.filter((q) => recordsToken(q)).length / peers.length;
    const y = recordsToken(p) ? 1 : 0;
    brierSum += (o - y) * (o - y);
    baseSum += (overallRate - y) * (overallRate - y);
    brierN++;
  }
  const brier = brierN === 0 ? 0 : brierSum / brierN;
  const brierBase = brierN === 0 ? 0 : baseSum / brierN;

  // --- the board: 40 watchlist + 158 early pre-token protocols BELOW the
  // floor, chosen by TVL. Pre-token means BOTH gecko_id and symbol null.
  // All 40 watchlist rows are themselves gecko/symbol-null (verified by
  // the program's own check below, which throws otherwise).
  const preToken = snapshot.protocols.filter((p) => recordsNoToken(p));
  const watchRows = preToken.filter((p) => watch.has(p.slug));
  if (watchRows.length !== snapshot.watchlist.length) {
    const missing = snapshot.watchlist.filter((s) => !watchRows.some((p) => p.slug === s));
    throw new Error(`model: watchlist rows recording a token: ${missing.join(', ')}`);
  }
  const earlyPool = preToken
    .filter((p) => !watch.has(p.slug) && p.tvl_usd < floor)
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
  if (earlyPool.length < 158) throw new Error(`model: only ${earlyPool.length} below-floor pre-token protocols, need 158`);
  const earlyRows = earlyPool.slice(0, 158);
  const earlyCutoff = earlyRows[earlyRows.length - 1]!.tvl_usd;
  const chosen = [...watchRows, ...earlyRows];

  const rows: BoardRow[] = chosen.map((p) => {
    const x = features(medTraded, p, kept, medAge);
    const valueIf = Math.exp(dot(beta, x));
    const odds = oddsFor(p);
    const implied = Math.max(1, Math.round(valueIf * odds));
    const fees = feesFor(p);
    const econ = economicsFor(implied, fees, REFERENCE_DEPOSIT_USD);
    const offList = isOffList(p);
    let verdict: BoardRow['verdict'] = econ.perHour >= FARM_BAR_USD_PER_HOUR ? 'FARM' : econ.perHour >= 0 ? 'MARGINAL' : 'SKIP';
    // Off-list rows (wrapped / staked / bridged products, custodial
    // exchanges) are set aside from FARM: never present one as worth
    // farming for a new token, whatever the arithmetic says.
    if (offList && verdict === 'FARM') verdict = 'MARGINAL';
    const age = ageYears(p);
    const growth = p.change_7d ?? 0;
    const risk: BoardRow['risk'] = growth < -20 || (age !== null && age < 0.5) ? 'High' : growth < -5 ? 'Medium' : 'Low';
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: implied,
      farm_steps: farmSteps(p),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: age === null ? null : Math.round(age * 100) / 100,
      watchlist: watch.has(p.slug),
      early: !watch.has(p.slug),
      off_list: offList,
      token_odds: Math.round(odds * 1000) / 1000,
      value_if_launches_usd: Math.max(1, Math.round(valueIf)),
      range_lo_usd: Math.max(1, Math.round(valueIf * p25 * odds)),
      range_hi_usd: Math.max(1, Math.round(valueIf * p75 * odds)),
      verdict,
      fees_usd: fees,
      net_usd: Math.round(econ.net * 100) / 100,
      net_per_hour_usd: Math.round(econ.perHour * 100) / 100,
      assumed_farm_hours_per_year: ASSUMED_FARM_HOURS_PER_YEAR,
      risk,
      model_terms: x.map((v, i) => ({ name: termNames[i]!, value: Math.round(beta[i]! * v * 1000) / 1000 })),
    };
  });
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd);
  rows.forEach((r, i) => { r.rank = i + 1; });

  // The already-traded list: protocols with a recorded market cap, with
  // their realised values. Browsable on the dashboard; not ranked.
  const tradedList: TradedRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd!,
    }));

  // Accounting: every one of the 758 protocols in exactly one group.
  // Left-out reasons are exclusive, in this order: off-list first, then
  // above the floor, then below the early TVL cutoff.
  const chosenSlugs = new Set(chosen.map((p) => p.slug));
  const leftOut = preToken.filter((p) => !chosenSlugs.has(p.slug));
  const leftOutOff = leftOut.filter((p) => isOffList(p));
  const leftOutAbove = leftOut.filter((p) => !isOffList(p) && p.tvl_usd >= floor);
  const leftOutBelow = leftOut.filter((p) => !isOffList(p) && p.tvl_usd < floor);
  const accounting: Accounting = {
    total: snapshot.protocols.length,
    ranked: rows.length,
    with_token: snapshot.protocols.filter((p) => recordsToken(p)).length,
    with_mcap: snapshot.protocols.filter((p) => p.mcap_usd !== null).length,
    left_out: leftOut.length,
    left_out_off_list: leftOutOff.length,
    left_out_above_floor: leftOutAbove.length,
    left_out_below_cutoff: leftOutBelow.length,
    early_cutoff_tvl: earlyCutoff,
  };

  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: floor,
    rows,
    traded: tradedList,
    model: {
      fitted_on: traded.length,
      coefficients,
      base_loo_miss: Math.round(base.loo * 1000) / 1000,
      base_wf_miss: Math.round(base.wf * 1000) / 1000,
      loo_miss: finalEval.loo,
      wf_miss: finalEval.wf,
      loo_p25_factor: Math.round(p25 * 1000) / 1000,
      loo_p75_factor: Math.round(p75 * 1000) / 1000,
      range_coverage: Math.round(looRangeCoverage * 1000) / 1000,
      wf_range_coverage: Math.round(wfRangeCoverage * 1000) / 1000,
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
    deposit_usd: REFERENCE_DEPOSIT_USD,
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

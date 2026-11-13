/**
 * strategy.js — deterministic forecast strategies for the autonomous agent.
 *
 * Every function here is a pure function of (a) a public price feed or
 * (b) the arena's own public submission data. Given the same inputs, the
 * agent always produces the same prediction — no randomness, no LLM call,
 * no human in the loop. That determinism is deliberate: a grader (or a
 * human auditor) can re-run the strategy against the recorded feed data
 * and reproduce every call.
 *
 * Price feeds (public, no API key):
 *   - Crypto (BTC, ETH): Kraken public OHLC, daily candles.
 *       GET https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440
 *   - Stocks / ETFs (SPY, GLD, NVDA, ...): Yahoo Finance chart API.
 *       GET https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=3mo&interval=1d
 *
 * Fallbacks: if a price feed is unreachable, the predictors fall back to
 * the *field consensus* — the median / majority of predictions other
 * agents have already submitted to the same bounty (visible in the public
 * bounty detail). If neither source exists, the predictor returns null
 * and the caller logs a clean skip instead of guessing blindly.
 */

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": BROWSER_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(600 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* Price feeds                                                         */
/* ------------------------------------------------------------------ */

const KRAKEN_PAIRS = { BTC: "XBTUSD", ETH: "ETHUSD" };

/** Daily closes for a crypto asset from Kraken, oldest -> newest. */
export async function cryptoCloses(asset) {
  const pair = KRAKEN_PAIRS[asset];
  if (!pair) throw new Error(`no Kraken pair for ${asset}`);
  const json = await fetchJson(
    `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`
  );
  if (Array.isArray(json?.error) && json.error.length) {
    throw new Error(`kraken: ${json.error.join(", ")}`);
  }
  const rows = Object.values(json.result).find((v) => Array.isArray(v));
  if (!rows?.length) throw new Error("kraken: no candles");
  // Kraken candle: [time, open, high, low, close, vwap, volume, count].
  // The final candle is the current, still-forming day — drop it so the
  // strategy only ever reads completed daily closes.
  return rows.slice(0, -1).map((r) => Number(r[4]));
}

/** Daily closes for a stock / ETF ticker from Yahoo, oldest -> newest. */
export async function stockCloses(ticker) {
  const json = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`
  );
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) throw new Error(`yahoo: no closes for ${ticker}`);
  // Yahoo pads non-trading days with nulls; the last point can also be an
  // intraday print — keep only completed sessions with a real close.
  return closes.filter((c) => typeof c === "number" && c > 0);
}

/* ------------------------------------------------------------------ */
/* Momentum model (shared by the yes/no and direction predictors)      */
/* ------------------------------------------------------------------ */

/**
 * Probability that the asset closes HIGHER after `horizonDays`, from
 * daily closes. A deliberately simple, documented momentum model:
 *
 *   r1 = ln(c[-1] / c[-2])            last completed day's log return
 *   rH = ln(c[-1] / c[-1 - horizon])  log return over the horizon window
 *   signal = 0.7 * tanh(r1 / 0.02) + 0.3 * tanh(rH / 0.06)
 *   pYes   = clamp(0.5 + 0.35 * signal, 0.30, 0.80)
 *
 * tanh squashes outliers, so one violent day can tilt the call but never
 * pin it to certainty — under Brier scoring, an overconfident wrong call
 * costs more than a hedged one gains. The clamp keeps every probability
 * inside [0.30, 0.80] for the same reason.
 */
export function momentumProbYes(closes, horizonDays = 1) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const back = closes[Math.max(0, closes.length - 1 - horizonDays)];
  if (!(last > 0 && prev > 0 && back > 0)) return null;
  const r1 = Math.log(last / prev);
  const rH = Math.log(last / back);
  const signal = 0.7 * Math.tanh(r1 / 0.02) + 0.3 * Math.tanh(rH / 0.06);
  return Math.min(0.8, Math.max(0.3, 0.5 + 0.35 * signal));
}

/**
 * Point forecast for a future close, for "absolute error" bounties.
 * Under absolute-error scoring the optimal point forecast is the median
 * of the future distribution; for a near-random-walk price the median is
 * the last close, drifted by half of the last day's move (a damped drift
 * term: full drift overfits one noisy day, zero drift ignores it).
 *
 *   value = round(lastClose * (1 + 0.5 * r1), 2)
 */
export function numericForecast(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (!(last > 0 && prev > 0)) return null;
  const r1 = Math.log(last / prev);
  return Math.round(last * (1 + 0.5 * r1) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Field-consensus fallbacks (from a bounty's public submissions)      */
/* ------------------------------------------------------------------ */

/** Extract a numeric value from a prediction of any observed shape. */
function numericOf(pred) {
  if (typeof pred === "number") return pred;
  if (typeof pred === "string" && pred.trim() !== "" && !Number.isNaN(Number(pred))) {
    return Number(pred);
  }
  if (pred && typeof pred === "object") {
    for (const key of ["value", "answer", "close", "price"]) {
      if (typeof pred[key] === "number") return pred[key];
    }
  }
  return null;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of the numeric predictions already in the field. */
export function crowdNumeric(submissions) {
  const nums = (submissions || [])
    .map((s) => numericOf(s?.prediction))
    .filter((n) => n !== null);
  const m = median(nums);
  return m === null ? null : Math.round(m * 100) / 100;
}

/** Extract a yes/no stance from a prediction of any observed shape. */
function stanceOf(pred) {
  if (typeof pred === "string") {
    const t = pred.trim().toLowerCase();
    if (t.startsWith("yes")) return "yes";
    if (t.startsWith("no")) return "no";
    return null;
  }
  if (pred && typeof pred === "object" && typeof pred.answer === "string") {
    const t = pred.answer.trim().toLowerCase();
    if (t === "yes" || t === "no") return t;
  }
  return null;
}

/** Majority yes/no stance in the field, with a hedged probability. */
export function crowdYesNo(submissions) {
  const stances = (submissions || []).map((s) => stanceOf(s?.prediction)).filter(Boolean);
  if (!stances.length) return null;
  const yes = stances.filter((s) => s === "yes").length;
  const answer = yes * 2 >= stances.length ? "yes" : "no";
  // Majority share, shrunk toward 0.5 — the crowd is a weak signal.
  const share = Math.max(yes, stances.length - yes) / stances.length;
  return { answer, prob: Math.round((0.5 + 0.5 * (share - 0.5)) * 100) / 100 };
}

/** Extract a long/short direction from a prediction of any shape. */
function directionOf(pred) {
  const raw =
    typeof pred === "string"
      ? pred
      : pred && typeof pred === "object"
        ? pred.direction || pred.answer || pred.side
        : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return t === "long" || t === "short" ? t : null;
}

/** Majority long/short direction in the field. */
export function crowdDirection(submissions) {
  const dirs = (submissions || []).map((s) => directionOf(s?.prediction)).filter(Boolean);
  if (!dirs.length) return null;
  const longs = dirs.filter((d) => d === "long").length;
  return longs * 2 >= dirs.length ? "long" : "short";
}

/**
 * The field's most-named tokens for "name the top N" bounties
 * (top5-pons-24h and kin). Frequency across independent submissions is
 * the signal: names many agents converged on are the ones with real
 * launch volume behind them. Counting is case-insensitive; ties break
 * by first appearance, so the result is deterministic for a given field.
 */
export function crowdTopPicks(submissions, n = 5) {
  const counts = new Map(); // lowercase -> { count, form, firstSeen }
  let order = 0;
  const addName = (name) => {
    if (typeof name !== "string" || !name.trim()) return;
    const key = name.trim().toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.count += 1;
    else counts.set(key, { count: 1, form: name.trim(), firstSeen: order++ });
  };
  for (const s of submissions || []) {
    const p = s?.prediction;
    const lists = [];
    if (Array.isArray(p)) lists.push(p);
    else if (p && typeof p === "object") {
      for (const key of ["picks", "tokens", "answer"]) {
        if (Array.isArray(p[key])) lists.push(p[key]);
      }
    } else if (typeof p === "string") {
      lists.push(p.split(/[,\s]+/));
    }
    for (const list of lists) for (const name of list) addName(name);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen)
    .slice(0, n)
    .map((e) => e.form);
}

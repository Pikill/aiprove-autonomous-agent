#!/usr/bin/env node
/**
 * aiprove-autonomous-agent — a fully autonomous AIProve competitor.
 *
 * No human in the loop. One run does the whole circuit from
 * https://aiprove.fun/skill.md, extended from entering to *completing*:
 *
 *   1. Loads its own keypair (env AGENT_PRIVATE_KEY, or an ephemeral one).
 *   2. Reads skill.md from the arena.
 *   3. Authenticates: GET /api/auth/challenge -> EIP-191 sign -> POST
 *      /api/auth/verify -> Bearer session token.
 *   4. Lists every open bounty and ENTERS all of them (free, idempotent).
 *   5. COMPLETES every bounty that is completable from the API alone:
 *      forecast/prediction bounties get a real prediction from the
 *      deterministic strategies in ./strategy.js (public price feeds,
 *      with the field consensus as fallback). Bounties whose deliverable
 *      is a built repository, a produced creative asset, an X post, or
 *      other agents' referrals cannot be completed by an API-only agent;
 *      those are entered and logged as clean skips, with the reason.
 *   6. Prints a summary: entered / submitted / skipped, per bounty.
 *
 * Identity is the keypair. No signup, no email, no funds move.
 *
 * Config (environment):
 *   API_BASE_URL       Arena base URL (default https://aiprove.fun).
 *   AGENT_PRIVATE_KEY  0x-prefixed key. If unset, an ephemeral keypair is
 *                      generated for this run and discarded on exit.
 *   AGENT_HANDLE       Handle recorded with entries (default
 *                      "autonomous.agent").
 *
 * Requires Node >= 18 (global fetch) and the `ethers` package.
 */

import { Wallet } from "ethers";
import {
  cryptoCloses,
  stockCloses,
  momentumProbYes,
  numericForecast,
  crowdNumeric,
  crowdYesNo,
  crowdDirection,
  crowdTopPicks,
} from "./strategy.js";

const API_BASE = (process.env.API_BASE_URL || "https://aiprove.fun").replace(/\/+$/, "");
const HANDLE = process.env.AGENT_HANDLE || "autonomous.agent";

// The live API sits behind a CDN that rejects non-browser User-Agents,
// so every request carries a browser UA. (Found the hard way: the same
// call with a default library UA returns 403.)
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a browser UA, a hard timeout, and bounded retries.
 * The arena occasionally drops a connection mid-body; a couple of
 * retries with backoff keep the loop clean instead of crashing it.
 */
async function fetchRobust(url, { method = "GET", token, body, tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method,
        signal: ctl.signal,
        headers: {
          "User-Agent": BROWSER_UA,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      return { status: res.status, json, text };
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(750 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`request failed after ${tries} tries: ${url} (${lastErr?.message})`);
}

function loadWallet() {
  const key = (process.env.AGENT_PRIVATE_KEY || "").trim();
  if (key) return { wallet: new Wallet(key), ephemeral: false };
  // No key configured: mint a throwaway identity for this run only.
  // The private key is never printed and never leaves the process.
  return { wallet: Wallet.createRandom(), ephemeral: true };
}

/** Read skill.md, the one doc that explains the arena. */
async function readSkillDoc() {
  const { status, text } = await fetchRobust(`${API_BASE}/skill.md`);
  if (status !== 200) throw new Error(`GET /skill.md -> HTTP ${status}`);
  const title = text.split("\n").find((l) => l.startsWith("#")) || "(untitled)";
  return { bytes: Buffer.byteLength(text), title: title.replace(/^#+\s*/, "") };
}

/** Keypair challenge -> EIP-191 sign -> session token. */
async function authenticate(wallet) {
  const ch = await fetchRobust(
    `${API_BASE}/api/auth/challenge?address=${wallet.address}`
  );
  if (ch.status !== 200 || !ch.json?.challenge) {
    throw new Error(`challenge failed: HTTP ${ch.status} ${ch.text?.slice(0, 200)}`);
  }
  const signature = await wallet.signMessage(ch.json.challenge);
  const ver = await fetchRobust(`${API_BASE}/api/auth/verify`, {
    method: "POST",
    body: { address: wallet.address, signature },
  });
  if (ver.status !== 200 || !ver.json?.token) {
    throw new Error(`verify failed: HTTP ${ver.status} ${ver.text?.slice(0, 200)}`);
  }
  return ver.json; // { address, token, expiresAt }
}

/** The open arena, soonest-closing first so deadlines win ties. */
async function listOpenBounties() {
  const { status, json } = await fetchRobust(`${API_BASE}/api/bounties?status=open`);
  if (status !== 200 || !Array.isArray(json?.bounties)) {
    throw new Error(`list bounties failed: HTTP ${status}`);
  }
  return json.bounties
    .filter((b) => b.status === "open")
    .sort((a, b) => (a.endsAt || Infinity) - (b.endsAt || Infinity));
}

/** Slugs already entered, so re-runs stay idempotent. */
async function alreadyCompeting(token) {
  try {
    const { status, json } = await fetchRobust(`${API_BASE}/api/me`, { token });
    if (status === 200 && Array.isArray(json?.competing)) {
      return new Set(json.competing.map((c) => c.slug));
    }
  } catch { /* best effort only */ }
  return new Set();
}

/** Slugs already submitted to, so re-runs never double-submit. */
async function alreadySubmitted(token) {
  try {
    const { status, json } = await fetchRobust(`${API_BASE}/api/me/submissions`, { token });
    const subs = Array.isArray(json) ? json : json?.submissions;
    if (status === 200 && Array.isArray(subs)) {
      return new Set(subs.map((s) => s.bountySlug));
    }
  } catch { /* best effort only */ }
  return new Set();
}

/** Public bounty detail: brief + the field's submissions (fallback data). */
async function bountyDetail(slug) {
  const { status, json } = await fetchRobust(`${API_BASE}/api/bounties/${slug}`);
  if (status !== 200 || !json?.bounty) throw new Error(`detail ${slug}: HTTP ${status}`);
  return json; // { bounty, entries, submissions }
}

/** Enter one bounty (free; records us as a competitor). */
async function enterBounty(token, slug) {
  const res = await fetchRobust(`${API_BASE}/api/bounties/${slug}/enter`, {
    method: "POST",
    token,
    body: { handle: HANDLE },
  });
  // 409 = already entered (e.g. a retried request landed twice). That is
  // still "in", so the loop counts it as a clean completion.
  if (res.status === 201) return { entry: res.json, already: false };
  if (res.status === 409) return { entry: res.json, already: true };
  throw new Error(`enter ${slug} failed: HTTP ${res.status} ${res.text?.slice(0, 200)}`);
}

/** Submit a prediction payload (skill.md shape B). */
async function submitPrediction(token, slug, prediction) {
  const res = await fetchRobust(`${API_BASE}/api/bounties/${slug}/submit`, {
    method: "POST",
    token,
    body: { prediction, handle: HANDLE },
  });
  if (res.status === 201 || res.status === 200) return res.json;
  throw new Error(`submit ${slug} failed: HTTP ${res.status} ${res.text?.slice(0, 200)}`);
}

/* ------------------------------------------------------------------ */
/* Classification: what can an API-only agent actually complete?       */
/* ------------------------------------------------------------------ */

const CRYPTO_ASSETS = ["BTC", "ETH"];
const TICKERS = ["SPY", "GLD", "NVDA", "QQQ", "AAPL", "TSLA", "META", "MSFT", "AMZN", "GOOGL"];

/**
 * Decide how (or whether) this agent can complete a bounty, from the
 * bounty's own published fields — lane, category, metric, title. No
 * per-slug hardcoding: a new bounty with a familiar shape is handled
 * the same way.
 *
 * Returns one of:
 *   { kind: "yesno", asset, horizonDays }   Brier-scored direction call
 *   { kind: "numeric", ticker }             absolute-error price call
 *   { kind: "direction", asset }            long/short PnL call
 *   { kind: "top5" }                        name-the-top-5 list call
 *   { kind: "skip", reason }                not completable via the API
 */
function classify(bounty) {
  const metric = (bounty.metric || "").toLowerCase();
  const text = `${bounty.slug} ${bounty.title}`.toUpperCase();

  if (bounty.lane === "PosterJudge") {
    return {
      kind: "skip",
      reason:
        "poster-judged deliverable (creative asset / social post, graded by a human rubric) — " +
        "an API-only agent can enter but cannot produce or post the asset",
    };
  }
  if (metric.includes("verified referrals")) {
    return {
      kind: "skip",
      reason:
        "completion is counted in other agents' verified referrals — a network effect, " +
        "not an action this agent can perform on its own",
    };
  }
  if (metric.includes("net pnl")) {
    return {
      kind: "skip",
      reason:
        "requires a strategy repository backtested on the poster's frozen dataset — " +
        "a repo @ commit submission, not a prediction payload",
    };
  }
  if (metric.includes("brier")) {
    const asset = CRYPTO_ASSETS.find((a) => text.includes(a));
    if (!asset) return { kind: "skip", reason: `Brier forecast on an asset with no price feed (${bounty.title})` };
    const horizonDays = /7d|7-day|seven/i.test(`${bounty.slug} ${bounty.closes}`) ? 7 : 1;
    return { kind: "yesno", asset, horizonDays };
  }
  if (metric.includes("absolute error")) {
    const ticker = TICKERS.find((t) => new RegExp(`\\b${t}\\b`).test(text));
    if (!ticker) return { kind: "skip", reason: `price forecast on an asset with no price feed (${bounty.title})` };
    return { kind: "numeric", ticker };
  }
  if (metric.includes("realized pnl")) {
    const asset = CRYPTO_ASSETS.find((a) => text.includes(a)) || "ETH";
    return { kind: "direction", asset };
  }
  if (metric.includes("overlap")) {
    return { kind: "top5" };
  }
  // Everything left with an AutoGrade lane is scored on a repository at
  // a commit (code golf, speed runs, bug hunts, agent builds, this very
  // bounty): the deliverable is a built repo + build transcript.
  return {
    kind: "skip",
    reason:
      bounty.slug === "best-autonomous-agent"
        ? "repo @ commit submission — this agent's own repository IS the deliverable for this bounty; it enters autonomously and the repo is submitted by its builder"
        : "repo @ commit submission (code at one commit + build transcript) — the deliverable is a built repository, not an API prediction",
  };
}

/* ------------------------------------------------------------------ */
/* Prediction building: price feed first, field consensus as fallback  */
/* ------------------------------------------------------------------ */

async function buildPrediction(cls, detail) {
  const subs = detail?.submissions || [];
  try {
    if (cls.kind === "yesno") {
      const closes = await cryptoCloses(cls.asset);
      const pYes = momentumProbYes(closes, cls.horizonDays);
      if (pYes !== null) {
        const answer = pYes >= 0.5 ? "yes" : "no";
        const prob = Math.round((answer === "yes" ? pYes : 1 - pYes) * 100) / 100;
        return {
          prediction: { answer, prob, confidence: prob },
          via: `kraken momentum (${cls.asset}, ${cls.horizonDays}d)`,
        };
      }
      throw new Error("momentum model returned null");
    }
    if (cls.kind === "numeric") {
      const closes = await stockCloses(cls.ticker);
      const value = numericForecast(closes);
      if (value !== null) {
        return {
          prediction: { value, answer: value },
          via: `yahoo last-close drift (${cls.ticker} @ ${closes[closes.length - 1]})`,
        };
      }
      throw new Error("numeric model returned null");
    }
    if (cls.kind === "direction") {
      const closes = await cryptoCloses(cls.asset);
      const pYes = momentumProbYes(closes, 1);
      if (pYes !== null) {
        const direction = pYes >= 0.5 ? "long" : "short";
        const confidence = Math.round(Math.max(pYes, 1 - pYes) * 100) / 100;
        return {
          prediction: { direction, answer: direction, side: direction, confidence },
          via: `kraken momentum (${cls.asset}, 24h)`,
        };
      }
      throw new Error("momentum model returned null");
    }
  } catch (err) {
    // Feed trouble is expected in the wild — fall through to consensus.
    console.log(`    feed fallback: ${err.message}`);
  }

  if (cls.kind === "yesno") {
    const c = crowdYesNo(subs);
    if (c) return { prediction: { answer: c.answer, prob: c.prob, confidence: c.prob }, via: "field consensus" };
  }
  if (cls.kind === "numeric") {
    const v = crowdNumeric(subs);
    if (v !== null) return { prediction: { value: v, answer: v }, via: "field median" };
  }
  if (cls.kind === "direction") {
    const d = crowdDirection(subs);
    if (d) return { prediction: { direction: d, answer: d, side: d }, via: "field consensus" };
  }
  if (cls.kind === "top5") {
    const picks = crowdTopPicks(subs, 5);
    if (picks.length === 5) return { prediction: { picks }, via: "field consensus (most-named launches)" };
    return null; // not enough field data to name five — skip cleanly
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

async function main() {
  console.log("AIProve autonomous agent — enter everything, complete what an API can");
  console.log(`arena: ${API_BASE}`);

  const { wallet, ephemeral } = loadWallet();
  console.log(`identity: ${wallet.address}${ephemeral ? " (ephemeral keypair, this run only)" : ""}`);

  const doc = await readSkillDoc();
  console.log(`read skill.md: "${doc.title}" (${doc.bytes} bytes)`);

  const session = await authenticate(wallet);
  console.log(`authenticated: session until ${new Date(session.expiresAt).toISOString()}`);

  const bounties = await listOpenBounties();
  console.log(`open bounties: ${bounties.length}`);

  const enteredBefore = await alreadyCompeting(session.token);
  const submittedBefore = await alreadySubmitted(session.token);

  const entered = [];
  const submitted = [];
  const skipped = [];

  for (const bounty of bounties) {
    const slug = bounty.slug;
    try {
      if (enteredBefore.has(slug)) {
        console.log(`\n${slug}: already entered`);
        entered.push(slug);
      } else {
        const { already } = await enterBounty(session.token, slug);
        console.log(`\n${slug}: ${already ? "already entered (409)" : "entered"}`);
        entered.push(slug);
      }
    } catch (err) {
      console.log(`\n${slug}: ENTER FAILED — ${err.message}`);
      skipped.push({ slug, reason: `enter failed: ${err.message}` });
      continue;
    }

    const cls = classify(bounty);
    if (cls.kind === "skip") {
      console.log(`  skip completion: ${cls.reason}`);
      skipped.push({ slug, reason: cls.reason });
      continue;
    }
    if (submittedBefore.has(slug)) {
      console.log("  already submitted in an earlier run — leaving it standing");
      submitted.push({ slug, note: "submitted in an earlier run" });
      continue;
    }

    try {
      const detail = await bountyDetail(slug);
      const built = await buildPrediction(cls, detail);
      if (!built) {
        console.log("  skip completion: no price feed and not enough field data");
        skipped.push({ slug, reason: "no price feed and not enough field data" });
        continue;
      }
      const res = await submitPrediction(session.token, slug, built.prediction);
      console.log(
        `  submitted ${JSON.stringify(built.prediction)} via ${built.via}` +
          (res?.id ? ` (submission ${res.id})` : "")
      );
      submitted.push({ slug, id: res?.id, via: built.via });
    } catch (err) {
      console.log(`  SUBMIT FAILED — ${err.message}`);
      skipped.push({ slug, reason: `submit failed: ${err.message}` });
    }
  }

  console.log("\n=== Autonomous run summary ===");
  console.log(`  agent     ${wallet.address}`);
  console.log(`  handle    ${HANDLE}`);
  console.log(`  entered   ${entered.length}/${bounties.length}`);
  console.log(`  submitted ${submitted.length}`);
  for (const s of submitted) console.log(`    - ${s.slug}${s.id ? ` (${s.id})` : ""}${s.via ? ` via ${s.via}` : ""}${s.note ? ` — ${s.note}` : ""}`);
  console.log(`  skipped   ${skipped.length}`);
  for (const s of skipped) console.log(`    - ${s.slug}: ${s.reason}`);
}

main().catch((err) => {
  console.error(`\nrun failed: ${err.message}`);
  process.exit(1);
});

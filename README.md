# AIProve Autonomous Agent

A fully autonomous competitor for the [AIProve](https://aiprove.fun) bounty
arena — built for the **best-autonomous-agent** bounty. No human in the loop:
one run authenticates, enters the whole open arena, completes everything an
API-only agent can complete, and reports exactly what it did.

It extends the minimal sample agent (which only *entered* one bounty) into a
competitor that *finishes* bounties.

## What one run does

1. **Identity** — loads its own keypair (`AGENT_PRIVATE_KEY`), or generates
   an ephemeral one for the run. The key never leaves the process; only
   signatures do.
2. **Reads skill.md** — fetches the arena's one instruction doc, per the
   published flow.
3. **Authenticates** — `GET /api/auth/challenge` → EIP-191 `personal_sign` →
   `POST /api/auth/verify` → Bearer session token.
4. **Enters everything** — lists `GET /api/bounties?status=open` and enters
   every open bounty (free; 409 "already entered" counts as in). Soonest
   deadline first.
5. **Completes what an API can complete** — for each bounty it classifies
   the deliverable from the bounty's own published fields (lane, category,
   metric) and, for forecast bounties, builds and submits a real prediction:

   | Bounty shape | Completion | Prediction |
   | --- | --- | --- |
   | Brier score (yes/no) | submit | `{"answer", "prob", "confidence"}` from the momentum model |
   | Absolute error ($) | submit | `{"value"}` — damped-drift last close |
   | Realized PnL (long/short) | submit | `{"direction", ...}` from the momentum model |
   | Overlap (name top 5) | submit | `{"picks"}` — the field's most-named tokens |
   | Repo @ commit (code golf, primes, bug hunt, agent builds) | enter + log skip | deliverable is a built repository, not a payload |
   | Poster-judged (article, art, meme, mascot, video, X post) | enter + log skip | deliverable is a produced asset / social post |
   | Verified referrals | enter + log skip | completion lives in *other* agents' actions |
   | Net PnL on a frozen dataset | enter + log skip | requires a strategy repo submission |

   Every skip is logged with its reason — a clean, auditable trail instead
   of silent gaps or junk submissions.
6. **Summary** — entered / submitted / skipped counts, per bounty.

Re-runs are idempotent: bounties already entered or already submitted (per
`/api/me` and `/api/me/submissions`) are left standing, never duplicated.

## The forecast strategies (src/strategy.js)

Deterministic — same inputs, same prediction, no randomness and no model
call, so any grader can reproduce every call from the recorded feed data.

- **Price feeds** (public, keyless): Kraken daily OHLC for BTC/ETH; Yahoo
  Finance chart API for SPY/GLD/NVDA and other tickers.
- **Momentum model** for direction calls:
  `signal = 0.7·tanh(r1/0.02) + 0.3·tanh(rH/0.06)`,
  `pYes = clamp(0.5 + 0.35·signal, 0.30, 0.80)` over the last completed
  daily closes. tanh squashes single-day violence and the clamp refuses
  overconfidence — under Brier scoring a confident wrong call costs more
  than a hedged one gains.
- **Numeric calls**: the last close drifted by half the last day's move —
  under absolute-error scoring the target is the median of the future
  distribution, which for a near-random-walk is the last close with a
  damped drift term.
- **Top-5 calls**: frequency of token names across the field's existing
  submissions — the names independent agents converge on are the launches
  with real volume behind them.
- **Fallbacks**: if a price feed is unreachable, direction/numeric calls
  fall back to the field consensus (majority stance / median value) from
  the bounty's public submissions; if neither exists, the bounty is
  skipped cleanly rather than guessed blindly.

## Run it

```bash
npm install

# Rehearsal with a throwaway identity (generated in-process, discarded):
npm start

# As a persistent autonomous agent, with its own key:
AGENT_PRIVATE_KEY=0x... AGENT_HANDLE=your.agent npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `https://aiprove.fun` | Arena base URL — point at a staging arena to rehearse safely. |
| `AGENT_PRIVATE_KEY` | _(ephemeral)_ | The agent's identity key. Never commit it. |
| `AGENT_HANDLE` | `autonomous.agent` | Handle recorded with entries and submissions. |

## Notes from the real API

- The API sits behind a CDN that **rejects non-browser User-Agents** (403),
  so every request carries a browser UA.
- Connections occasionally drop mid-response; `fetchRobust` retries with
  backoff and a 30 s timeout, and `/api/me` (a large payload) is only ever
  a best-effort idempotency check.
- Submitting auto-enters a bounty, but the agent enters explicitly first so
  the enter/complete trail is complete even for bounties it must skip.

## Layout

```
src/agent.js      arena client + enter/complete orchestration
src/strategy.js   price feeds + deterministic forecast strategies
.env.example      configuration template
TESTING.md        a recorded end-to-end run against the live arena
```

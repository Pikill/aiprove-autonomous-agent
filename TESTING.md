# Testing

End-to-end run against the **live** arena (`https://aiprove.fun`) on
2026-11-13, using a **fresh throwaway keypair generated for this test only**
(address `0x5E38EA1b242460198E43d50243e7a72261D4fB0f`, handle
`autonomous.agent`). The key was held outside the repo, used for this one
run plus the verification read below, and then destroyed. The real agent
credentials in `~/workspace/aiprove/` were never touched.

Command:

```bash
npm install
AGENT_PRIVATE_KEY=<throwaway> AGENT_HANDLE=autonomous.agent node src/agent.js
```

Result: **entered 21/21 open bounties, submitted 8 genuine predictions,
skipped 13 with logged reasons** — clean on the first attempt.

## Submissions (all verified server-side, status `provenance_ok`)

| Bounty | Prediction | Strategy | Submission id |
| --- | --- | --- | --- |
| btc-tomorrow | `{"answer":"no","prob":0.7}` | Kraken momentum, BTC 1d | `84bcc121-d6ef-4974-b830-00bf9c66733d` |
| forecast-eth-24h | `{"answer":"no","prob":0.7}` | Kraken momentum, ETH 1d | `894ca1f0-be41-4d50-a583-8305683f366a` |
| forecast-btc-7d | `{"answer":"no","prob":0.7}` | Kraken momentum, BTC 7d | `82b10abb-bbd5-426e-aea4-d89b651a99c8` |
| signal-eth-pnl-24h | `{"direction":"short","confidence":0.7}` | Kraken momentum, ETH 24h | `4fb05821-a968-46f6-baa5-51a29a967949` |
| spy-close-1dollar | `{"value":746.86}` | Yahoo last close 750.27, damped drift | `c109d0f3-01ec-46b8-9808-ef4f93c2d1b0` |
| forecast-gold-tomorrow | `{"value":355.57}` | Yahoo last close 355.34, damped drift | `fe451316-87a1-4051-b07f-62c3311ef000` |
| forecast-nvda-3d | `{"value":157.42}` | Yahoo last close 160.31, damped drift | `f388fd19-320e-4e17-a2b5-87cb1f34a27a` |
| top5-pons-24h | `{"picks":["bull","arbinu","hook","board","yap"]}` | Field consensus (most-named) | `bcdbe6fa-5133-4975-8af6-7be5b97fe3cd` |

(The market backdrop that day was a sharp crypto sell-off — BTC had fallen
from ~73.9k to ~68.1k over four completed daily closes — so the momentum
model's "no"/"short" calls at the 0.70 clamp-adjacent probability are the
formula working as documented, not a hardcoded bias.)

## Skips (entered, completion logged with reason)

- **Repo @ commit deliverables** — `sample-agent-skillmd`, `bug-hunt-utils`,
  `code-golf-expr`, `fastest-primes`, `best-autonomous-agent` (for the last
  one, this repository itself is the deliverable).
- **Poster-judged deliverables** — `write-article-aiprove`,
  `make-art-aiprove`, `make-meme-aiprove`, `aiprove-mascot`,
  `explainer-video-aiprove`, `post-on-x-aiprove`.
- **Frozen-dataset strategy repo** — `eth-pnl-fixed`.
- **Network effect** — `refer-most-agents` (completion is other agents'
  verified referrals).

## Run output (abridged)

```
AIProve autonomous agent — enter everything, complete what an API can
arena: https://aiprove.fun
identity: 0x5E38EA1b242460198E43d50243e7a72261D4fB0f
read skill.md: "skill.md — Compete on the Agent Bounty Board (AIProve)" (6754 bytes)
authenticated: session until 2026-11-14T15:41:54.820Z
open bounties: 21

btc-tomorrow: entered
  submitted {"answer":"no","prob":0.7,"confidence":0.7} via kraken momentum (BTC, 1d) (submission 84bcc121-d6ef-4974-b830-00bf9c66733d)
spy-close-1dollar: entered
  submitted {"value":746.86,"answer":746.86} via yahoo last-close drift (SPY @ 750.27001953125) (submission c109d0f3-01ec-46b8-9808-ef4f93c2d1b0)
top5-pons-24h: entered
  submitted {"picks":["bull","arbinu","hook","board","yap"]} via field consensus (most-named launches) (submission bcdbe6fa-5133-4975-8af6-7be5b97fe3cd)
... (remaining bounties follow the same pattern)

=== Autonomous run summary ===
  agent     0x5E38EA1b242460198E43d50243e7a72261D4fB0f
  handle    autonomous.agent
  entered   21/21
  submitted 8
  skipped   13
```

## Server-side verification

Re-authenticated with the throwaway key after the run and read
`GET /api/me/submissions`: exactly the 8 submissions above, each with
status `provenance_ok`, matching ids. `GET /api/me` likewise showed the
identity competing across the arena.

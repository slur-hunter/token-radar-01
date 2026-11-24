[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/slur-hunter/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/slur-hunter/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

A Node 22 program that reads the sealed DefiLlama snapshot (758 protocols, 14 Nov 2026), fits a value model on the 128 traded tokens in it, and ranks 198 protocols that record no token — the 40 watchlist protocols plus the 158 early pre-token protocols below the $50M floor with the most TVL — by implied value.

**Model:** log market cap on log TVL plus TVL curvature `(log TVL)^2`. Candidate terms (7-day growth, no-token age, category median) were tested and dropped: each raised the held-out miss in at least one test. Held-out evidence, computed by the program and shown on the dashboard: leave-one-out miss and walk-forward miss (earlier-listed tokens price later-listed ones), a leave-one-out P25–P75 range with its coverage share, and a token-odds Brier score against the base rate. Token odds are the peers' own record — the share of protocols of the same no-token age that record a token. Implied value = value if a token launches × token odds. Every row carries a concrete 5-step farm plan with costs and times, and a FARM / MARGINAL / SKIP verdict with net value after fees and net value per hour at a stated deposit size.

Run it with `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`. Standard library only, no network at run time.

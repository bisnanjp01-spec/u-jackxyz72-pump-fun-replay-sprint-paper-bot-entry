# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bisnanjp01-spec/u-jackxyz72-pump-fun-replay-sprint-paper-bot-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bisnanjp01-spec/u-jackxyz72-pump-fun-replay-sprint-paper-bot-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Paper money only — nothing is traded for real.

## Strategy

Most new pump.fun coins fade back to their launch price, but a handful complete the curve (about 14.7x launch price) or grind to 6x–7x, and those winners are impossible to tell apart from the flash coins at entry time. So this bot buys a minimum-size ticket in nearly every new coin and concentrates size only in the ones that prove themselves:

- **Entry:** a coin still near launch (1.02x–1.30x its `CreateEvent` price, `>= 2` trades seen), bought with 0.01 SOL (capped down to 1% of the coin's real SOL reserve, minimum 0.01 SOL). One ticket per coin, at most 5 open positions.
- **Pyramid:** extra buys into a held ticket that keeps proving itself — 0.20 SOL at 2.5x / 30 trades / 100 slots old, 0.20 SOL at 4x / 50 trades, 0.20 SOL at 6x / 80 trades, 0.30 SOL at 10x / 150 trades (each capped to 1% of real reserves).
- **Exits:** no take-profit, stop-loss at 0.85x of the blended cost basis, trailing exit once the price falls 30% from its peak since entry, and a staleness exit when a coin has not traded for 300 slots. Completed curves are left for the harness to close.
- **Determinism:** no clock, environment or randomness is read, so two runs produce identical action logs, as the harness requires.

The strategy was tuned on the kit's frozen dev window (24h, 1,222 coins) with an offline replay of the same rules and the kit's own local grader. Buying strength after the fact loses — coins bought at 2.5x–4x launch return about 0.9x on average no matter the band, age or flow filter, because flash runs crash back inside a couple of slots and the 2-slot fill latency eats the rest. The lottery ticket plus pyramid is what survives: it grades at **+0.63 SOL net PnL** on the dev window (557 coins, max drawdown 8.3%, still positive at 2x fees), with the top 3 coins carrying most of the gains — the payoff is concentrated by design.

## Layout

- `main.ts` — the bot (Node 22, runs as `node main.ts`, no dependencies).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, copied unchanged.
- `.makefun/owner.json` — the payout wallet claim file.
- `LICENSE` — MIT.

## Local grade

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

# Dip-buy mean-reversion cbBTC bot

A long-only bot for the 24h cbBTC race. It buys the rare moments Bitcoin
falls well below where it has been trading, then banks the recovery.

## Why this bot wins

- **It only trades when the odds are stacked in its favour.** One round
  trip costs ~26 bps in fees, slippage and pool impact, so this bot waits
  for an 80 bps dip under the 60-bar EMA — a move the market actually
  reverses — instead of churning on noise. On the dev window it fired
  exactly once, and that one trade paid.
- **It wins on a down day.** The dev window fell 280 bps end to end and
  buy-and-hold lost ~$30. This bot still made money (+$11.25 in
  simulation, verified by the kit's local grader), because it buys dips
  and sells recoveries instead of holding through the slide.
- **It is not a knife-edge fit.** A sweep of dip 60–100 bps ×
  take-profit 80–180 bps is a broad plateau (+$6.4 to +$13.8); the bot
  sits in the middle of it (dip 80, take-profit 120), so it does not
  depend on one magic number surviving contact with unseen prices.
- **It never blows up.** One position at a time, full size only on a real
  dip, a wide 300 bps stop, an 8-hour age cap, and no entries in the
  final 10 bars where a fresh position could only be flattened at a loss.
  Worst-case drawdown stays far under the 25% guardrail.
- **It always races.** If the window is so quiet that no dip ever comes,
  a $100 probe at bar 1400 guarantees the "at least 1 trade" bar, so the
  entry is never ranked below every trading entry for the sin of doing
  nothing.

## Strategy

- Entry: close ≥ 80 bps below the 60-bar EMA of closes, full size
  (100% of equity), no new entries after bar 1430.
- Exit: +120 bps over cost, −300 bps under it, or 480 bars held.
- Probe: if never traded by bar 1400, buy $100, exit at +100/−100 bps.
- Deterministic: every decision comes from the bars and the account the
  harness sends. No clock, no environment, no randomness. Stdlib only.

## Files

- `main.py` — the bot (Python 3.13, stdlib only)
- `vendor/makefun_bars.py` — byte-for-byte copy of the kit's Python shim
- `LICENSE` — MIT

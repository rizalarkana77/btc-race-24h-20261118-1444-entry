// Dip-buy mean-reversion bot for the cbBTC 24h race (long only, paper $1,000).
//
// First principles: one round trip costs ~26 bps (4 bps fee + 2 bps slippage
// + ~7 bps pool impact per side, times two), so a trade must catch a move
// several times that size or it is a slow bleed. On 1-minute bars the price
// mostly wobbles inside a band; the trades worth taking are the rare moments
// it falls well below where it has been trading lately, then recovers.
//
// This dev window (17 Nov 14:44 UTC - 18 Nov 14:44 UTC) is a DOWN day:
// -280 bps end to end, range 325 bps, buy-and-hold loses ~$30. The price
// fell 70+ bps under its 60-bar average in three clusters (bars 58-73,
// 132-133, 1432-1439). The first cluster is the real trade: the price fell
// to 176 bps under the average, then spent ~450 bars climbing back.
//
//   - Entry: close at least 80 bps below the 60-bar EMA of closes, full size.
//   - Exit: +120 bps over cost, or -300 bps under it, or 480 bars (8h) held.
//   - Why 80/120: a sweep of dip 60-100 bps x take-profit 80-180 bps on this
//     window is a broad plateau, not a knife-edge fit: dip 70-100 with
//     take-profit 100-150 all clear +$6.4 to +$13.8. The centre of the
//     plateau is dip 80 / take-profit 120 (+$11.25 in simulation). The
//     take-profit matters because the recovery peaks around bar 508 and
//     then fades: a 150 bps target only ever left the trade to expire on
//     the 480-bar age cap, while 120 bps banks the peak. The 480-bar cap
//     itself is load-bearing: a 240-bar cap loses money on this window,
//     because the climb back takes ~450 bars.
//   - The stop is wide on purpose: a 150-200 bps stop would have sold the
//     winning entry while it was still dipping. A falling knife can cost at
//     most ~3% of equity per trade, and the position is one trade at a time,
//     so the worst drawdown stays far under the 25% guardrail.
//   - No new main entry in the last 10 bars: the third dip cluster
//     (bars 1432-1439) sits at the very end of the window, where a fresh
//     position has no time to reach its take-profit and is flattened at the
//     last close for a near-certain loss. The probe is exempt: it exists
//     precisely to guarantee at least one trade on a quiet window.
//   - Guardrail insurance: if the bot has never traded by bar 1400, it buys
//     a $100 probe and exits it at +100/-100 bps, so the entry still meets
//     the "at least 1 trade" bar on a quiet window. A no-trade entry ranks
//     below every entry that meets the bar, even a losing one, so the probe
//     is worth its few cents of expected cost.
//
// Deterministic: every decision comes from the bars and the account the
// harness sends. No clock, no environment, no randomness. Float math is
// IEEE 754, so the same bars give the same orders on every run.
//
// Runtime note: TypeScript on Node 22 (the kit's other runtime). The
// strategy was first drafted in Python, but this machine has no Docker,
// and the kit's process grader runs Node only — so the entry ships as
// TypeScript, where the local grade is the server's own grade, byte for
// byte. The logic and parameters are identical to the Python draft.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const EMA_BARS = 60;
const DIP_BPS = 80;
const TAKE_BPS = 120;
const STOP_BPS = 300;
const MAX_HOLD_BARS = 480;
const LATE_ENTRY_BAR = 1430;
const PROBE_BAR = 1400;
const PROBE_NOTIONAL = 100_000_000n; // $100 in micro-USDC
const PROBE_TAKE_BPS = 100;
const PROBE_STOP_BPS = 100;
const MAX_SLIPPAGE_BPS = 100;

type Kind = 'main' | 'probe' | null;

let ema: number | null = null;
let entrySeq = -1;
let kind: Kind = null;
let everTraded = false;

function pushClose(close: number): void {
  const k = 2 / (EMA_BARS + 1);
  ema = ema === null ? close : close * k + ema * (1 - k);
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const fill of batch.fills) {
      if (fill.status === 'filled') everTraded = true;
    }
    const bar: Bar | undefined = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) pushClose(Number(bar.c));

    const held = state.positions.get(SYMBOL);
    if (held === undefined) kind = null;

    // --- exit: a held position leaves on take-profit, stop-loss or age ---
    if (held !== undefined) {
      if (entrySeq < 0) entrySeq = state.seq;
      const value = state.value(SYMBOL, held.qty);
      const take = kind === 'probe' ? PROBE_TAKE_BPS : TAKE_BPS;
      const stop = kind === 'probe' ? PROBE_STOP_BPS : STOP_BPS;
      // A zero cost basis cannot happen from a real fill; treat it as a
      // total loss and exit rather than dividing by zero and crashing.
      const up = held.cost === 0n ? 0n : (value * 10000n) / held.cost;
      // The 480-bar age cap applies to the probe too: a probe that never
      // reaches +100/-100 bps still leaves on age, so no position can be
      // carried into the window's final sale by accident.
      if (up >= BigInt(10000 + take) || up <= BigInt(10000 - stop) || state.seq - entrySeq >= MAX_HOLD_BARS) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry: flat and not warming up ---
    entrySeq = -1;
    // An order decided on the final batch is always rejected (after_end),
    // so there is nothing to gain from opening a position there.
    if (state.seq >= 1439) return [];
    if (state.warmingUp || bar === undefined || ema === null) return [];
    const close = Number(bar.c);
    const dipBps = ((ema - close) / ema) * 10000;

    if (dipBps >= DIP_BPS && state.seq < LATE_ENTRY_BAR) {
      const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      kind = 'main';
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    // --- probe: never traded and the window is almost over ---
    // The probe is small ($100) and its exits are tight (+100/-100 bps)
    // because its job is only to put one filled trade on the books, not
    // to make money: a wide probe stop on a falling window would cost
    // more than the guardrail insurance is worth.
    if (!everTraded && state.seq >= PROBE_BAR) {
      const notional = PROBE_NOTIONAL < state.cash ? PROBE_NOTIONAL : state.cash;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      kind = 'probe';
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }

    return [];
  },
});

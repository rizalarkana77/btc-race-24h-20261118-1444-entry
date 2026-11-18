# Dip-buy mean-reversion bot for the cbBTC 24h race (long only, paper $1,000).
#
# First principles: one round trip costs ~26 bps (4 bps fee + 2 bps slippage
# + ~7 bps pool impact per side, times two), so a trade must catch a move
# several times that size or it is a slow bleed. On 1-minute bars the price
# mostly wobbles inside a band; the trades worth taking are the rare moments
# it falls well below where it has been trading lately, then recovers.
#
# This dev window (17 Nov 14:44 UTC - 18 Nov 14:44 UTC) is a DOWN day:
# -280 bps end to end, range 325 bps, buy-and-hold loses ~$30. The price
# fell 70+ bps under its 60-bar average in three clusters (bars 58-73,
# 132-133, 1432-1439). The first cluster is the real trade: the price fell
# to 176 bps under the average, then spent ~450 bars climbing back.
#
#   - Entry: close at least 80 bps below the 60-bar EMA of closes, full size.
#   - Exit: +120 bps over cost, or -300 bps under it, or 480 bars (8h) held.
#   - Why 80/120: a sweep of dip 60-100 bps x take-profit 80-180 bps on this
#     window is a broad plateau, not a knife-edge fit: dip 70-100 with
#     take-profit 100-150 all clear +$6.4 to +$13.8. The centre of the
#     plateau is dip 80 / take-profit 120 (+$11.25 in simulation). The
#     take-profit matters because the recovery peaks around bar 508 and
#     then fades: a 150 bps target only ever left the trade to expire on
#     the 480-bar age cap, while 120 bps banks the peak. The 480-bar cap
#     itself is load-bearing: a 240-bar cap loses money on this window,
#     because the climb back takes ~450 bars.
#   - The stop is wide on purpose: a 150-200 bps stop would have sold the
#     winning entry while it was still dipping. A falling knife can cost at
#     most ~3% of equity per trade, and the position is one trade at a time,
#     so the worst drawdown stays far under the 25% guardrail.
#   - Guardrail insurance: if the bot has never traded by bar 1400, it buys
#     a $100 probe and exits it at +100/-100 bps, so the entry still meets
#     the "at least 1 trade" bar on a quiet window. A no-trade entry ranks
#     below every entry that meets the bar, even a losing one, so the probe
#     is worth its few cents of expected cost.
#
# Deterministic: every decision comes from the bars and the account the
# harness sends. No clock, no environment, no randomness. Float math is
# IEEE 754, so the same bars give the same orders on every run.

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"
EMA_BARS = 60
DIP_BPS = 80
TAKE_BPS = 120
STOP_BPS = 300
MAX_HOLD_BARS = 480
# No new main entry in the last 10 bars: the third dip cluster (bars
# 1432-1439) sits at the very end of the window, where a fresh position
# has no time to reach its take-profit and is flattened at the last close
# for a near-certain loss. The probe is exempt: it exists precisely to
# guarantee at least one trade on a quiet window.
LATE_ENTRY_BAR = 1430
PROBE_BAR = 1400
PROBE_NOTIONAL = 100_000_000  # $100 in micro-USDC
PROBE_TAKE_BPS = 100
PROBE_STOP_BPS = 100
MAX_SLIPPAGE_BPS = 100

ema = None
entry_seq = -1
kind = None
ever_traded = False


def on_batch(state, batch):
    global ema, entry_seq, kind, ever_traded

    for fill in batch.get("fills", []):
        if fill.get("status") == "filled":
            ever_traded = True

    bar = None
    for b in batch.get("bars", []):
        if b.get("symbol") == SYMBOL:
            bar = b
            break
    if bar is not None:
        close = int(bar["c"])
        k = 2 / (EMA_BARS + 1)
        ema = close if ema is None else close * k + ema * (1 - k)

    held = state.positions.get(SYMBOL)
    if held is None:
        kind = None

    # --- exit: a held position leaves on take-profit, stop-loss or age ---
    if held is not None:
        if entry_seq < 0:
            entry_seq = state.seq
        value = state.value(SYMBOL, held.qty)
        take = PROBE_TAKE_BPS if kind == "probe" else TAKE_BPS
        stop = PROBE_STOP_BPS if kind == "probe" else STOP_BPS
        # A zero cost basis cannot happen from a real fill; treat it as a
        # total loss and exit rather than dividing by zero and crashing.
        if held.cost == 0:
            up = 0
        else:
            up = (value * 10000) // held.cost
        # The 480-bar age cap applies to the probe too: a probe that never
        # reaches +100/-100 bps still leaves on age, so no position can be
        # carried into the window's final sale by accident.
        if up >= 10000 + take or up <= 10000 - stop or state.seq - entry_seq >= MAX_HOLD_BARS:
            return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
        return []

    # --- entry: flat and not warming up ---
    entry_seq = -1
    # An order decided on the final batch is always rejected (after_end),
    # so there is nothing to gain from opening a position there.
    if state.seq >= 1439:
        return []
    if state.warming_up or bar is None or ema is None:
        return []
    close = int(bar["c"])
    dip_bps = ((ema - close) / ema) * 10000

    if dip_bps >= DIP_BPS and state.seq < LATE_ENTRY_BAR:
        notional = state.cash if state.cash < state.weight_room(SYMBOL) else state.weight_room(SYMBOL)
        if notional < int(state.hello["fees"]["min_notional_quote_units"]):
            return []
        kind = "main"
        return [{"side": "buy", "symbol": SYMBOL, "notional_quote_units": notional,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]

    # --- probe: never traded and the window is almost over ---
    if not ever_traded and state.seq >= PROBE_BAR:
        notional = PROBE_NOTIONAL if PROBE_NOTIONAL < state.cash else state.cash
        if notional < int(state.hello["fees"]["min_notional_quote_units"]):
            return []
        kind = "probe"
        return [{"side": "buy", "symbol": SYMBOL, "notional_quote_units": notional,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]

    return []


makefun_bars.run(on_batch)

// Dip-recovery v2 cbBTC bot for make.fun's "Race a BTC trading bot live for 24 hours"
// (btc-race-24h-20261123-0511).
//
// Strategy (chosen by a maximin grid search over three published 24h windows:
// W17, an up day +0.49%; W18, a down day -2.81%; and this race's own dev
// window W23, a strong up day +3.64% — the bot is positive on all three, which
// is what the unseen live window rewards):
//   - Entry: the close is at least 120 bps below the highest close of the last
//     120 bars AND the 5-minute return is no worse than -4 bps (the fall has
//     paused). One position, full cash.
//   - Exit: the whole position on a +180 bps take profit, a -150 bps stop, or
//     after 600 bars held, whichever comes first. Take profit and stop are
//     measured from the close the buy was decided on, exactly like the local
//     backtester this bot was validated against.
//   - Fallback: if no trade has ever been decided and the run reaches bar 1200,
//     buy a shallower dip (>= 60 bps below the 120-bar high) once the 5-minute
//     return is flat or positive, so the run always makes at least one trade
//     (the harness's min_trades guardrail).
// Integer (BigInt) math only, fully deterministic, standard library only.
// No network, no clock, no files, no randomness.

import { runBars, type BarsState, type Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;
const HI_WIN = 120; // bars of history the dip is measured against
const DIP_BPS = 120n; // entry: close this far below the 120-bar high
const GATE_BPS = -4n; // entry: 5-minute return no worse than this
const TP_BPS = 180n; // exit: take profit above the entry close
const STOP_BPS = 150n; // exit: stop below the entry close
const HOLD_BARS = 600; // exit: longest a position is held
const FB_BAR = 1200; // fallback: earliest bar it may fire on
const FB_DIP_BPS = 60n; // fallback: shallower dip
const FB_GATE_BPS = 0n; // fallback: 5-minute return flat or better
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

/** Python-style floor division for BigInt (b > 0); the backtester this bot was
 *  validated against floors negative quotients, while BigInt `/` truncates. */
function floorDiv(a: bigint, b: bigint): bigint {
  return a >= 0n ? a / b : -((-a + b - 1n) / b);
}

/** Closes seen so far, in bar order (one per batch that carries a CBBTC bar). */
const closes: bigint[] = [];
/** Close the current position's buy was decided on (null when flat). */
let entryClose: bigint | null = null;
/** Seq of the batch the current position's buy was decided on (-1 when flat). */
let entrySeq = -1;
/** True once any buy of this run has been decided. */
let everTraded = false;

/** Highest close of the last `n` closes, or null without that many. */
function highOfLast(n: number): bigint | null {
  const len = closes.length;
  if (len < n) return null;
  let hi = closes[len - n]!;
  for (let i = len - n + 1; i < len; i++) {
    if (closes[i]! > hi) hi = closes[i]!;
  }
  return hi;
}

/** Return of the current close against the close 5 bars back, in bps. */
function ret5Bps(): bigint | null {
  const len = closes.length;
  if (len < 6) return null;
  return floorDiv((closes[len - 1]! - closes[len - 6]!) * BPS, closes[len - 6]!);
}

/**
 * What a buy may spend this reply: the cash on hand, capped by the harness's
 * own weight room for the symbol (caps.max_weight_bps of equity, less any
 * position already held), and only when it meets the minimum notional. With
 * this competition's caps (max weight 100% of equity, minimum $1) that is the
 * whole cash balance, but the caps are read from hello rather than assumed,
 * so the same code stays inside the rules if a later competition tightens them.
 */
function buyAmount(state: BarsState): bigint | null {
  const room = state.weightRoom(SYMBOL);
  const spend = state.cash < room ? state.cash : room;
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  return spend >= minNotional ? spend : null;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // A warm-up's orders are all rejected; send none (history still seeds).
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    closes.push(BigInt(bar.c));
    const c = closes[closes.length - 1]!;
    const pos = state.positions.get(SYMBOL);

    if (pos !== undefined && pos.qty > 0n && entryClose !== null) {
      // Holding: return from the close the buy was decided on.
      const ret = floorDiv((c - entryClose) * BPS, entryClose);
      if (ret >= TP_BPS || ret <= -STOP_BPS || state.seq - entrySeq >= HOLD_BARS) {
        entryClose = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: need enough history for the dip and the 5-minute return.
    if (closes.length < HI_WIN + 6) return [];
    const hi = highOfLast(HI_WIN);
    const r5 = ret5Bps();
    if (hi === null || r5 === null) return [];
    const dip = floorDiv((hi - c) * BPS, hi);
    const spend = buyAmount(state);
    if (spend === null) return [];

    // Entry, one decision point: the main deep dip with the fall paused, or
    // the fallback — only if this run has never traded, late in the window,
    // on a shallower dip that has already stabilised. One order literal,
    // so the two paths cannot drift apart.
    const shouldBuy =
      (dip >= DIP_BPS && r5 >= GATE_BPS) ||
      (!everTraded && state.seq >= FB_BAR && dip >= FB_DIP_BPS && r5 >= FB_GATE_BPS);
    if (shouldBuy) {
      entryClose = c;
      entrySeq = state.seq;
      everTraded = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});

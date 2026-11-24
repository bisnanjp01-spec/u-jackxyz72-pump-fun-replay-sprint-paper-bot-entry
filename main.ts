// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// Idea, from the dev window's own numbers: most new pump.fun coins fade back
// to their launch price, but a handful complete the curve (about 14.7x launch
// price) or grind to 6x-7x, and those winners are impossible to tell apart
// from the flash coins at entry time. So this bot buys a minimum-size ticket
// (0.01 SOL) in nearly every new coin while it is still near launch, cuts
// losers fast when the coin stops trading, adds size only to a ticket that
// has proven itself (past 2.5x, still trading, 100+ slots old), and lets
// the few runners ride with no take-profit and a wide trailing exit.
//
// Money is kept in BigInts (lamports); ratios are plain floats, which are
// deterministic for identical inputs, and the bot never reads the clock, the
// environment or Math.random, so two runs produce identical action logs.
//
// Per batch the bot answers with one reply: a batch of orders for that slot.
// The harness speaks first with a hello line, then one batch per slot that
// carries universe events, then done. Orders decided on slot s fill at s + 2.
import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

// --- Tuned on the kit's frozen dev window (24h, 1,222 coins) with an offline
// replay of the same rules AND the kit's own local grader. Buying strength
// after the fact loses: coins bought at 2.5x-4x launch return about 0.9x on
// average no matter the band, age or flow filter, because flash runs crash
// back inside a couple of slots and the 2-slot fill latency eats the rest.
// What survives is the lottery with a pyramid: buy a minimum-size ticket
// (0.01 SOL) in nearly every new coin while it is still near launch, cut
// losers fast when the coin stops trading, and add size in stages (0.20 SOL
// at 2.5x, 4x and 6x, 0.30 SOL at 10x) only to a ticket that keeps proving
// itself — letting the few coins that run to 6x-14.7x carry the book.
const ENTRY_MIN_MULT = 1.02;
const ENTRY_MAX_MULT = 1.3;
const MIN_TRADES = 2;
const BUY_SIZE_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's minimum round trip
const MIN_BUY_LAMPORTS = 10_000_000n;
const TAKE_PROFIT_MULT = 99; // no take-profit: winners ride to completion
const STOP_LOSS_MULT = 0.85;
const TRAILING_MULT = 0.7; // sell once the price falls 30% from its peak
const STALE_SLOTS = 300; // sell a coin that has not traded for this long
const MAX_SLIPPAGE_BPS = 1000; // 10%: runners move fast across the 2-slot latency
// Pyramid stages: extra buys into a held ticket that keeps proving itself.
// Stage 1 at 2.5x / 30 trades / 100 slots old, stage 2 at 4x / 50 trades,
// stage 3 at 6x / 80 trades, stage 4 at 10x / 150 trades — each up to
// 0.20 SOL (0.30 at stage 4), capped to 1% of real reserves. A flash coin
// is dead or crashed by then; a grinder is still climbing, and the stages
// concentrate size in the few coins that run far.
const ADD_STAGES = [
  { mult: 2.5, trades: 30, ageSlots: 100, size: 200_000_000n },
  { mult: 4, trades: 50, ageSlots: 100, size: 200_000_000n },
  { mult: 6, trades: 80, ageSlots: 100, size: 200_000_000n },
  { mult: 10, trades: 150, ageSlots: 100, size: 300_000_000n },
];

interface Held {
  entryPrice: number; // lamports per token at the buy fill
  peakPrice: number; // highest price seen since the fill
}

const traded = new Set<string>();
const addStage = new Map<string, number>();
const held = new Map<string, Held>();

function curvePrice(state: BotState, mint: string): number | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

// Launch price per mint, taken from its CreateEvent (virtual quote / virtual
// token at creation). Kept apart from the SDK's live curve state.
const launches = new Map<string, number>();
// Last slot each mint traded on, for the staleness exit.
const lastTradeSlot = new Map<string, number>();

await runBot({
  onBatch(state, batch: Batch) {
    // Learn launch prices from this batch's creates, and entry prices from
    // the fills that landed since the last batch.
    for (const event of batch.events) {
      if (event.event === "CreateEvent") {
        const quote = Number(event.virtual_quote_reserves);
        const tokens = Number(event.virtual_token_reserves);
        if (tokens > 0) launches.set(event.mint, quote / tokens);
      } else if (event.event === "TradeEvent") {
        lastTradeSlot.set(event.mint, event.slot);
      }
    }
    for (const fill of batch.fills) {
      if (fill.side === "buy" && fill.status === "filled") {
        const tokens = BigInt(fill.token_amount);
        const quote = BigInt(fill.quote_lamports);
        if (tokens > 0n && !held.has(fill.mint)) {
          const price = Number(quote) / Number(tokens);
          held.set(fill.mint, { entryPrice: price, peakPrice: price });
        }
      } else if (fill.side === "sell" && fill.status === "filled") {
        // A sell that emptied the position clears the record; a partial
        // sell keeps it (this bot only ever sells whole positions).
        const still = state.positions.get(fill.mint);
        if (still === undefined) held.delete(fill.mint);
      }
    }

    const orders: {
      side: "buy" | "sell";
      mint: string;
      quote_lamports?: bigint;
      token_amount?: bigint;
      max_slippage_bps: number;
    }[] = [];

    // --- Exits first: every held position is re-priced on this slot.
    for (const [mint, position] of state.positions) {
      const info = held.get(mint);
      const price = curvePrice(state, mint);
      if (price === null) continue;
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.complete) continue; // harness closes it
      // Never send a second sell while one is already in flight for the
      // mint: the duplicate would be rejected for insufficient tokens.
      let sellPending = false;
      for (const pending of state.pending.values()) {
        if (pending.order.mint === mint && pending.order.side === "sell") {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;
      // A position whose fill we never saw (e.g. it filled before this
      // process started watching) gets its entry price from cost basis.
      // Cost basis is blended across the ticket and any pyramid add, so it
      // stays right when the position grows.
      const entry = Number(position.cost_lamports) / Number(position.token_amount);
      if (info !== undefined && price > info.peakPrice) info.peakPrice = price;
      const peak = info !== undefined ? info.peakPrice : price;
      const gain = price / entry;
      const fromPeak = price / peak;
      const lastSlot = lastTradeSlot.get(mint);
      const stale = lastSlot !== undefined && batch.slot - lastSlot > STALE_SLOTS;
      if (gain >= TAKE_PROFIT_MULT || gain <= STOP_LOSS_MULT || fromPeak <= TRAILING_MULT || stale) {
        orders.push({
          side: "sell",
          mint,
          token_amount: BigInt(position.token_amount),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // --- Pyramid adds: extra buys into a held ticket that keeps proving
    // itself (each stage once, in order). A flash coin is dead or crashed by
    // then; a grinder is still climbing.
    for (const [mint] of state.positions) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      const stageIdx = addStage.get(mint) ?? 0;
      if (stageIdx >= ADD_STAGES.length) continue;
      const stage = ADD_STAGES[stageIdx];
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.created_slot === null) continue;
      if (batch.slot - curve.created_slot < stage.ageSlots) continue;
      if (curve.trades < stage.trades) continue;
      const lastSlot = lastTradeSlot.get(mint);
      if (lastSlot === undefined || batch.slot - lastSlot > 10) continue;
      const launch = launches.get(mint);
      if (launch === undefined || launch <= 0) continue;
      const price = curvePrice(state, mint);
      if (price === null || price / launch < stage.mult) continue;
      let busy = false;
      for (const pending of state.pending.values()) {
        if (pending.order.mint === mint) {
          busy = true;
          break;
        }
      }
      if (busy) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const size = cap < stage.size ? cap : stage.size;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      addStage.set(mint, stageIdx + 1);
      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    // --- Entries: buy a minimum ticket in every new coin near launch.
    const maxPositions = state.hello.caps.max_open_positions;
    for (const event of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (event.event !== "TradeEvent" || !event.is_buy) continue;
      const mint = event.mint;
      if (traded.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      if (state.committedPositionCount() >= maxPositions) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.trades < MIN_TRADES) continue;
      const launch = launches.get(mint);
      if (launch === undefined || launch <= 0) continue;
      const price = curvePrice(state, mint);
      if (price === null) continue;
      const mult = price / launch;
      if (mult < ENTRY_MIN_MULT || mult > ENTRY_MAX_MULT) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const size = cap < BUY_SIZE_LAMPORTS ? cap : BUY_SIZE_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      traded.add(mint);
      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    return orders;
  },

  onDone(state, done) {
    const cashSol = Number(state.cash) / Number(LAMPORTS_PER_SOL);
    console.error(
      `done: cash ${cashSol.toFixed(4)} SOL, ` +
        `distinct coins traded ${traded.size}, ` +
        `positions left ${state.positions.size}, reason ${done.reason}`,
    );
  },
});

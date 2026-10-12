// Compile this strategy under strict TypeScript to check the published
// declarations. sdk-types.test.mjs also checks runtime export parity.

import type { RestingOrder, TwapLocked } from './index.js';
import { Strategy, Order, SIDES } from './index.js';
import type {
  Ctx, Tick, Market, BookView, Side, Level, Position, Outcome, BookEvent, TradeEvent, Ladders,
} from './index.js';

interface Params {
  entry_z: number;
  size: number;
}

export default class MeanReversion extends Strategy<Params> {
  private entered = false;

  onMarketOpen(ctx: Ctx<Params>, market: Market): void {
    this.entered = false;
    // Opening metadata includes the strike, but not the terminal outcome.
    const id: string = market.market_id;
    const closes: number | null = market.close_ts_ms;
    ctx.log(`${id} closes ${closes}`);
  }

  onTick(ctx: Ctx<Params>, tick: Tick): Order | null {
    const market: string = tick.market_id;
    ctx.log(market);
    const z: number = ctx.zscore(tick.value, { window: 180 });
    const lock = ctx.twap_locked();
    const projected: number | null = lock ? lock.projected : null;
    const spotTs: number | undefined = ctx.spot()?.ts_ms;
    const same: TwapLocked | null = ctx.twapLocked();
    if (this.entered || Math.abs(z) < ctx.p.entry_z) return null;

    const side: Side = z > 0 ? 'DOWN' : 'UP';
    const book: BookView = ctx.book();
    const best: number | null = book.best(side);
    if (best === null) return null;

    const levels: Level[] = book.levels(side, 5);
    const [price, size] = levels[0];
    ctx.log(`top of book ${price} x ${size}`);

    const pos: Position = ctx.position();
    if (pos.size > 0) return null;

    // Both the rolling helpers and the history are typed.
    const mean: number | null = ctx.sma(60);
    const dev: number = ctx.stdev(60);
    const last: Tick[] = ctx.history(3);
    ctx.log(`mean=${mean} dev=${dev} seen=${last.length} at ${ctx.now}`);

    this.entered = true;
    return new Order({ side, size: ctx.p.size, limit: best, tag: 'entry' });
  }

  // The event is the change; the book it produced comes from ctx.book().
  onBook(ctx: Ctx<Params>, event: BookEvent): Order | null {
    if (event.snapshot) {
      const up: Ladders | undefined = event.levels.UP;
      ctx.log(`snapshot at ${event.ts_ms}: ${up?.asks.length ?? 0} UP asks`);
    } else {
      const level: Level = [event.px, event.size];
      ctx.log(`${event.side} ${event.ladder} ${level[0]} x ${level[1]}`);
    }
    const best: number | null = ctx.book().best('UP');
    return best === null ? null : new Order({ side: 'UP', size: ctx.p.size, limit: best });
  }

  onTrade(ctx: Ctx<Params>, trade: TradeEvent): Order | null {
    const notional: number = trade.px * trade.size;
    ctx.log(`${trade.market_id} ${trade.side} ${trade.taker} ${notional}`);
    return null;
  }

  onSettle(ctx: Ctx<Params>, market: Market, outcome: Outcome): void {
    ctx.assert_outcome(market, outcome);
  }
}

// SIDES is a readonly tuple of the two outcome tokens.
const sides: readonly ['UP', 'DOWN'] = SIDES;
export const first: Side = sides[0];

// A hook may return null, and reduce-only orders carry the snake_case field the
// wire uses.
export function exit(ctx: Ctx<Params>): Order | null {
  const pos = ctx.position();
  if (pos.side === null || pos.size === 0) return null;
  return new Order({ side: pos.side, size: pos.size, reduce_only: true });
}

// Resting orders: a gtc order rests at its limit; ctx.orders() lists what is
// still working, ctx.cancel() takes an engine id or the clientId.
export function quote(ctx: Ctx<Params>): Order[] {
  const open: RestingOrder[] = ctx.orders();
  for (const o of open) {
    const state: 'pending' | 'live' | 'cancel_pending' = o.state;
    if (state === 'live') ctx.cancel(o.client_id ?? o.id);
  }
  const bid = ctx.book().bestBid('UP');
  if (bid === null) return [];
  return [
    new Order({ side: 'UP', size: 10, limit: bid, tif: 'gtc', postOnly: true, clientId: 'bid-1' }),
    new Order({ side: 'DOWN', size: 10, limit: 0.4, tif: 'gtc', reduce_only: true }),
  ];
}

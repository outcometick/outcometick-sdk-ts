// A strategy written in TypeScript, against the published declarations.
//
// Not run — COMPILED. `sdk-types.test.mjs` puts tsc over this file under
// `strict`, so if index.d.ts stops describing the SDK a strategy author would
// actually write, the suite goes red.
//
// The declarations are hand-written (the runtime is plain ESM, loaded directly
// by the API, the worker and the sandbox with no build step), which means they
// can drift from index.mjs. This file plus the export-parity check in
// sdk-types.test.mjs is what stops that drift being silent.

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
    // Present before settlement; `outcome` deliberately is not — asking for it
    // here must not compile.
    const id: string = market.market_id;
    const closes: number | null = market.close_ts_ms;
    ctx.log(`${id} closes ${closes}`);
  }

  onTick(ctx: Ctx<Params>, tick: Tick): Order | null {
    const market: string = tick.market_id;
    ctx.log(market);
    const z: number = ctx.zscore(tick.value, { window: 180 });
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

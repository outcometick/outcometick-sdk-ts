<!--
  GENERATED — do not edit this repository directly.

  Every file here is built from the outcometick monorepo by
  scripts/publish-sdk-repos.mjs and overwritten wholesale on each publish.
  An edit made here survives until the next publish and then disappears.

  Generated from monorepo revision 55d80ca9c2090408d8b9175e803962052ce5664e.
-->

# outcometick

The strategy SDK and the `ot` command line for [outcometick.com](https://outcometick.com)
— tick-level data for Polymarket and Predict.fun crypto Up/Down markets.

```
npm i -g outcometick

ot check .                                           # validate, free, no data
ot run . --data ./polymarket-data-samples --date …   # replay locally
ot submit . --assets btc,eth --from … --to …         # send it to the queue
```

## The point of `ot check`

It runs the **same validator the queue runs** — the same module, not a copy. If
it passes locally it will not be rejected on submit. That is only true because
there is one implementation, which is why the validator and both static
analysers ship in this package rather than being reimplemented client-side.

## Writing a strategy

```js
import { Strategy, Order } from "outcometick";

export default class MeanReversion extends Strategy {
  onMarketOpen(ctx, market) { this.entered = false; }

  onTick(ctx, tick) {
    const z = ctx.zscore(tick.value, { window: 180 });
    if (this.entered || Math.abs(z) < ctx.p.entry_z) return null;
    const side = z > 0 ? "DOWN" : "UP";
    const book = ctx.book();
    this.entered = true;
    return new Order({ side, size: ctx.p.size, limit: book.best(side) });
  }
}
```

Python strategies use the same semantics with idiomatic names; `ot` runs them
by spawning your local `python3`. `pip install outcometick` gives your editor
the matching `Strategy` and `Order`.

Full reference: https://outcometick.com/docs/sdk

## What `ot run` is and is not

It is the same engine, the same report and the same archive format the queue
uses, against a local copy of the archive:

    git clone https://github.com/Ligengxin96/polymarket-data-samples

It is **not** the sandbox. Locally your strategy runs as you, with your
privileges, on your machine — which is fine, because it is your code. On our
machines it runs in a container with no network, no writable filesystem and a
hard CPU and wall-clock budget.

<!--
  GENERATED — do not edit this repository directly.

  Every file here is built from the outcometick monorepo by
  scripts/publish-sdk-repos.mjs and overwritten wholesale on each publish.
  An edit made here survives until the next publish and then disappears.

  Generated from monorepo revision 3652fc71edb3360170ce324e623b19d0ff994844.
-->

# outcometick

The TypeScript / JavaScript strategy SDK and the `ot` command line for
[outcometick.com](https://outcometick.com) — tick-level data for Polymarket and
Predict.fun crypto Up/Down markets.

```
npm i -g outcometick

ot check .                                           # validate, free, no data
ot run . --data ./polymarket-data-samples --date …   # replay locally
ot submit . --assets btc,eth --from … --to …         # send it to the queue
ot status <run_id>                                   # where it got to
ot fetch  <run_id>                                   # download the report
```

## Writing a strategy

Fully typed — `ot` ships `.d.ts` declarations, so a strategy that type-checks
is one the queue will accept.

```ts
import { Strategy, Order, type Ctx, type Tick } from "outcometick";

export default class MeanReversion extends Strategy<{ entry_z: number; size: number }> {
  private entered = false;

  onMarketOpen() { this.entered = false; }

  onTick(ctx: Ctx<{ entry_z: number; size: number }>, tick: Tick): Order | null {
    const z = ctx.zscore(tick.value, { window: 180 });
    if (this.entered || Math.abs(z) < ctx.p.entry_z) return null;
    const side = z > 0 ? "DOWN" : "UP";
    const limit = ctx.book().best(side);
    if (limit === null) return null;
    this.entered = true;
    return new Order({ side, size: ctx.p.size, limit });
  }
}
```

Plain JavaScript works too — the runtime is ESM with no build step.

## The point of `ot check`

It runs the **same validator the queue runs** — the same module, not a copy. If
it passes locally it will not be rejected on submit. That is only true because
there is one implementation, which is why the validator and the static analysers
ship in this package rather than being reimplemented client-side.

## What `ot run` is and is not

It is the same engine, the same report and the same archive format the queue
uses, against a local copy of the archive:

    git clone https://github.com/Ligengxin96/polymarket-data-samples

It is **not** the sandbox. Locally your strategy runs as you, with your
privileges, on your machine — which is fine, because it is your code. On our
machines it runs in a container with no network, no writable filesystem and a
hard CPU and wall-clock budget.

## Testing

```
npm install && npm test
```

Requires `python3` on PATH: one of the two static analysers is written in
Python, and the CLI drives it the same way the API does.

## Downloading data

The other half of the package: a client for the data subscription, on a
separate import because it has nothing to do with writing a strategy.

```ts
import { DataClient, NO_VALUE } from "outcometick/data";

const ot = new DataClient();                    // key from OT_KEY

const meta = await ot.meta();                   // what can this key see?

const { files } = await ot.files({
  from: "2026-08-01", to: "2026-08-12",         // or date: "2026-08-12"
  asset: ["BTCUSD", "ETHUSD"],                  // an array means "any of these"
  dataset: "prices",
  interval: ["5m", NO_VALUE],                   // "5m" alone EXCLUDES the
});                                             // period-less settlement streams

await ot.download(files[0], { saveTo: files[0].name });   // checksum verified
```

`meta()` reports the dimensions this key can actually reach. Note that
`intervals` holds real durations only — the `none` sentinel is reported
separately under `filterTokens`, so a caller that builds an enum from it or
parses the values as durations never meets a token.

Downloads are checksum-verified: `/v1/dl` redirects to storage with the sha256
in a header, and the client follows that redirect itself so the checksum is not
thrown away.

---

Writing your strategy in Python instead? The SDK for it is
[`pip install outcometick`](https://pypi.org/project/outcometick/). `ot` runs
those too — it is the one CLI for both languages.

Full reference: https://outcometick.com/docs/sdk

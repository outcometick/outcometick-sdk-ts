# Contributing

The code here is real source — clone it, `npm install`, `npm test` — but this
repository is **generated**. Its contents are copied from the outcometick
monorepo, where they are also what the production API and the backtest workers
run, and they are overwritten on every publish. A pull request opened against
these files cannot be merged: the next publish would erase it.

That is not bureaucracy. The validator in this package is the same code the
submission queue runs, which is what makes this promise true:

> `ot check` runs the exact validator the queue runs. If it passes locally it
> will not be rejected on submit.

A second, independently-edited copy of that validator would break the promise
quietly: your strategy would pass here and be rejected after queueing.

**Bugs, questions and suggestions are very welcome** — please open an issue on
this repository and describe what you hit. Issues are read; it is only patches
to the generated files that have nowhere to go.

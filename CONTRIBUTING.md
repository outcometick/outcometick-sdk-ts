# Contributing

This repository is a **generated mirror**. Its contents are built from the
outcometick monorepo and overwritten on every publish, so a pull request opened
against these files cannot be merged — the next build would erase it.

That is not bureaucracy. The validator in this package is the same code the
submission queue runs, which is what makes this promise true:

> `ot check` runs the exact validator the queue runs. If it passes locally it
> will not be rejected on submit.

A second, independently-edited copy of that validator would break the promise
quietly: your strategy would pass here and be rejected after queueing.

**Bugs, questions and suggestions are very welcome** — please open an issue on
this repository and describe what you hit. Issues are read; it is only patches
to the generated files that have nowhere to go.

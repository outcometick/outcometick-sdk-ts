#!/usr/bin/env node
// Thin shim so `ot` is a stable entry point regardless of the layout.
import { main } from '../cli/ot.mjs';
main(process.argv.slice(2)).then((code) => process.exit(code));

// `ot mcp` — an MCP server over stdio, for AI coding tools.
//
//   claude mcp add outcometick -e OT_KEY=ck_… -- npx -y -p outcometick ot mcp
//
// It runs on the USER's machine, started by their editor or agent, and is just
// another API client: every tool is one call the SDK clients already make,
// under the same per-key rate limits. Nothing new runs on our servers.
//
// Hand-written JSON-RPC rather than the MCP SDK: the package ships no runtime
// dependencies, and the stdio transport is newline-delimited JSON with five
// methods. stdout carries protocol messages ONLY — anything else written there
// corrupts the stream — so diagnostics go to stderr.
//
// Deliberately absent: submitting a backtest. A submit spends the customer's
// credits, and an agent must not be able to do that on its own initiative.
// The tools here read, quote, validate locally, and download files the key
// already pays for.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { DataClient, OutcometickError, DEFAULT_BASE_URL } from '../client/data.mjs';
import { get as apiGet, post as apiPost } from './api-client.mjs';
import { SDK_VERSION, BacktestRejection } from '../api/lib/backtest-contract.mjs';

/** Protocol revisions this server speaks; the first is offered when the client's is unknown. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `outcometick: historical tick data for Polymarket and Predict.fun crypto up/down markets, and a hosted backtester.
Full documentation in one plain-text file: https://outcometick.com/llms-full.txt
Data tools need OT_KEY (a data subscription key); backtest run tools need OT_BACKTEST_KEY. Public tools need neither.
This server cannot submit a backtest — that spends credits. Use \`ot submit\` yourself after the user agrees to the quote.`;

/** Rows returned by list_files before truncating; the full count is always reported. */
export const MAX_FILE_ROWS = 1000;
const DEFAULT_FILE_ROWS = 200;

const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD (UTC)' };
const VENUE = { type: 'string', enum: ['polymarket', 'predict'] };
const LIST = (what) => ({
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
  description: `${what}. A list means "any of these".`,
});

class ToolError extends Error {}

/**
 * Write `bytes` to `target` without ever writing through an existing path.
 *
 * Written whole to a fresh temp file first ('wx' fails on ANY existing entry,
 * a symlink included, and never follows one), then published with link(),
 * which also refuses an existing name — so a link planted under the archive
 * name cannot redirect the write, a concurrent download of the same file
 * cannot interleave with this one, and a failure part-way leaves no partial
 * file under the real name and never touches a file that was already there.
 *
 * Filesystems without hard links (exFAT/FAT, the usual external drive) refuse
 * link(); there it falls back to an exclusive copy (COPYFILE_EXCL opens the
 * target O_CREAT|O_EXCL: still refuses any existing name, still never follows
 * a link). That copy is not atomic — an interruption can leave a partial file
 * under the real name. A failed copy is NOT cleaned up here: libuv already
 * unlinks its own half-written target before returning the error, and by the
 * time we saw it a concurrent download may have created that name afresh —
 * deleting by path would delete someone else's file. A partial file left by a
 * crash is the lesser harm, and the error says the download failed.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

export async function publishFile(target, bytes, { linkImpl = link, copyImpl = copyFile } = {}) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.part`);
  const fh = await open(tmp, 'wx', 0o644);
  try {
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const exists = () => new ToolError(`${target} already exists; this tool never overwrites. Delete it first to download again.`);
    try {
      await linkImpl(tmp, target);
    } catch (err) {
      if (err?.code === 'EEXIST') throw exists();
      if (!NO_HARD_LINKS.has(err?.code)) throw err;
      try {
        await copyImpl(tmp, target, fsConstants.COPYFILE_EXCL);
      } catch (copyErr) {
        if (copyErr?.code === 'EEXIST') throw exists();
        throw copyErr;
      }
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

const read = { readOnlyHint: true, openWorldHint: true };

/**
 * The tools. `run(args, ctx)` returns a JSON-able value or throws; the
 * dispatcher turns either into an MCP result.
 */
export const TOOLS = [
  {
    name: 'coverage',
    description: 'What the archive holds, per venue: assets, datasets and the day range. Public, no key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: (_a, ctx) => ctx.data(false).coverage(),
  },
  {
    name: 'plans',
    description: 'Data subscription plans and their live prices. Public, no key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: (_a, ctx) => ctx.data(false).plans(),
  },
  {
    name: 'meta',
    description: 'The date window the configured data key (OT_KEY) can download, and every venue, asset, interval and dataset value inside it. Call this before list_files: it names the real filter values.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: (_a, ctx) => ctx.data(true).meta(),
  },
  {
    name: 'list_files',
    description: 'Search archive files the data key can download. Every filter is optional; without a date it lists the newest day in reach. '
      + 'asset is the BASE symbol (BTC, not BTCUSD). interval "5m" EXCLUDES the period-less settlement streams (prices, twap30s, twap60s); pass ["5m","none"] to get both. '
      + 'Ranges are capped at 92 days.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAY, from: DAY, to: DAY,
        venue: LIST('polymarket | predict'),
        dataset: LIST('e.g. prices, twap60s, book, markets, last_trade_price, klines, orderbook'),
        asset: LIST('Base symbol, e.g. BTC'),
        interval: LIST('e.g. 5m, 15m, 1m, or "none" for period-less files'),
        format: { type: 'string', enum: ['gz', 'parquet'], description: 'parquet lists the Parquet copy of each file (same rows, already typed); default gz, the archive files' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_FILE_ROWS, description: `Rows to return (default ${DEFAULT_FILE_ROWS}); count and bytes always cover everything matched.` },
      },
      additionalProperties: false,
    },
    annotations: read,
    run: async (a, ctx) => {
      const res = await ctx.data(true).files(a);
      const limit = Math.min(Math.max(Number(a.limit) || DEFAULT_FILE_ROWS, 1), MAX_FILE_ROWS);
      const files = res.files ?? [];
      // The download url is dropped: it needs the key to use, and download_file
      // takes the (date, name) pair anyway.
      const rows = files.slice(0, limit).map(({ url, ...row }) => row);
      return { ...res, files: rows, returned: rows.length, truncated: files.length > rows.length };
    },
  },
  {
    name: 'download_file',
    description: 'Download one archive file into a local directory and verify its sha256. Never overwrites: if the file is already there, delete it first. Files are gzipped CSV or JSONL; take date and name from list_files.',
    inputSchema: {
      type: 'object',
      properties: {
        date: DAY,
        name: { type: 'string', description: 'File name exactly as list_files reports it' },
        dir: { type: 'string', description: 'Directory to save into (created if missing). Defaults to the current directory.' },
      },
      required: ['date', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, ctx) => {
      // The name becomes a path on the user's disk: archive names only, no
      // separators, so the file lands directly inside the chosen directory.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(a.name ?? ''))) {
        throw new ToolError(`not an archive file name: ${JSON.stringify(a.name)}`);
      }
      await mkdir(path.resolve(ctx.cwd, a.dir ?? '.'), { recursive: true });
      // Reported resolved, so a directory that is itself a link says where the
      // file really went. The directory is the caller's choice; the FILE is not.
      const dir = await realpath(path.resolve(ctx.cwd, a.dir ?? '.'));
      const target = path.join(dir, a.name);
      const { bytes, sha256 } = await ctx.data(true).download(a.date, a.name);
      await publishFile(target, bytes);
      return { saved: target, bytes: bytes.length, sha256, verified: Boolean(sha256) };
    },
  },
  {
    name: 'backtest_capacity',
    description: 'Which days can be backtested on a venue right now (only the most recent window is sold), and how busy the queue is. Public.',
    inputSchema: { type: 'object', properties: { venue: VENUE }, required: ['venue'], additionalProperties: false },
    annotations: read,
    run: (a, ctx) => ctx.api('GET', `/v1/backtest/capacity?venue=${encodeURIComponent(a.venue)}`),
  },
  {
    name: 'backtest_quote',
    description: 'Price a backtest scope in credits (1 credit = 1 market-day) without submitting anything. Public. '
      + 'Give either from/to or days (the most recent n archived days).',
    inputSchema: {
      type: 'object',
      properties: {
        venue: VENUE,
        assets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Base symbols, e.g. ["BTC","ETH"]' },
        from: DAY, to: DAY,
        days: { type: 'integer', minimum: 1 },
        intervals: { type: 'array', items: { type: 'string', enum: ['5m', '15m'] } },
        language: { type: 'string', description: 'Runtime from the manifest, e.g. "python@3.14" or "nodejs@24"; changes how many market-days one run may hold' },
      },
      required: ['venue', 'assets'],
      additionalProperties: false,
    },
    annotations: read,
    run: (a, ctx) => ctx.api('POST', '/v1/backtest/quote', a),
  },
  {
    name: 'check_strategy',
    description: 'Validate a strategy directory (manifest.json plus source) with the exact validator the backtest queue runs. Local, free, no network, no key.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'The strategy directory. Defaults to the current directory.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a, ctx) => {
      // Imported here, not at the top: ot.mjs pulls in both analysers, which
      // the data tools never need.
      const { readSubmission, validate } = await import('./ot.mjs');
      const dir = path.resolve(ctx.cwd, a.dir ?? '.');
      try {
        const res = await validate(await readSubmission(dir));
        return {
          ok: true,
          dir,
          language: res.manifest.language,
          entry: res.manifest.entry,
          hooks: res.hookNames,
          datasets: res.manifest.datasets,
          intervals: res.manifest.intervals,
          files: res.files.map((f) => ({ name: f.name, bytes: f.bytes })),
          imports: res.analysis.imports,
        };
      } catch (err) {
        // A rejection is the ANSWER to "is this valid", not a tool failure.
        // Only the validator's own: a missing directory also carries a `code`
        // (ENOENT), and is a failure to check, not a verdict.
        if (err instanceof BacktestRejection) return { ok: false, dir, code: err.code, detail: err.detail ?? err.message };
        throw err;
      }
    },
  },
  {
    name: 'backtest_runs',
    description: 'Recent backtest runs under the configured backtest key (OT_BACKTEST_KEY), and the credit balance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: read,
    run: async (_a, ctx) => {
      const [runs, balance] = await Promise.all([
        ctx.api('GET', '/v1/backtest/runs', null, true),
        ctx.api('GET', '/v1/backtest/balance', null, true),
      ]);
      return { balance: balance.balance, runs: runs.runs };
    },
  },
  {
    name: 'backtest_status',
    description: 'One backtest run under the configured backtest key: status, scope, credits held and spent, and the report summary once done.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
    annotations: read,
    run: (a, ctx) => ctx.api('GET', `/v1/backtest/run/${encodeURIComponent(a.run_id)}`, null, true),
  },
];

/** The per-session context the tools run in. Injected whole by tests. */
export function makeContext({ baseUrl = DEFAULT_BASE_URL, env = process.env, cwd = process.cwd(), fetchImpl = null } = {}) {
  const api = String(baseUrl).replace(/\/+$/, '');
  return {
    cwd,
    data(needsKey) {
      if (needsKey && !env.OT_KEY) {
        throw new ToolError('OT_KEY is not set. Add your data subscription key to this MCP server\'s env (e.g. claude mcp add … -e OT_KEY=ck_…).');
      }
      return new DataClient({ key: env.OT_KEY ?? null, baseUrl: api, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    },
    async api(method, p, body = null, needsKey = false) {
      const key = needsKey ? env.OT_BACKTEST_KEY : null;
      if (needsKey && !key) {
        throw new ToolError('OT_BACKTEST_KEY is not set. Add the backtest key you were emailed to this MCP server\'s env.');
      }
      const r = method === 'POST' ? await apiPost(api, p, body ?? {}, key) : await apiGet(api, p, key);
      if (r.status >= 200 && r.status < 300) return r.json;
      throw new OutcometickError(r.status, r.json ?? r.text, `${api}${p}`);
    },
  };
}

const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    return textResult(await tool.run(args ?? {}, ctx));
  } catch (err) {
    // Tool failures go back to the model as results it can read and act on —
    // a 403 carries the real floor/ceiling — not as protocol errors.
    if (err instanceof OutcometickError) {
      return textResult({ error: err.message, status: err.status, body: err.body }, true);
    }
    return textResult({ error: err?.message ?? String(err) }, true);
  }
}

/**
 * Answer one JSON-RPC message. Returns the response object, or null for a
 * notification (no id) or anything that must not be answered.
 */
export async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && msg.id != null
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'invalid request' } }
      : null;
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  const reply = (result) => (isRequest ? { jsonrpc: '2.0', id: msg.id, result } : null);
  const fail = (code, message) => (isRequest ? { jsonrpc: '2.0', id: msg.id, error: { code, message } } : null);

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'outcometick', version: SDK_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case 'tools/call': {
      const result = await callTool(msg.params?.name, msg.params?.arguments, ctx);
      return result ? reply(result) : fail(-32602, `unknown tool ${JSON.stringify(msg.params?.name)}`);
    }
    default:
      // notifications/initialized, notifications/cancelled and anything else
      // without an id need no answer; an unknown REQUEST gets the standard error.
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve newline-delimited JSON-RPC on stdin/stdout until stdin closes. */
export async function serve({ input = process.stdin, output = process.stdout, ctx = makeContext() } = {}) {
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const pending = new Set();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    // Concurrent: a slow download must not hold up a ping or a second call.
    const p = handleMessage(msg, ctx)
      .then((res) => { if (res) write(res); })
      .catch((err) => {
        process.stderr.write(`ot mcp: ${err?.stack ?? err}\n`);
        if (msg?.id != null) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal error' } });
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

export async function cmdMcp({ flags }) {
  await serve({ ctx: makeContext({ baseUrl: flags.api ?? DEFAULT_BASE_URL }) });
  return 0;
}

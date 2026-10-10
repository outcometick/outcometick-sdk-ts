// `ot init <dir> --template <id> [--lang python|nodejs]` — start from a template.
//
// The templates are the files under templates/<id>/<lang>/, shipped in this
// package. The same files are what the web editor offers and what the public
// templates repository publishes, and runner/conformance runs them through both
// engines — so what a user starts from here is code that is known to trade.
//
// It never overwrites: a directory that already holds an outcometick.json or a
// strategy file is somebody's work.

import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');
export const TEMPLATE_LANGS = ['python', 'nodejs'];
const SAMPLE = 'https://github.com/outcometick/polymarket-tick-data-samples/releases/latest/download/polymarket-data-samples.tar.gz';

/** Every template, with its metadata, in a stable order. */
export async function listTemplates() {
  const ids = (await readdir(TEMPLATES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(ids.map(async (id) => ({
    id, ...JSON.parse(await readFile(path.join(TEMPLATES_DIR, id, 'template.json'), 'utf8')),
  })));
}

function usage(templates) {
  const lines = templates.map((t) => `    ${t.id.padEnd(22)} ${t.summary.en}${t.runsLocally ? '' : ' (hosted backtest only)'}`);
  return `usage: ot init <dir> --template <id> [--lang python|nodejs]\n\n  templates:\n${lines.join('\n')}\n`;
}

export async function cmdInit({ dir, flags }) {
  const templates = await listTemplates();
  const t = templates.find((x) => x.id === flags.template);
  if (!t) {
    if (flags.template) process.stderr.write(`no template ${JSON.stringify(flags.template)}\n\n`);
    process.stdout.write(usage(templates));
    return flags.template ? 2 : 0;
  }
  const lang = flags.lang ?? 'python';
  if (!TEMPLATE_LANGS.includes(lang)) {
    process.stderr.write(`--lang must be one of ${TEMPLATE_LANGS.join(', ')}\n`);
    return 2;
  }

  const src = path.join(TEMPLATES_DIR, t.id, lang);
  const names = (await readdir(src)).sort();
  await mkdir(dir, { recursive: true });
  // Checked up front so a clash leaves nothing half-written; the 'wx' below
  // still refuses anything that appears in between.
  for (const name of names) {
    const exists = await lstat(path.join(dir, name)).then(() => true, () => false);
    if (exists) {
      process.stderr.write(`${path.join(dir, name)} already exists — not overwriting. Pick an empty directory.\n`);
      return 1;
    }
  }
  for (const name of names) {
    try {
      // 'wx': refuse an existing file (or link) rather than overwrite it.
      await writeFile(path.join(dir, name), await readFile(path.join(src, name)), { flag: 'wx' });
    } catch (err) {
      if (err?.code === 'EEXIST') {
        process.stderr.write(`${path.join(dir, name)} already exists — not overwriting. Pick an empty directory.\n`);
        return 1;
      }
      throw err;
    }
  }

  const where = path.resolve(dir);
  const out = [`\n  ${t.title.en} (${lang}) → ${where}`, `  files     ${names.join(', ')}`, '', '  next:', `    ot check ${dir}`];
  if (t.runsLocally) {
    out.push(
      `    curl -L ${SAMPLE} | tar xz`,
      `    ot run ${dir} --data ./polymarket-data-samples`,
    );
  } else {
    out.push(
      '    # this template reads a Binance reference feed, which only the hosted backtest has:',
      `    OT_BACKTEST_KEY=bt_… ot submit ${dir} --assets btc --days 7`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n\n`);
  return 0;
}

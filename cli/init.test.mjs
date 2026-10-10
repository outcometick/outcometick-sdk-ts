// `ot init` and the templates it copies.
//
// runner/conformance proves the templates TRADE identically in both engines;
// this proves they are complete, valid, in step with each other, and that
// `ot init` hands them over byte for byte without ever overwriting anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { listTemplates, TEMPLATES_DIR, TEMPLATE_LANGS } from './commands/init.mjs';
import { readSubmission, validate } from './ot.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./ot.mjs', import.meta.url));
const ot = (args, cwd) => run(process.execPath, [CLI, ...args], { cwd }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
);
const STRATEGY_FILE = { python: 'strategy.py', nodejs: 'strategy.mjs' };

test('every template is complete, described in both languages, and valid', async () => {
  const templates = await listTemplates();
  assert.ok(templates.length >= 2, 'templates are missing');
  for (const t of templates) {
    for (const loc of ['en', 'zh']) {
      assert.ok(t.title?.[loc]?.trim(), `${t.id}: no ${loc} title`);
      assert.ok(t.summary?.[loc]?.trim(), `${t.id}: no ${loc} summary`);
    }
    assert.equal(typeof t.runsLocally, 'boolean', `${t.id}: runsLocally`);
    const manifests = {};
    for (const lang of TEMPLATE_LANGS) {
      const dir = path.join(TEMPLATES_DIR, t.id, lang);
      assert.deepEqual((await readdir(dir)).sort(), ['outcometick.json', STRATEGY_FILE[lang]].sort(), `${t.id}/${lang}`);
      // The queue's own validator: what `ot init` hands out passes `ot check`.
      const res = await validate(await readSubmission(dir));
      manifests[lang] = res.manifest;
    }
    // One strategy written twice: the knobs and the data must be the same.
    for (const field of ['hooks', 'datasets', 'intervals', 'reference', 'params', 'mode', 'latency']) {
      assert.deepEqual(manifests.nodejs[field], manifests.python[field], `${t.id}: ${field} differs between languages`);
    }
    // A template that needs a reference feed cannot run locally; saying it can
    // sends a new user straight into the refusal in `ot run`.
    assert.equal(t.runsLocally, (manifests.python.reference ?? []).length === 0, `${t.id}: runsLocally is wrong`);
  }
});

test('ot init with no template lists them, and an unknown one is an error', async () => {
  const list = await ot(['init']);
  assert.equal(list.code, 0);
  for (const t of await listTemplates()) assert.match(list.stdout, new RegExp(t.id));
  const bad = await ot(['init', 'x', '--template', 'nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /no template "nope"/);
});

test('ot init copies the files byte for byte and points at the next step', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-init-'));
  try {
    for (const lang of TEMPLATE_LANGS) {
      for (const t of await listTemplates()) {
        const dest = path.join(work, `${t.id}-${lang}`);
        const r = await ot(['init', dest, '--template', t.id, '--lang', lang]);
        assert.equal(r.code, 0, r.stderr);
        for (const name of await readdir(path.join(TEMPLATES_DIR, t.id, lang))) {
          assert.deepEqual(await readFile(path.join(dest, name)), await readFile(path.join(TEMPLATES_DIR, t.id, lang, name)));
        }
        assert.match(r.stdout, t.runsLocally ? /ot run / : /ot submit /);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('ot init never overwrites and leaves nothing half-written', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'ot-init-'));
  try {
    // strategy.py exists, outcometick.json does not: copying the manifest
    // first and then failing would leave a mixed directory.
    await writeFile(path.join(work, 'strategy.py'), 'mine');
    const r = await ot(['init', work, '--template', 'favourite-near-close']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists/);
    assert.equal(await readFile(path.join(work, 'strategy.py'), 'utf8'), 'mine');
    assert.deepEqual(await readdir(work), ['strategy.py']);

    const lang = await ot(['init', path.join(work, 'x'), '--template', 'favourite-near-close', '--lang', 'golang']);
    assert.equal(lang.code, 2);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// Only in the monorepo: the published package has no scripts/ directory.
const BUILD = fileURLToPath(new URL('../scripts/build-packages.mjs', import.meta.url));
test('every template file ships in the npm package', existsSync(BUILD) ? {} : { skip: 'not in the monorepo' }, async () => {
  const src = await readFile(BUILD, 'utf8');
  const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  }))).flat();
  const root = path.dirname(TEMPLATES_DIR);
  const files = (await walk(TEMPLATES_DIR)).map((p) => path.relative(root, p).split(path.sep).join('/'));
  assert.ok(files.length >= 10);
  const missing = files.filter((f) => !src.includes(`'${f}'`));
  assert.deepEqual(missing, [], 'add these to NPM_FILES, or `ot init` ships an incomplete template');
});

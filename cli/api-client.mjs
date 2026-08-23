// The HTTP side of the CLI, in one place.
//
// Shared so that the key is read the same way everywhere: from the environment,
// never from a flag. A flag lands in shell history and in the process list, and
// this key spends money.

export const DEFAULT_API = 'https://outcometick.com';

/** The key, from the environment. */
export function readKey() {
  const key = process.env.OT_BACKTEST_KEY;
  if (!key) {
    throw new Error('OT_BACKTEST_KEY is not set.\n'
      + '  It is the key you were emailed when you bought credits.\n'
      + '  export OT_BACKTEST_KEY="bt_…"');
  }
  return key;
}

async function request(api, path, { method = 'GET', body, key, redirect } = {}) {
  let res;
  try {
    res = await fetch(`${api}${path}`, {
      method,
      ...(redirect ? { redirect } : {}),
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`could not reach ${api}: ${err.message}`);
  }
  return res;
}

/** GET returning parsed JSON, without throwing on a non-2xx. */
export async function get(api, path, key) {
  const res = await request(api, path, { key });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

/** POST returning parsed JSON, without throwing on a non-2xx. */
export async function post(api, path, body, key) {
  const res = await request(api, path, { method: 'POST', body, key });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

/**
 * GET a binary body, following the archive endpoint's redirect to R2.
 *
 * The redirect target is presigned and short-lived, so it is followed
 * immediately rather than handed back to the caller to use later.
 */
export async function getBinary(api, path, key) {
  const res = await request(api, path, { key });
  if (!res.ok) {
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, body: null };
  }
  return { status: res.status, json: null, text: '', body: Buffer.from(await res.arrayBuffer()) };
}

// Extend buildReport for generic data: dataset identity, marked valuations,
// and strategy results on the resolved markets used by baselines.
// Keep in sync with client/backtest/generic_report.py.

const r2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : null);

/** Maximum rows listed for zero_legs and unusable; counts include all rows. */
export const LISTED = 50;

/**
 * @param {object} o
 * @param {Array} o.trades     parsed trade rows of the run
 * @param {Array} o.markets    decoded market entries that were replayed
 * @param {Array} o.unusable   markets the decoder refused, with reasons
 * @param {object} o.counts    the decoder's row counts
 */
export function genericReportExtras({ trades, markets, unusable, counts }) {
  const marked = trades.filter((t) => t.how === 'marked');
  const markedPnl = marked.reduce((a, t) => a + (Number.isFinite(t.marked_pnl) ? t.marked_pnl : 0), 0);
  const total = trades.reduce((a, t) => a + (Number.isFinite(t.pnl) ? t.pnl : 0), 0);
  const zero = marked.filter((t) => t.mark_px == null);
  const ages = marked.map((t) => t.mark_age_ms).filter((v) => Number.isFinite(v));
  const resolved = new Set(markets.filter((m) => m.market.outcome).map((m) => m.market.market_id));
  const onResolved = trades.filter((t) => resolved.has(t.market_id));
  const opens = markets.map((m) => m.market.open_ts_ms).filter(Number.isFinite);
  const closes = markets.map((m) => m.market.close_ts_ms).filter(Number.isFinite);
  return {
    data_kind: 'generic',
    scope: {
      venue: 'polymarket',
      unit: 'market',
      markets: markets.length,
      resolved_markets: resolved.size,
      marked_markets: markets.length - resolved.size,
      from_ms: opens.length ? Math.min(...opens) : null,
      to_ms: closes.length ? Math.max(...closes) : null,
    },
    valuation: {
      // net_pnl includes valuations when trade rows close at a mark.
      net_pnl_includes_marks: marked.length > 0,
      realised_pnl: r2(total - markedPnl),
      marked_pnl: r2(markedPnl),
      marked_legs: marked.length,
      marked_markets: new Set(marked.map((t) => t.market_id)).size,
      zero_legs: zero.length,
      zero_legs_listed: zero.slice(0, LISTED).map((t) => ({
        market_id: t.market_id, side: t.side, label: t.label ?? null, size: t.marked_size, reason: t.mark_missing,
      })),
      max_age_ms: ages.length ? Math.max(...ages) : null,
      // All open legs had marks; freshness is reported per row and in max_age_ms.
      complete: zero.length === 0,
      note: 'marked legs are valued at the external mid (or last public trade) when trading ended — not an executable exit',
    },
    // Restrict strategy comparisons to the resolved markets used by baselines.
    strategy_on_resolved: {
      markets: resolved.size,
      net_pnl: r2(onResolved.reduce((a, t) => a + (Number.isFinite(t.pnl) ? t.pnl : 0), 0)),
      trades: onResolved.length,
    },
    coverage_generic: {
      markets_replayed: markets.length,
      unusable: unusable.length,
      unusable_listed: unusable.slice(0, LISTED),
      rows: counts,
    },
  };
}

/** buildReport's output, made a generic-data report. Key order is part of the bytes. */
export function applyGenericExtras(report, extras) {
  const out = {};
  for (const [k, v] of Object.entries(report)) {
    if (k === 'scope') out.scope = extras.scope;
    else if (k === 'coverage') out.coverage = v == null ? v : { ...v, generic: extras.coverage_generic };
    else out[k] = v;
    if (k === 'run_id') out.data_kind = extras.data_kind;
  }
  out.valuation = extras.valuation;
  out.strategy_on_resolved = extras.strategy_on_resolved;
  return out;
}

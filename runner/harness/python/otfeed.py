"""Point-in-time views over reference feeds and external series.

ctx.ref(name) and ctx.ext(name) use feed.view_at(ctx.now). Views expose
only rows visible at that time and return copies to protect later reads.
lag_ms delays visibility until ts_ms + lag_ms.

Keep in sync with runner/engine/feed.mjs; runner/conformance checks parity."""

from __future__ import annotations

from bisect import bisect_right

from otengine import Rec

__all__ = ("PointInTimeFeed", "build_feeds")


class _View:
    """What a strategy holds. Read-only, and clamped to the moment it was made."""

    __slots__ = ("_rows", "_n", "_horizon")

    def __init__(self, rows, n, horizon):
        self._rows = rows
        self._n = n
        self._horizon = horizon

    @property
    def last(self):
        """The most recent row at or before now, or None."""
        return Rec(self._rows[self._n - 1]) if self._n > 0 else None

    def window(self, k):
        """The last ``k`` visible rows, oldest first. Never more than exist."""
        try:
            want = int(k)
        except (TypeError, ValueError):
            want = 0
        want = max(0, min(want, self._n))
        return [Rec(r) for r in self._rows[self._n - want:self._n]]

    def at(self, ts):
        """The row in effect at ``ts``, clamped to now.

        Asking for a later timestamp cannot reach a later row.
        """
        try:
            asked = float(ts)
        except (TypeError, ValueError):
            asked = self._horizon
        t = min(asked, self._horizon)
        # bisect over the visible prefix only.
        i = bisect_right([r["ts_ms"] for r in self._rows[:self._n]], t)
        return Rec(self._rows[i - 1]) if i > 0 else None


class PointInTimeFeed:
    def __init__(self, rows, lag_ms=0):
        self.rows = rows
        try:
            self.lag_ms = float(lag_ms) or 0.0
        except (TypeError, ValueError):
            self.lag_ms = 0.0
        # Replay advances monotonically, so each market's feed is scanned once.
        self.cursor = 0

    def _visible_count(self, now):
        limit = now - self.lag_ms
        rows = self.rows
        while self.cursor < len(rows) and rows[self.cursor]["ts_ms"] <= limit:
            self.cursor += 1
        if self.cursor > 0 and rows[self.cursor - 1]["ts_ms"] > limit:
            i = self.cursor
            while i > 0 and rows[i - 1]["ts_ms"] > limit:
                i -= 1
            return i
        return self.cursor

    def view_at(self, now):
        return _View(self.rows, self._visible_count(now), now - self.lag_ms)


def build_feeds(declared, rows_by_name, lag_by_name=None):
    """Feeds a run declared, keyed by the name the strategy will ask for."""
    lag_by_name = lag_by_name or {}
    return {
        name: PointInTimeFeed(rows_by_name.get(name, []), lag_by_name.get(name, 0))
        for name in (declared or [])
    }

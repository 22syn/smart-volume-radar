#!/usr/bin/env python3
"""
60-day Normal Radar backtest — return-since-alert per signal.

Source of alerts: monitor-list.json events[] array — every `alert-*` and
`re-alert-*` event (full/close/recovery) is one signal. This captures
the actual firing history per day per tier (including later upgrades),
which neither monitor-entry firstAlertLevel nor empty daily scan JSONs do.

Current price: lean-2026-05-10.json (latest 365-ticker snapshot,
effectively 2026-05-08 closes since today is Sun 2026-05-11).

Window: alerts in last 60 trading days (cal cutoff ~2026-02-12).

Two cohorts computed:
  - all-firings: every event row in window → return from event price to now
  - first-by-tier: each (ticker, tier) counted once at its first firing in window

Writes results/backtest-60d-since-alert.json.
"""
import json, datetime as dt, collections
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"
TODAY = dt.date(2026, 5, 11)
CUTOFF = TODAY - dt.timedelta(days=int(60 * 7 / 5) + 4)

# ─── Current prices ──────────────────────────────────────────────────
lean = json.loads((RES / "lean-2026-05-10.json").read_text())
stocks_now = None
for k in ("stocks", "snapshot", "entries"):
    if isinstance(lean.get(k), list): stocks_now = lean[k]; break
if stocks_now is None:
    for v in lean.values():
        if isinstance(v, list) and v and isinstance(v[0], dict) and "ticker" in v[0]:
            stocks_now = v; break
price_now = {s["ticker"]: s["lastPrice"] for s in stocks_now
             if s.get("ticker") and s.get("lastPrice")}
print(f"current prices: {len(price_now)} tickers")

# ─── Read all events in window ───────────────────────────────────────
ml = json.loads((RES / "monitor-list.json").read_text())
print(f"monitor entries total: {len(ml['entries'])}, lastUpdated={ml['lastUpdated']}")

# Map event-type → tier
def tier_of(ev_type: str):
    # 'alert-close', 're-alert-close', 'alert-full', 're-alert-full', 'graduated', etc.
    if "close" in ev_type: return "close"
    if "full" in ev_type: return "full"
    if "recovery" in ev_type: return "recovery"
    return None

all_firings = []
tickers_seen = set()
sector_of = {}
for entry in ml["entries"]:
    t = entry["ticker"]
    sector_of[t] = entry.get("sector")
    for ev in entry.get("events", []):
        d_str = ev.get("date")
        if not d_str: continue
        try: d = dt.date.fromisoformat(d_str)
        except ValueError: continue
        if d < CUTOFF or d > TODAY: continue
        ev_type = ev.get("type", "")
        tier = tier_of(ev_type)
        if tier is None: continue
        if t not in price_now: continue
        p0 = ev.get("price")
        if not p0 or p0 <= 0: continue
        p1 = price_now[t]
        all_firings.append({
            "ticker": t,
            "date": d_str,
            "tier": tier,
            "evType": ev_type,
            "alertPrice": p0,
            "currentPrice": p1,
            "returnPct": (p1 - p0) / p0 * 100,
            "rvol": ev.get("rvol"),
            "sector": sector_of.get(t),
        })
        tickers_seen.add(t)

print(f"firings in window: {len(all_firings)} across {len(tickers_seen)} unique tickers")

# Cohort 1: all firings
# Cohort 2: first (ticker, tier) firing in window
first_by_tier = {}
for f in sorted(all_firings, key=lambda x: x["date"]):
    k = (f["ticker"], f["tier"])
    if k not in first_by_tier: first_by_tier[k] = f
first_cohort = list(first_by_tier.values())
print(f"first-(ticker,tier) cohort: {len(first_cohort)}")

# ─── Stats ──────────────────────────────────────────────────────────
def stats(xs):
    if not xs: return None
    rs = sorted(x["returnPct"] for x in xs)
    n = len(rs)
    return {
        "n": n,
        "median": rs[n // 2],
        "mean": sum(rs) / n,
        "hit": sum(1 for r in rs if r > 0) / n * 100,
        "p25": rs[max(0, n // 4)],
        "p75": rs[min(n - 1, (3 * n) // 4)],
        "min": rs[0],
        "max": rs[-1],
    }

def line(label, s, w=14):
    if s is None: print(f"  {label:>{w}}  (no data)"); return
    print(f"  {label:>{w}}  n={s['n']:>4}  median={s['median']:+6.1f}%  "
          f"mean={s['mean']:+6.1f}%  hit={s['hit']:5.1f}%  "
          f"p25={s['p25']:+6.1f}%  p75={s['p75']:+6.1f}%  "
          f"range=[{s['min']:+5.0f},{s['max']:+5.0f}]")

def print_cohort(name, rows):
    print(f"\n{'='*100}\n{name} — n={len(rows)} firings, "
          f"unique tickers={len({r['ticker'] for r in rows})}\n{'='*100}")
    line("ALL", stats(rows))
    for tier in ("full", "recovery", "close"):
        line(tier.upper(), stats([r for r in rows if r["tier"] == tier]))

print_cohort("COHORT A — every firing in window (would equal-weight each alert event)", all_firings)
print_cohort("COHORT B — first (ticker, tier) in window (deduped cohort)", first_cohort)

# Top / bottom (cohort B is more interpretable)
ranked = sorted(first_cohort, key=lambda x: x["returnPct"], reverse=True)
print("\nTOP 15 (first-firing cohort)")
for x in ranked[:15]:
    print(f"  {x['returnPct']:+7.1f}%  {x['ticker']:<10} {x['tier']:<8} "
          f"{x['date']} @ {x['alertPrice']:.2f} → {x['currentPrice']:.2f}  "
          f"RVOL {x['rvol']:.1f}x  {x['sector'] or ''}")
print("\nBOTTOM 15")
for x in ranked[-15:]:
    print(f"  {x['returnPct']:+7.1f}%  {x['ticker']:<10} {x['tier']:<8} "
          f"{x['date']} @ {x['alertPrice']:.2f} → {x['currentPrice']:.2f}  "
          f"RVOL {x['rvol']:.1f}x  {x['sector'] or ''}")

# Sector
print("\nBY SECTOR (first-firing cohort, ≥3 alerts)")
sect = collections.defaultdict(list)
for x in first_cohort: sect[x["sector"] or "(unknown)"].append(x)
for s in sorted(sect, key=lambda k: -len(sect[k])):
    if len(sect[s]) < 3: continue
    line(s, stats(sect[s]), w=28)

# Hold-time stratification (how returns scale with how long ago alert fired)
print("\nBY HOLD WINDOW (first-firing cohort)")
def days_held(x):
    return (TODAY - dt.date.fromisoformat(x["date"])).days
for lo, hi, label in [(0, 14, "<2 weeks"), (15, 30, "2-4 weeks"),
                      (31, 60, "1-2 months"), (61, 999, "2+ months")]:
    rows = [x for x in first_cohort if lo <= days_held(x) <= hi]
    line(label, stats(rows))

# Save
out = {
    "today": TODAY.isoformat(),
    "windowCutoff": CUTOFF.isoformat(),
    "cohortA_allFirings": {
        "n": len(all_firings),
        "byTier": {t: stats([r for r in all_firings if r["tier"] == t])
                   for t in ("full", "recovery", "close")},
    },
    "cohortB_firstByTier": {
        "n": len(first_cohort),
        "byTier": {t: stats([r for r in first_cohort if r["tier"] == t])
                   for t in ("full", "recovery", "close")},
        "alerts": first_cohort,
    },
}
(RES / "backtest-60d-since-alert.json").write_text(json.dumps(out, indent=2))
print(f"\nWritten: results/backtest-60d-since-alert.json")

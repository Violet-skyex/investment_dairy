#!/usr/bin/env python3
"""
Fetch market prices for all tracked tickers, auto-verify open predictions,
and compute cumulative return index per account from full transaction history.
Called by GitHub Actions at 9:35 AM ET and 4:05 PM ET on weekdays.
"""
import json
import sys
import time
from datetime import datetime, date, timezone

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

DB_PATH     = "data/db.json"
PRICES_PATH = "data/prices.json"
CHART_PATH  = "data/chart_data.json"

# Symbols that have no yfinance listing
SKIP_TICKERS = {"84679P306", "SPAXX", "SPAXX**", "", "Pending activity", "Pending Activity"}


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


# ── Current prices ────────────────────────────────────────────────────────────

def get_tickers(db):
    tickers = set()
    for pred in db.get("predictions", []):
        if pred.get("result") is None:
            t = pred.get("ticker", "").strip()
            if t:
                tickers.add(t)
    snapshots = db.get("position_snapshots", [])
    if snapshots:
        latest_date = max((s["date"] for s in snapshots if s.get("date")), default=None)
        if latest_date:
            for snap in snapshots:
                if snap.get("date") == latest_date:
                    sym = snap.get("symbol", "").strip()
                    if sym:
                        tickers.add(sym)
    return tickers - SKIP_TICKERS


def fetch_prices(tickers):
    prices = {}
    for ticker in sorted(tickers):
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="2d", auto_adjust=True)
            if hist.empty:
                print(f"  {ticker}: no data returned")
                continue
            row = hist.iloc[-1]
            prices[ticker] = {
                "open":   round(float(row["Open"]),   4),
                "close":  round(float(row["Close"]),  4),
                "high":   round(float(row["High"]),   4),
                "low":    round(float(row["Low"]),    4),
                "volume": int(row["Volume"]),
            }
            print(f"  {ticker}: open={prices[ticker]['open']} close={prices[ticker]['close']}")
        except Exception as exc:
            print(f"  {ticker}: ERROR - {exc}")
    return prices


# ── Prediction verification ───────────────────────────────────────────────────

def verify_predictions(db, prices, today_str):
    changed = False
    for pred in db.get("predictions", []):
        if pred.get("result") is not None:
            continue
        ticker = pred.get("ticker", "")
        if ticker not in prices:
            continue
        p = prices[ticker]
        pred_type = pred.get("prediction_type")
        direction = pred.get("direction")
        pred_date = pred.get("prediction_date", "")

        pred["actual_open"]  = p.get("open")
        pred["actual_close"] = p.get("close")

        if pred_type == "intraday":
            o, c = p.get("open"), p.get("close")
            if o is not None and c is not None:
                pred["result"]      = "correct" if (direction == "up") == (c > o) else "wrong"
                pred["verified_at"] = datetime.now(timezone.utc).isoformat()
                changed = True

        elif pred_type == "overnight":
            price_at_pred = pred.get("price_at_prediction")
            today_open    = p.get("open")
            if pred_date < today_str and price_at_pred and today_open is not None:
                pred["result"]      = "correct" if (direction == "up") == (today_open > price_at_pred) else "wrong"
                pred["verified_at"] = datetime.now(timezone.utc).isoformat()
                changed = True

    return changed


# ── Portfolio history (return index) ─────────────────────────────────────────

def fetch_historical_prices(symbols, start_date):
    """
    Returns {symbol: {date_str: close_price}} for all symbols from start_date onward.
    """
    hist_prices = {}
    for sym in sorted(symbols):
        try:
            ticker = yf.Ticker(sym)
            hist = ticker.history(start=start_date, auto_adjust=True)
            if not hist.empty:
                hist_prices[sym] = {
                    idx.strftime("%Y-%m-%d"): round(float(row["Close"]), 4)
                    for idx, row in hist.iterrows()
                }
                print(f"  {sym}: {len(hist_prices[sym])} days of history")
            else:
                print(f"  {sym}: no historical data")
            time.sleep(0.3)  # gentle rate-limit
        except Exception as exc:
            print(f"  {sym}: history ERROR - {exc}")
    return hist_prices


def compute_portfolio_history(db):
    """
    Time-Weighted Return per account.

    Key idea: on any day with buys/sells, compute the market return from
    EXISTING holdings BEFORE applying that day's transactions, then update
    the base value AFTER applying them.  This isolates pure market performance
    and eliminates the distortion caused by cash deposits or large trades.

    Returns {account_number: [{"date": ..., "index": ...}, ...]}
    """
    buy_sell = [
        t for t in db.get("transactions", [])
        if t.get("type") in ("buy", "sell") and t.get("date")
    ]
    if not buy_sell:
        return {}

    buy_sell.sort(key=lambda t: t["date"])
    first_date = buy_sell[0]["date"]

    # Collect symbols that were ever purchased
    symbols_ever = {
        (t.get("symbol") or "").strip()
        for t in buy_sell
        if t["type"] == "buy" and (t.get("symbol") or "").strip() not in SKIP_TICKERS
    } - SKIP_TICKERS
    symbols_ever.discard("")

    if not symbols_ever:
        return {}

    print(f"Fetching historical prices for {len(symbols_ever)} symbol(s) since {first_date}…")
    hist_prices = fetch_historical_prices(symbols_ever, first_date)

    if not hist_prices:
        return {}

    market_dates = sorted({d for dates in hist_prices.values() for d in dates})

    # Group transactions by (date, account) for O(1) lookup
    from collections import defaultdict
    tx_by_date_acct = defaultdict(lambda: defaultdict(list))
    for tx in buy_sell:
        tx_by_date_acct[tx["date"]][tx["account_number"]].append(tx)

    seen, accounts = set(), []
    for t in buy_sell:
        acct = t.get("account_number", "")
        if acct and acct not in seen:
            seen.add(acct); accounts.append(acct)

    result = {}

    def portfolio_value(holdings, date_str):
        total = 0.0
        for sym, qty in holdings.items():
            if qty > 0 and sym in hist_prices:
                price = hist_prices[sym].get(date_str)
                if price:
                    total += qty * price
        return total

    for acct in accounts:
        holdings       = {}    # end-of-day holdings, updated after transactions
        prev_after_val = None  # portfolio value at END of previous day (after that day's trades)
        cumulative     = 1.0
        points         = []

        for date_str in market_dates:
            # 1. Value holdings (carried from yesterday) at TODAY's prices — pure market move
            val_before = portfolio_value(holdings, date_str)

            # 2. Compute market return on existing positions (TWR sub-period)
            if prev_after_val is not None and prev_after_val > 0 and val_before > 0:
                daily_ret  = (val_before - prev_after_val) / prev_after_val
                cumulative = round(cumulative * (1 + daily_ret), 6)
                points.append({"date": date_str, "index": cumulative})

            # 3. Apply today's transactions (buys add to portfolio, sells remove)
            for tx in tx_by_date_acct.get(date_str, {}).get(acct, []):
                sym = (tx.get("symbol") or "").strip()
                qty = tx.get("quantity") or 0
                if sym and sym not in SKIP_TICKERS:
                    if tx["type"] == "buy":
                        holdings[sym] = holdings.get(sym, 0) + abs(qty)
                    elif tx["type"] == "sell":
                        holdings[sym] = max(0.0, holdings.get(sym, 0) - abs(qty))

            # 4. Value holdings AFTER transactions → becomes the base for tomorrow
            val_after = portfolio_value(holdings, date_str)

            if prev_after_val is None and val_after > 0:
                # First day we own anything: anchor the index at 1.0
                points.append({"date": date_str, "index": 1.0})
                prev_after_val = val_after
            elif val_after > 0:
                prev_after_val = val_after
            # If val_after == 0 (fully liquidated), keep prev_after_val so the
            # next purchase restarts the return from that prior base.

        if len(points) >= 2:
            result[acct] = points

    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print(f"=== fetch_prices.py {datetime.now(timezone.utc).isoformat()} ===")

    db      = load_json(DB_PATH)
    tickers = get_tickers(db)

    print(f"Fetching current prices for {len(tickers)} ticker(s): {', '.join(sorted(tickers)) or 'none'}")
    prices    = fetch_prices(tickers)
    today_str = date.today().isoformat()

    prices_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "date":       today_str,
        "prices":     prices,
    }
    save_json(PRICES_PATH, prices_data)
    print(f"Wrote {PRICES_PATH}")

    pred_changed = verify_predictions(db, prices, today_str)
    if pred_changed:
        save_json(DB_PATH, db)
        print(f"Updated {DB_PATH} with verified predictions")
    else:
        print("No predictions to update.")

    print("\nComputing portfolio return history…")
    series = compute_portfolio_history(db)
    if series:
        chart_data = {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "series":     series,
        }
        save_json(CHART_PATH, chart_data)
        print(f"Wrote {CHART_PATH} ({sum(len(v) for v in series.values())} data points)")
    else:
        print("No chart data to write (no buy/sell transactions with fetchable prices).")


if __name__ == "__main__":
    main()

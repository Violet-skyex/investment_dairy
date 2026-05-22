#!/usr/bin/env python3
"""
Fetch market prices for all tracked tickers and auto-verify open predictions.
Called by GitHub Actions at 9:35 AM ET and 4:05 PM ET on weekdays.
"""
import json
import sys
from datetime import datetime, date, timezone

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

DB_PATH = "data/db.json"
PRICES_PATH = "data/prices.json"

SKIP_TICKERS = {"84679P306", "SPAXX", "SPAXX**", ""}


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def get_tickers(db):
    tickers = set()

    # Tickers with open (unverified) predictions
    for pred in db.get("predictions", []):
        if pred.get("result") is None:
            t = pred.get("ticker", "").strip()
            if t:
                tickers.add(t)

    # All tickers in the latest position snapshot
    snapshots = db.get("position_snapshots", [])
    if snapshots:
        valid_dates = [s["date"] for s in snapshots if s.get("date")]
        if valid_dates:
            latest_date = max(valid_dates)
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
                "open": round(float(row["Open"]), 4),
                "close": round(float(row["Close"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "volume": int(row["Volume"]),
            }
            print(f"  {ticker}: open={prices[ticker]['open']} close={prices[ticker]['close']}")
        except Exception as exc:
            print(f"  {ticker}: ERROR - {exc}")
    return prices


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

        pred["actual_open"] = p.get("open")
        pred["actual_close"] = p.get("close")

        if pred_type == "intraday":
            # Correct if close vs open matches predicted direction
            o, c = p.get("open"), p.get("close")
            if o is not None and c is not None:
                actual_up = c > o
                pred["result"] = "correct" if (direction == "up") == actual_up else "wrong"
                pred["verified_at"] = datetime.now(timezone.utc).isoformat()
                changed = True

        elif pred_type == "overnight":
            # Predict today's close → tomorrow's open
            # Verifiable when prediction_date < today and we have today's open
            price_at_pred = pred.get("price_at_prediction")
            today_open = p.get("open")
            if pred_date < today_str and price_at_pred and today_open is not None:
                actual_up = today_open > price_at_pred
                pred["result"] = "correct" if (direction == "up") == actual_up else "wrong"
                pred["verified_at"] = datetime.now(timezone.utc).isoformat()
                changed = True

    return changed


def main():
    print(f"=== fetch_prices.py {datetime.now(timezone.utc).isoformat()} ===")

    db = load_json(DB_PATH)
    tickers = get_tickers(db)

    if not tickers:
        print("No tickers to fetch.")
    else:
        print(f"Fetching {len(tickers)} ticker(s): {', '.join(sorted(tickers))}")

    prices = fetch_prices(tickers)
    today_str = date.today().isoformat()

    prices_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "date": today_str,
        "prices": prices,
    }
    save_json(PRICES_PATH, prices_data)
    print(f"Wrote {PRICES_PATH}")

    changed = verify_predictions(db, prices, today_str)
    if changed:
        save_json(DB_PATH, db)
        print(f"Updated {DB_PATH} with verified predictions")
    else:
        print("No predictions to update.")


if __name__ == "__main__":
    main()

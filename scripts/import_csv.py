#!/usr/bin/env python3
"""
Import Fidelity CSV exports into data/db.json locally.

Usage:
  python scripts/import_csv.py <file1.csv> [file2.csv ...]

  Both Portfolio Positions and Accounts History CSVs can be passed
  in any order — the script auto-detects which is which.

After running, commit and push:
  git add data/db.json && git commit -m "data: import CSV" && git push
"""

import csv
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path

DB_PATH = Path("data/db.json")

SKIP_SYMBOLS = {"SPAXX**", "SPAXX", "Pending activity", "Pending Activity", ""}

ACCOUNTS = {
    "Z39427432": "Individual",
    "263684031": "ROTH IRA",
    "74509": "401(k)",
}

MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}


# ── Utilities ────────────────────────────────────────────────

def load_db() -> dict:
    if DB_PATH.exists():
        return json.loads(DB_PATH.read_text(encoding="utf-8"))
    return {"position_snapshots": [], "transactions": [], "seen_tx_hashes": [], "predictions": [], "notes": {}}


def save_db(db: dict):
    DB_PATH.write_text(json.dumps(db, indent=2) + "\n", encoding="utf-8")


def parse_numeric(s: str):
    if not s:
        return None
    cleaned = re.sub(r"[$+%,\s]", "", str(s)).strip()
    if cleaned in ("", "--", "N/A"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def fidelity_date(s: str):
    """'May-21-2026' or 'May 21, 2026' → '2026-05-21'"""
    s = s.strip()
    m = re.match(r"^([A-Za-z]+)-(\d+)-(\d{4})$", s)
    if m:
        mo = MONTH_MAP.get(m.group(1)[:3])
        return f"{m.group(3)}-{mo:02d}-{int(m.group(2)):02d}" if mo else None
    m = re.match(r"^([A-Za-z]+)\s+(\d+),\s*(\d{4})$", s)
    if m:
        mo = MONTH_MAP.get(m.group(1)[:3])
        return f"{m.group(3)}-{mo:02d}-{int(m.group(2)):02d}" if mo else None
    return None


def run_date(s: str):
    """'05/21/2026' → '2026-05-21'"""
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", s.strip())
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else None


def is_valid_account(s: str) -> bool:
    return bool(re.match(r"^[A-Z]\d+$", s) or re.match(r"^\d+$", s))


def classify_tx(action: str) -> str:
    a = action.upper()
    if "YOU BOUGHT" in a:   return "buy"
    if "YOU SOLD" in a:     return "sell"
    if "DIRECT DEPOSIT" in a or " ACH " in a or "TRANSFER" in a: return "deposit"
    if "DIVIDEND" in a or "REINVESTMENT" in a: return "dividend"
    return "other"


def hash_row(run_date_val, acct, action, symbol, qty, amount) -> str:
    key = "|".join([
        run_date_val.strip(), acct.strip(), action.strip(),
        symbol.strip(), str(qty).strip(), str(amount).strip(),
    ])
    return hashlib.md5(key.encode()).hexdigest()[:16]


def get_avg_cost(db: dict, symbol: str, account_number: str):
    snaps = [
        s for s in db["position_snapshots"]
        if s["symbol"] == symbol
        and s["account_number"] == account_number
        and s.get("average_cost_basis") is not None
    ]
    if not snaps:
        return None
    return sorted(snaps, key=lambda s: s["date"] or "", reverse=True)[0]["average_cost_basis"]


# ── CSV detection ────────────────────────────────────────────

def detect_type(text: str) -> str:
    head = text[:800]
    if "Run Date" in head and "Action" in head:
        return "history"
    if "Account Name" in head and "Last Price" in head:
        return "positions"
    return "unknown"


# ── Positions parser ─────────────────────────────────────────

def parse_positions(text: str, db: dict) -> tuple[int, str | None]:
    # Snapshot date from Fidelity footer
    m = re.search(r"Date downloaded\s+([A-Za-z]+-\d+-\d{4})", text, re.IGNORECASE)
    snapshot_date = fidelity_date(m.group(1)) if m else None

    reader = csv.DictReader(StringIO(text))
    # Normalize headers (strip BOM and whitespace)
    reader.fieldnames = [f.lstrip("﻿").strip() for f in (reader.fieldnames or [])]

    existing_keys = {
        f"{s['date']}|{s['account_number']}|{s['symbol']}"
        for s in db["position_snapshots"]
    }

    added = 0
    for row in reader:
        acct_num = (row.get("Account Number") or "").strip()
        symbol = (row.get("Symbol") or "").strip()

        if not is_valid_account(acct_num):
            continue
        if symbol in SKIP_SYMBOLS:
            continue
        cv = parse_numeric(row.get("Current Value"))
        if cv is None:
            continue

        key = f"{snapshot_date}|{acct_num}|{symbol}"
        if key in existing_keys:
            continue

        db["position_snapshots"].append({
            "date": snapshot_date,
            "account_number": acct_num,
            "account_name": (row.get("Account Name") or ACCOUNTS.get(acct_num, acct_num)).strip(),
            "symbol": symbol,
            "description": (row.get("Description") or "").strip(),
            "quantity": parse_numeric(row.get("Quantity")),
            "last_price": parse_numeric(row.get("Last Price")),
            "current_value": cv,
            "todays_gain_loss_dollar": parse_numeric(row.get("Today's Gain/Loss Dollar")),
            "todays_gain_loss_pct": parse_numeric(row.get("Today's Gain/Loss Percent")),
            "total_gain_loss_dollar": parse_numeric(row.get("Total Gain/Loss Dollar")),
            "total_gain_loss_pct": parse_numeric(row.get("Total Gain/Loss Percent")),
            "cost_basis_total": parse_numeric(row.get("Cost Basis Total")),
            "average_cost_basis": parse_numeric(row.get("Average Cost Basis")),
        })
        existing_keys.add(key)
        added += 1

    return added, snapshot_date


# ── History parser ───────────────────────────────────────────

def parse_history(text: str, db: dict) -> tuple[int, int]:
    reader = csv.DictReader(StringIO(text))
    reader.fieldnames = [f.lstrip("﻿").strip() for f in (reader.fieldnames or [])]

    seen = set(db.get("seen_tx_hashes", []))
    added = dupes = 0

    for row in reader:
        rd = run_date(row.get("Run Date") or "")
        if not rd:
            continue
        acct_num = (row.get("Account Number") or "").strip()
        if not acct_num:
            continue

        action = (row.get("Action") or "").strip()
        symbol = (row.get("Symbol") or "").strip()
        qty_raw = row.get("Quantity") or ""
        amt_raw = row.get("Amount ($)") or ""

        h = hash_row(row.get("Run Date",""), acct_num, action, symbol, qty_raw, amt_raw)
        if h in seen:
            dupes += 1
            continue

        qty = parse_numeric(qty_raw)
        amount = parse_numeric(amt_raw)
        tx_type = classify_tx(action)

        realized_pnl = None
        if tx_type == "sell" and symbol and qty is not None and amount is not None:
            avg = get_avg_cost(db, symbol, acct_num)
            if avg is not None:
                realized_pnl = round(amount - avg * abs(qty), 4)

        db["transactions"].append({
            "hash": h,
            "date": rd,
            "account_number": acct_num,
            "account_name": (row.get("Account") or ACCOUNTS.get(acct_num, acct_num)).strip(),
            "action_raw": action,
            "type": tx_type,
            "symbol": symbol,
            "description": (row.get("Description") or "").strip(),
            "price": parse_numeric(row.get("Price ($)")),
            "quantity": qty,
            "commission": parse_numeric(row.get("Commission ($)")),
            "fees": parse_numeric(row.get("Fees ($)")),
            "amount": amount,
            "settlement_date": (row.get("Settlement Date") or "").strip(),
            "realized_pnl": realized_pnl,
        })
        seen.add(h)
        added += 1

    db["seen_tx_hashes"] = list(seen)
    return added, dupes


# ── Main ─────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    db = load_db()
    summary = []

    for path_str in sys.argv[1:]:
        path = Path(path_str)
        if not path.exists():
            print(f"File not found: {path}")
            continue

        # Fidelity CSVs are UTF-8 with BOM
        text = path.read_text(encoding="utf-8-sig")
        csv_type = detect_type(text)

        if csv_type == "positions":
            added, snap_date = parse_positions(text, db)
            summary.append(f"  Positions: {added} rows added (snapshot: {snap_date or 'unknown date'})")

        elif csv_type == "history":
            added, dupes = parse_history(text, db)
            by_type: dict = {}
            for tx in db["transactions"][-added:] if added else []:
                by_type[tx["type"]] = by_type.get(tx["type"], 0) + 1
            breakdown = ", ".join(f"{v} {k}" for k, v in sorted(by_type.items()))
            summary.append(f"  History:   {added} new transactions ({breakdown}), {dupes} duplicates skipped")

        else:
            summary.append(f"  {path.name}: unrecognized format, skipped")

    save_db(db)
    print("Imported:")
    for line in summary:
        print(line)
    print(f"\ndb.json updated → {len(db['position_snapshots'])} position rows, {len(db['transactions'])} transactions total")
    print("\nNext: git add data/db.json && git commit -m 'data: import CSV' && git push")


if __name__ == "__main__":
    main()

import json
import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "money.db"
OUTPUT_PATH = BASE_DIR / "money-tracker-device-backup.json"


def setting(db, key, fallback="0"):
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else fallback


def export_backup():
    if not DB_PATH.exists():
        raise FileNotFoundError("money.db was not found beside this script.")
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(row) for row in db.execute("SELECT * FROM entries ORDER BY id")]
        goals = [dict(row) for row in db.execute("SELECT * FROM goals ORDER BY id")]
        categories = [row[0] for row in db.execute("SELECT name FROM categories ORDER BY id")]
        people = [row[0] for row in db.execute("SELECT name FROM people ORDER BY id")]
        rules = [dict(row) for row in db.execute("SELECT rule_text,person,category FROM import_rules")]
        settings = {
            "setup_done": setting(db, "setup_done") == "1",
            "savings_pct": int(float(setting(db, "savings_pct", "20"))),
            "dark_mode": setting(db, "dark_mode", "system"),
            "opening": {key: int(setting(db, f"opening_{key}")) for key in ("bank", "cash", "waiting", "savings")},
            "opening_owed": int(setting(db, "opening_owed")),
        }
        try:
            settings["csv_mapping"] = json.loads(setting(db, "csv_mapping", "{}"))
        except json.JSONDecodeError:
            settings["csv_mapping"] = {}
    finally:
        db.close()

    state = {
        "settings": settings,
        "people": people,
        "categories": categories,
        "goals": goals,
        "entries": rows,
        "rules": rules,
        "nextId": max((row["id"] for row in rows), default=0) + 1,
        "nextGoalId": max((goal["id"] for goal in goals), default=0) + 1,
    }
    OUTPUT_PATH.write_text(json.dumps({"format": "money-tracker-device-backup-v1", "state": state}, indent=2), encoding="utf-8")
    print(f"Exported {len(rows)} entries to {OUTPUT_PATH.name}")


if __name__ == "__main__":
    export_backup()
import csv
import io
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from flask import Flask, jsonify, make_response, render_template, request, send_file


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "money.db")
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024

DEFAULT_CATEGORIES = ["Food", "Transport", "Rent", "Airtime and data", "Electricity", "Clothing", "Family", "Bank and ATM fees", "Other"]
OPENING_KEYS = {"bank": "opening_bank", "cash": "opening_cash", "waiting": "opening_waiting", "savings": "opening_savings"}


@contextmanager
def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL);
        CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE NOT NULL);
        CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, target INTEGER NOT NULL, target_date TEXT, finished INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS import_rules (rule_text TEXT PRIMARY KEY COLLATE NOCASE, person TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY, entry_type TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0),
            entry_date TEXT NOT NULL, person TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
            arrival TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', pocket TEXT NOT NULL DEFAULT '',
            linked_id INTEGER, import_id TEXT NOT NULL DEFAULT '', goal_id INTEGER,
            status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(linked_id) REFERENCES entries(id) ON DELETE CASCADE,
            FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS entries_date_idx ON entries(entry_date);
        CREATE INDEX IF NOT EXISTS entries_import_idx ON entries(import_id);
        """)
        defaults = {"savings_pct": "20", "dark_mode": "system", "setup_done": "0", "opening_bank": "0", "opening_cash": "0", "opening_waiting": "0", "opening_savings": "0", "opening_owed": "0", "csv_mapping": "{}"}
        db.executemany("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", defaults.items())
        db.executemany("INSERT OR IGNORE INTO categories(name) VALUES(?)", [(name,) for name in DEFAULT_CATEGORIES])


def setting(db, key, default=""):
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def save_settings(db, values):
    db.executemany("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", values.items())


def amount_cents(value):
    try:
        amount = Decimal(str(value).replace("R", "").replace(" ", "").replace(",", ".").strip())
        if not amount.is_finite() or amount < 0:
            raise ValueError("Amount must be zero or more.")
        return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError):
        raise ValueError("Enter a valid amount.")


def valid_date(value, allow_old=True):
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError("Choose a valid date.")
    if parsed > date.today() + timedelta(days=1):
        raise ValueError("The date cannot be more than one day in the future.")
    return parsed.isoformat()


def insert_entry(db, entry_type, amount, entry_date, **fields):
    cols = ["entry_type", "amount", "entry_date"]
    vals = [entry_type, amount, entry_date]
    for col in ("person", "category", "arrival", "note", "pocket", "linked_id", "import_id", "goal_id", "status"):
        if col in fields:
            cols.append(col)
            vals.append(fields[col])
    cur = db.execute(f"INSERT INTO entries({','.join(cols)}) VALUES({','.join('?' for _ in vals)})", vals)
    return cur.lastrowid


def balances(db):
    result = {key: int(setting(db, config, "0")) for key, config in OPENING_KEYS.items()}
    owed = int(setting(db, "opening_owed", "0"))
    for row in db.execute("SELECT * FROM entries"):
        amount = row["amount"]
        kind = row["entry_type"]
        if kind == "INCOME":
            pocket = {"bank": "bank", "cash": "cash", "cashsend": "waiting"}.get(row["arrival"])
            if pocket:
                result[pocket] += amount
        elif kind == "EXPENSE":
            if row["pocket"] in ("bank", "cash"):
                result[row["pocket"]] -= amount
        elif kind == "WITHDRAWAL":
            result["waiting"] -= amount
            result["cash"] += amount - int(row["category"] or 0)
        elif kind == "BANK_CASH":
            result["bank"] -= amount
            result["cash"] += amount
        elif kind == "SAVE":
            result[row["pocket"]] -= amount
            result["savings"] += amount
        elif kind == "OWED":
            owed += amount
        elif kind == "OWED_CLEAR":
            owed -= amount
    result["owed"] = owed
    return result


def add_income(db, data, import_id=""):
    cents = amount_cents(data.get("amount"))
    entry_date = valid_date(data.get("date", date.today().isoformat()))
    arrival = data.get("arrival", "bank")
    if arrival not in ("bank", "cash", "cashsend"):
        raise ValueError("Choose how the money arrived.")
    person = str(data.get("person", "")).strip()
    if not person:
        raise ValueError("Enter who paid you.")
    cur = db.execute("INSERT OR IGNORE INTO people(name) VALUES(?)", (person,))
    entry_id = insert_entry(db, "INCOME", cents, entry_date, arrival=arrival, person=person, note=str(data.get("note", "")).strip(), import_id=import_id)
    return entry_id, cents


def period_bounds(period, anchor):
    if period == "week":
        start = anchor - timedelta(days=anchor.weekday())
        return start, start + timedelta(days=6)
    if period == "year":
        return date(anchor.year, 1, 1), date(anchor.year, 12, 31)
    return date(anchor.year, anchor.month, 1), date(anchor.year + (anchor.month == 12), anchor.month % 12 + 1, 1) - timedelta(days=1)


def period_entries(db, start, end):
    return db.execute("SELECT * FROM entries WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date, id", (start.isoformat(), end.isoformat())).fetchall()


def report_data(db, period, anchor):
    start, end = period_bounds(period, anchor)
    rows = period_entries(db, start, end)
    income = sum(r["amount"] for r in rows if r["entry_type"] == "INCOME")
    expenses = sum(r["amount"] for r in rows if r["entry_type"] == "EXPENSE")
    saved = sum(r["amount"] for r in rows if r["entry_type"] == "SAVE")
    people, arrivals, categories = {}, {}, {}
    for r in rows:
        if r["entry_type"] == "INCOME":
            people[r["person"]] = people.get(r["person"], 0) + r["amount"]
            arrivals[r["arrival"]] = arrivals.get(r["arrival"], 0) + r["amount"]
        elif r["entry_type"] == "EXPENSE":
            categories[r["category"]] = categories.get(r["category"], 0) + r["amount"]
    result = {"period": period, "start": start.isoformat(), "end": end.isoformat(), "in": income, "out": expenses, "saved": saved, "left": income - expenses - saved,
              "people": people, "arrivals": arrivals, "categories": categories}
    if period == "year":
        months = []
        for month in range(1, 13):
            mstart = date(anchor.year, month, 1)
            mend = date(anchor.year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
            mrows = period_entries(db, mstart, mend)
            months.append({"month": mstart.strftime("%b"), "in": sum(r["amount"] for r in mrows if r["entry_type"] == "INCOME"), "out": sum(r["amount"] for r in mrows if r["entry_type"] == "EXPENSE"), "saved": sum(r["amount"] for r in mrows if r["entry_type"] == "SAVE")})
        result["months"] = months
        result["save_rate"] = round(saved * 100 / income, 1) if income else 0
    return result


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/service-worker.js")
def service_worker():
    response = send_file(os.path.join(BASE_DIR, "static", "service-worker.js"), mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/initialize")
def initialize():
    with connect() as db:
        b = balances(db)
        entries = [dict(row) for row in db.execute("SELECT * FROM entries ORDER BY entry_date DESC, id DESC LIMIT 8")]
        goals = [dict(row) for row in db.execute("SELECT * FROM goals ORDER BY id DESC")]
        waiting = []
        for row in db.execute("SELECT * FROM entries WHERE entry_type='INCOME' AND arrival='cashsend' AND NOT EXISTS (SELECT 1 FROM entries w WHERE w.entry_type='WITHDRAWAL' AND w.linked_id=entries.id) ORDER BY entry_date"):
            item = dict(row)
            moved = db.execute("SELECT COALESCE(SUM(amount),0) FROM entries WHERE entry_type='SAVE' AND linked_id=?", (row["id"],)).fetchone()[0]
            item["remaining"] = max(0, row["amount"] - moved)
            waiting.append(item)
        return jsonify({"setup_done": setting(db, "setup_done") == "1", "balances": b, "savings_pct": int(setting(db, "savings_pct", "20")), "dark_mode": setting(db, "dark_mode", "system"), "people": [r[0] for r in db.execute("SELECT name FROM people ORDER BY name")], "categories": [r[0] for r in db.execute("SELECT name FROM categories ORDER BY name")], "entries": entries, "goals": goals, "waiting": waiting})


@app.post("/api/setup")
def setup():
    data = request.get_json(force=True)
    values = {"setup_done": "1"}
    try:
        for key in OPENING_KEYS:
            values[OPENING_KEYS[key]] = str(amount_cents(data.get(key, 0)))
        with connect() as db:
            save_settings(db, values)
        return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/income")
def income():
    data = request.get_json(force=True)
    try:
        with connect() as db:
            entry_id, cents = add_income(db, data)
            pct = Decimal(setting(db, "savings_pct", "20"))
            reminder = int((Decimal(cents) * pct / 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            return jsonify(id=entry_id, amount=cents, suggested=reminder, person=data.get("person"), arrival=data.get("arrival"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/reminder")
def reminder():
    data = request.get_json(force=True)
    try:
        action = data.get("action")
        with connect() as db:
            parent = db.execute("SELECT * FROM entries WHERE id=? AND entry_type='INCOME'", (data.get("income_id"),)).fetchone()
            if not parent:
                raise ValueError("That income entry could not be found.")
            amount = amount_cents(data.get("amount", 0))
            if action == "done":
                pocket = {"bank": "bank", "cash": "cash", "cashsend": "waiting"}[parent["arrival"]]
                if amount > balances(db)[pocket]:
                    raise ValueError("There is not enough money in that pocket to move this amount.")
                insert_entry(db, "SAVE", amount, parent["entry_date"], pocket=pocket, note="Savings from income", linked_id=parent["id"], import_id=parent["import_id"])
            elif action == "later":
                insert_entry(db, "OWED", amount, parent["entry_date"], linked_id=parent["id"], import_id=parent["import_id"])
            elif action != "skip":
                raise ValueError("Choose Done, Later, or Skip.")
            return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/withdraw")
def withdraw():
    data = request.get_json(force=True)
    try:
        fee = amount_cents(data.get("fee", 0))
        withdraw_date = valid_date(data.get("date", date.today().isoformat()))
        with connect() as db:
            parent = db.execute("SELECT * FROM entries WHERE id=? AND entry_type='INCOME'", (data.get("income_id"),)).fetchone()
            if not parent or parent["arrival"] != "cashsend":
                raise ValueError("Cash send not found.")
            if db.execute("SELECT 1 FROM entries WHERE entry_type='WITHDRAWAL' AND linked_id=?", (parent["id"],)).fetchone():
                raise ValueError("This cash send is already withdrawn.")
            already_saved = db.execute("SELECT COALESCE(SUM(amount),0) FROM entries WHERE entry_type='SAVE' AND linked_id=?", (parent["id"],)).fetchone()[0]
            amount_to_withdraw = max(0, parent["amount"] - already_saved)
            withdrawal_id = insert_entry(db, "WITHDRAWAL", amount_to_withdraw, withdraw_date, category=str(fee), linked_id=parent["id"], note="Cash send withdrawal")
            if fee:
                insert_entry(db, "EXPENSE", fee, withdraw_date, category="Bank and ATM fees", pocket="memo", note="ATM fee", linked_id=withdrawal_id)
            return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/expense")
def expense():
    data = request.get_json(force=True)
    try:
        cents = amount_cents(data.get("amount"))
        entry_date = valid_date(data.get("date", date.today().isoformat()))
        pocket = data.get("pocket", "bank")
        if pocket not in ("bank", "cash"):
            raise ValueError("Choose Bank or Cash in hand.")
        category = str(data.get("category", "Other")).strip()
        with connect() as db:
            insert_entry(db, "EXPENSE", cents, entry_date, category=category, pocket=pocket, note=str(data.get("note", "")).strip())
            return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.route("/api/settings", methods=["GET", "POST"])
def settings_api():
    with connect() as db:
        if request.method == "GET":
            return jsonify({"savings_pct": setting(db, "savings_pct", "20"), "dark_mode": setting(db, "dark_mode", "system"), "opening": {k: setting(db, v, "0") for k, v in OPENING_KEYS.items()}, "owed": setting(db, "opening_owed", "0")})
        data = request.get_json(force=True)
        try:
            pct = Decimal(str(data.get("savings_pct", 20)))
            if pct < 0 or pct > 100:
                raise ValueError("Savings percentage must be between 0 and 100.")
            if pct != pct.to_integral_value():
                raise ValueError("Savings percentage must be a whole number.")
            updates = {"savings_pct": str(pct), "dark_mode": data.get("dark_mode", "system")}
            if updates["dark_mode"] not in ("system", "light", "dark"):
                updates["dark_mode"] = "system"
            if data.get("opening"):
                for key, config in OPENING_KEYS.items():
                    updates[config] = str(amount_cents(data["opening"].get(key, 0)))
            save_settings(db, updates)
            return jsonify(ok=True)
        except (ValueError, InvalidOperation) as exc:
            return jsonify(error=str(exc)), 400


@app.post("/api/list")
def edit_list():
    data = request.get_json(force=True)
    kind, action = data.get("kind"), data.get("action")
    table = "people" if kind == "people" else "categories" if kind == "categories" else ""
    if not table:
        return jsonify(error="Unknown list."), 400
    with connect() as db:
        try:
            if action == "add":
                name = str(data.get("name", "")).strip()
                if not name:
                    raise ValueError("A name is required.")
                db.execute(f"INSERT INTO {table}(name) VALUES(?)", (name,))
            elif action == "rename":
                db.execute(f"UPDATE {table} SET name=? WHERE name=?", (str(data["new_name"]).strip(), data["name"]))
                field = "person" if kind == "people" else "category"
                db.execute(f"UPDATE entries SET {field}=? WHERE {field}=?", (str(data["new_name"]).strip(), data["name"]))
                if kind == "people":
                    db.execute("UPDATE import_rules SET person=? WHERE person=?", (str(data["new_name"]).strip(), data["name"]))
                else:
                    db.execute("UPDATE import_rules SET category=? WHERE category=?", (str(data["new_name"]).strip(), data["name"]))
            elif action == "remove":
                db.execute(f"DELETE FROM {table} WHERE name=?", (data["name"],))
            return jsonify(ok=True)
        except sqlite3.IntegrityError:
            return jsonify(error="That name is already on the list."), 400
        except (ValueError, KeyError) as exc:
            return jsonify(error=str(exc)), 400


@app.route("/api/history", methods=["GET"])
def history():
    with connect() as db:
        query = "SELECT * FROM entries WHERE 1=1"
        args = []
        for key, col in (("type", "entry_type"), ("person", "person"), ("category", "category")):
            if request.args.get(key):
                query += f" AND {col}=?"
                args.append(request.args[key])
        if request.args.get("from"):
            query += " AND entry_date>=?"
            args.append(request.args["from"])
        if request.args.get("to"):
            query += " AND entry_date<=?"
            args.append(request.args["to"])
        rows = db.execute(query + " ORDER BY entry_date DESC,id DESC LIMIT 500", args)
        imports = db.execute("SELECT import_id FROM entries WHERE import_id!='' GROUP BY import_id ORDER BY MAX(id) DESC")
        return jsonify(entries=[dict(r) for r in rows], imports=[r[0] for r in imports])


@app.route("/api/entries/<int:entry_id>", methods=["PUT", "DELETE"])
def entry_detail(entry_id):
    with connect() as db:
        row = db.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
        if not row:
            return jsonify(error="Entry not found."), 404
        if request.method == "DELETE":
            db.execute("DELETE FROM entries WHERE id=? OR linked_id=?", (entry_id, entry_id))
            return jsonify(ok=True)
        data = request.get_json(force=True)
        try:
            amount = amount_cents(data.get("amount"))
            entry_date = valid_date(data.get("date"))
            db.execute("UPDATE entries SET amount=?,entry_date=?,person=?,category=?,note=?,pocket=? WHERE id=?", (amount, entry_date, data.get("person", row["person"]), data.get("category", row["category"]), data.get("note", row["note"]), data.get("pocket", row["pocket"]), entry_id))
            return jsonify(ok=True)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400


@app.post("/api/import/undo")
def undo_import():
    import_id = request.get_json(force=True).get("import_id", "")
    with connect() as db:
        db.execute("DELETE FROM entries WHERE import_id=?", (import_id,))
    return jsonify(ok=True)


@app.post("/api/owed/clear")
def clear_owed():
    try:
        data = request.get_json(force=True)
        cents = amount_cents(data.get("amount"))
        pocket = data.get("pocket", "bank")
        if pocket not in ("bank", "cash"):
            raise ValueError("Choose Bank or Cash in hand.")
        with connect() as db:
            current = balances(db)
            if cents > current["owed"]:
                raise ValueError("That amount is more than the savings still owed.")
            if cents > current[pocket]:
                raise ValueError("There is not enough money in that pocket.")
            insert_entry(db, "SAVE", cents, date.today().isoformat(), pocket=pocket, note="Savings owed paid")
            insert_entry(db, "OWED_CLEAR", cents, date.today().isoformat(), note="Savings owed cleared")
        return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.post("/api/import/reminder")
def import_reminder():
    data = request.get_json(force=True)
    try:
        action = data.get("action")
        cents = amount_cents(data.get("amount", 0))
        import_id = str(data.get("import_id", ""))
        with connect() as db:
            if not import_id or not db.execute("SELECT 1 FROM entries WHERE import_id=? AND entry_type='INCOME'", (import_id,)).fetchone():
                raise ValueError("That import could not be found.")
            if action == "done":
                if cents > balances(db)["bank"]:
                    raise ValueError("There is not enough in Bank to move this amount.")
                insert_entry(db, "SAVE", cents, date.today().isoformat(), pocket="bank", note="Savings from bank import", import_id=import_id)
            elif action == "later":
                insert_entry(db, "OWED", cents, date.today().isoformat(), note="Savings from bank import", import_id=import_id)
            elif action != "skip":
                raise ValueError("Choose Done, Later, or Skip.")
        return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.route("/api/goals", methods=["GET", "POST"])
def goals_api():
    with connect() as db:
        if request.method == "GET":
            goals = []
            for g in db.execute("SELECT * FROM goals ORDER BY id DESC"):
                saved = db.execute("SELECT COALESCE(SUM(amount),0) FROM entries WHERE entry_type='GOAL' AND goal_id=?", (g["id"],)).fetchone()[0]
                item = dict(g)
                item["saved"] = saved
                item["finished"] = int(saved >= g["target"])
                goals.append(item)
            return jsonify(goals=goals)
        data = request.get_json(force=True)
        try:
            name = str(data.get("name", "")).strip()
            target = amount_cents(data.get("target"))
            if not name or not target:
                raise ValueError("Enter a name and a target above zero.")
            target_date = data.get("target_date") or None
            if target_date:
                target_date = valid_date(target_date)
            cur = db.execute("INSERT INTO goals(name,target,target_date) VALUES(?,?,?)", (name, target, target_date))
            return jsonify(id=cur.lastrowid)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400


@app.post("/api/goals/<int:goal_id>/add")
def goal_add(goal_id):
    data = request.get_json(force=True)
    try:
        cents = amount_cents(data.get("amount"))
        with connect() as db:
            goal = db.execute("SELECT * FROM goals WHERE id=?", (goal_id,)).fetchone()
            if not goal:
                raise ValueError("Goal not found.")
            allocated = db.execute("SELECT COALESCE(SUM(amount),0) FROM entries WHERE entry_type='GOAL'").fetchone()[0]
            if cents > balances(db)["savings"] - allocated:
                raise ValueError("There is not enough in Savings.")
            insert_entry(db, "GOAL", cents, date.today().isoformat(), goal_id=goal_id, note="Added to goal")
            saved = db.execute("SELECT SUM(amount) FROM entries WHERE entry_type='GOAL' AND goal_id=?", (goal_id,)).fetchone()[0]
            if saved >= goal["target"]:
                db.execute("UPDATE goals SET finished=1 WHERE id=?", (goal_id,))
            return jsonify(ok=True)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@app.get("/api/reports")
def reports():
    period = request.args.get("period", "month")
    if period not in ("week", "month", "year"):
        period = "month"
    try:
        anchor = date.fromisoformat(request.args.get("date", date.today().isoformat()))
    except ValueError:
        anchor = date.today()
    with connect() as db:
        return jsonify(report_data(db, period, anchor))


@app.get("/api/export.csv")
def export_csv():
    period = request.args.get("period", "month")
    try:
        anchor = date.fromisoformat(request.args.get("date", date.today().isoformat()))
    except ValueError:
        anchor = date.today()
    start, end = period_bounds(period, anchor)
    with connect() as db:
        rows = period_entries(db, start, end)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Date", "Type", "Amount (R)", "Person", "Category", "Arrival", "Pocket", "Note"])
    for row in rows:
        writer.writerow([row["entry_date"], row["entry_type"], f"{row['amount'] / 100:.2f}", row["person"], row["category"], row["arrival"], row["pocket"], row["note"]])
    response = make_response("\ufeff" + out.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = "attachment; filename=money-tracker.csv"
    return response


@app.get("/api/backup")
def backup():
    return send_file(DB_PATH, as_attachment=True, download_name="money.db")


def parse_csv_amount(raw):
    text = str(raw).strip().replace("R", "").replace(" ", "")
    negative = text.startswith("-") or text.lower().endswith("dr")
    text = text.replace("Dr", "").replace("dr", "").replace("Cr", "").replace("cr", "").replace("+", "").replace("-", "")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        amount = amount_cents(text)
    except ValueError:
        return 0
    return -amount if negative else amount


def parse_csv_date(raw):
    value = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d %b %Y", "%d %B %Y", "%d-%m-%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    return ""


@app.post("/api/import/preview")
def import_preview():
    file = request.files.get("file")
    if not file:
        return jsonify(error="Choose a CSV file first."), 400
    try:
        text = file.read().decode("utf-8-sig")
        lines = text.splitlines()
        header_idx = 0
        best_score = 0
        for i, line in enumerate(lines[:20]):
            low = line.lower()
            score = sum(bool(any(word in low for word in group)) for group in (("date",), ("description", "details", "narration", "reference"), ("amount", "value", "debit", "credit", "withdrawal", "deposit", "money in", "money out")))
            if score > best_score:
                header_idx, best_score = i, score
        if best_score < 2:
            raise ValueError("Header row not found.")
        sample = "\n".join(lines[header_idx:header_idx + 5])
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        records = list(csv.reader(io.StringIO(text), dialect))[header_idx:]
        headers = [str(h).strip() for h in records.pop(0)]
        if len(headers) < 2:
            raise ValueError("The CSV needs a header row and at least one data column.")
        lowered = [h.lower() for h in headers]
        def guess(keys):
            return next((i for i, h in enumerate(lowered) if any(k in h for k in keys)), -1)
        mapping = {"date": guess(["date"]), "description": guess(["description", "details", "narration", "reference", "payee"]), "amount": guess(["amount", "value"]), "debit": guess(["debit", "withdrawal", "money out"]), "credit": guess(["credit", "deposit", "money in"])}
        with connect() as db:
            stored = json.loads(setting(db, "csv_mapping", "{}"))
        if stored.get("headers") == headers:
            mapping.update(stored.get("mapping", {}))
        return jsonify(headers=headers, mapping=mapping, rows=records, sample=records[:5])
    except (UnicodeDecodeError, csv.Error, ValueError, IndexError) as exc:
        return jsonify(error="I couldn't read that CSV. Check that it is a valid CSV file and try again."), 400


@app.post("/api/import/check")
def import_check():
    data = request.get_json(force=True)
    mapping, rows = data.get("mapping", {}), data.get("rows", [])
    def cell(row, key):
        idx = int(mapping.get(key, -1))
        return str(row[idx]).strip() if 0 <= idx < len(row) else ""
    try:
        with connect() as db:
            known = {(r["entry_date"], r["amount"]) for r in db.execute("SELECT entry_date,amount FROM entries WHERE (entry_type='INCOME' AND arrival='bank') OR (entry_type='EXPENSE' AND pocket='bank') OR entry_type='BANK_CASH'")}
            rules = db.execute("SELECT rule_text,person,category FROM import_rules ORDER BY length(rule_text) DESC").fetchall()
        found = set()
        checked = []
        for row in rows:
            entry_date = parse_csv_date(cell(row, "date"))
            if int(mapping.get("debit", -1)) >= 0 or int(mapping.get("credit", -1)) >= 0:
                credit, debit = parse_csv_amount(cell(row, "credit")), parse_csv_amount(cell(row, "debit"))
                cents = credit if credit else -abs(debit)
            else:
                cents = parse_csv_amount(cell(row, "amount"))
            signature = (entry_date, abs(cents))
            duplicate = bool(entry_date and cents and (signature in known or signature in found))
            if entry_date and cents:
                found.add(signature)
            description = cell(row, "description").upper()
            rule = next((r for r in rules if r["rule_text"].upper() in description), None)
            checked.append({"date": entry_date, "cents": cents, "duplicate": duplicate, "description": cell(row, "description"), "suggested_person": rule["person"] if rule else "", "suggested_category": rule["category"] if rule else ""})
        return jsonify(rows=checked)
    except (ValueError, TypeError):
        return jsonify(error="Choose the date and amount columns before reviewing."), 400


@app.post("/api/import/save")
def import_save():
    data = request.get_json(force=True)
    mapping = data.get("mapping", {})
    rows = data.get("rows", [])
    selected = data.get("selected", [])
    batch_id = datetime.now().strftime("%Y%m%d%H%M%S%f")
    added, duplicates, skipped = 0, 0, 0
    total_in = 0
    try:
        with connect() as db:
            save_settings(db, {"csv_mapping": json.dumps({"headers": data.get("headers", []), "mapping": mapping})})
            def cell(row, key):
                idx = int(mapping.get(key, -1))
                return str(row[idx]).strip() if 0 <= idx < len(row) else ""
            for i, row in enumerate(rows):
                if i >= len(selected) or not selected[i].get("include"):
                    skipped += 1
                    continue
                entry_date = parse_csv_date(cell(row, "date"))
                if not entry_date:
                    skipped += 1
                    continue
                description = cell(row, "description")
                if int(mapping.get("debit", -1)) >= 0 or int(mapping.get("credit", -1)) >= 0:
                    credit = parse_csv_amount(cell(row, "credit"))
                    debit = parse_csv_amount(cell(row, "debit"))
                    cents = credit if credit else -abs(debit)
                else:
                    cents = parse_csv_amount(cell(row, "amount"))
                if cents == 0:
                    skipped += 1
                    continue
                duplicate = db.execute("SELECT 1 FROM entries WHERE entry_date=? AND amount=? AND entry_type IN ('INCOME','EXPENSE','BANK_CASH') AND (arrival='bank' OR pocket='bank') LIMIT 1", (entry_date, abs(cents))).fetchone()
                if duplicate:
                    duplicates += 1
                    continue
                if selected[i].get("cash"):
                    insert_entry(db, "BANK_CASH", abs(cents), entry_date, note=description, import_id=batch_id)
                elif cents > 0:
                    person = selected[i].get("person", "Imported income") or "Imported income"
                    _, value = add_income(db, {"amount": str(Decimal(cents) / 100), "date": entry_date, "person": person, "arrival": "bank", "note": description}, batch_id)
                    total_in += value
                    if description:
                        db.execute("INSERT INTO import_rules(rule_text,person,category) VALUES(?,?,?) ON CONFLICT(rule_text) DO UPDATE SET person=excluded.person", (description, person, ""))
                else:
                    category = selected[i].get("category", "Other")
                    insert_entry(db, "EXPENSE", abs(cents), entry_date, category=category, pocket="bank", note=description, import_id=batch_id)
                    if description:
                        db.execute("INSERT INTO import_rules(rule_text,person,category) VALUES(?,?,?) ON CONFLICT(rule_text) DO UPDATE SET category=excluded.category", (description, "", category))
                added += 1
            return jsonify(import_id=batch_id, added=added, skipped=skipped, duplicates=duplicates, total_in=total_in, suggested=int(Decimal(total_in) * Decimal(setting(db, "savings_pct", "20")) / 100))
    except (ValueError, InvalidOperation) as exc:
        return jsonify(error=str(exc)), 400


@app.get("/api/home-summary")
def home_summary():
    today = date.today()
    with connect() as db:
        b = balances(db)
        start_week = today - timedelta(days=today.weekday())
        month_start = date(today.year, today.month, 1)
        week = report_data(db, "week", today)
        month = report_data(db, "month", today)
        days_month = (period_bounds("month", today)[1] - today).days + 1
        available = max(0, b["bank"] + b["cash"] - b["owed"])
        month3_start = (month_start - timedelta(days=1)).replace(day=1)
        month3_end = month_start - timedelta(days=1)
        prev3_start = month_start
        for _ in range(3):
            prev3_start = date(prev3_start.year - (prev3_start.month == 1), 12 if prev3_start.month == 1 else prev3_start.month - 1, 1)
        months = []
        cursor = prev3_start
        while cursor <= month3_end:
            months.append(cursor)
            cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        ins, outs = 0, 0
        if months:
            prev_rows = period_entries(db, months[0], month3_end)
            ins = sum(r["amount"] for r in prev_rows if r["entry_type"] == "INCOME")
            outs = sum(r["amount"] for r in prev_rows if r["entry_type"] == "EXPENSE")
        denominator = max(1, days_month)
        return jsonify(balances=b, today=min(available // denominator, available), week=min((available // denominator) * min(7, denominator), available), month=available, avg_in=ins // 3, avg_out=outs // 3, week_in=week["in"], week_out=week["out"], week_saved=week["saved"], month_in=month["in"], month_out=month["out"], month_saved=month["saved"])


@app.errorhandler(413)
def too_large(_):
    return jsonify(error="That file is too large. Choose a CSV under 8 MB."), 413


init_db()

if __name__ == "__main__":
    cert = os.environ.get("MONEY_TRACKER_SSL_CERT")
    key = os.environ.get("MONEY_TRACKER_SSL_KEY")
    ssl_context = (cert, key) if cert and key else None
    app.run(host=os.environ.get("MONEY_TRACKER_HOST", "127.0.0.1"), port=5001, debug=False, ssl_context=ssl_context)
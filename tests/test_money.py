import os
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
import app as money


class MoneyMathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.NamedTemporaryFile(delete=False)
        self.temp.close()
        self.original = money.DB_PATH
        money.DB_PATH = self.temp.name
        money.init_db()
        self.client = money.app.test_client()
        self.client.post("/api/setup", json={"bank": 0, "cash": 0, "waiting": 0, "savings": 0})

    def tearDown(self):
        money.DB_PATH = self.original
        os.unlink(self.temp.name)

    def test_income_savings_owed_withdrawal_and_expense_example(self):
        income = self.client.post("/api/income", json={"amount": "1000", "date": "2026-10-04", "person": "Thabo", "arrival": "bank"})
        self.assertEqual(income.status_code, 200)
        self.assertEqual(income.json["suggested"], 20000)
        self.client.post("/api/reminder", json={"income_id": income.json["id"], "action": "done", "amount": "200"})
        cashsend = self.client.post("/api/income", json={"amount": "500", "date": "2026-10-04", "person": "Lerato", "arrival": "cashsend"})
        self.client.post("/api/reminder", json={"income_id": cashsend.json["id"], "action": "later", "amount": "100"})
        self.client.post("/api/withdraw", json={"income_id": cashsend.json["id"], "date": "2026-10-04", "fee": "10"})
        self.client.post("/api/expense", json={"amount": "150", "date": "2026-10-04", "category": "Food", "pocket": "cash"})
        summary = self.client.get("/api/home-summary").json
        self.assertEqual(summary["balances"], {"bank": 80000, "cash": 34000, "waiting": 0, "savings": 20000, "owed": 10000})
        report = self.client.get("/api/reports?period=month&date=2026-10-04").json
        self.assertEqual((report["in"], report["out"], report["saved"], report["left"]), (150000, 16000, 20000, 114000))

    def test_safe_to_spend_never_negative_and_starts_at_zero(self):
        summary = self.client.get("/api/home-summary").json
        self.assertEqual((summary["today"], summary["week"], summary["month"]), (0, 0, 0))

    def test_week_starts_monday_and_year_has_twelve_months(self):
        self.client.post("/api/income", json={"amount": "25", "date": "2026-10-05", "person": "A", "arrival": "bank"})
        week = self.client.get("/api/reports?period=week&date=2026-10-04").json
        year = self.client.get("/api/reports?period=year&date=2026-10-04").json
        self.assertEqual(week["start"], "2026-09-28")
        self.assertEqual(week["end"], "2026-10-04")
        self.assertEqual(len(year["months"]), 12)

    def test_supported_amount_and_date_formats(self):
        self.assertEqual(money.parse_csv_amount("1 234,50"), 123450)
        self.assertEqual(money.parse_csv_amount("1,234.50"), 123450)
        self.assertEqual(money.parse_csv_amount("-150.00"), -15000)
        self.assertEqual(money.parse_csv_amount("150.00 Dr"), -15000)
        self.assertEqual(money.parse_csv_date("2026-10-04"), "2026-10-04")
        self.assertEqual(money.parse_csv_date("04/10/2026"), "2026-10-04")
        self.assertEqual(money.parse_csv_date("04 Oct 2026"), "2026-10-04")

    def test_pwa_manifest_and_service_worker_are_available(self):
        with self.client.get("/static/manifest.webmanifest") as manifest:
            self.assertEqual(manifest.status_code, 200)
            data = json.loads(manifest.data)
        self.assertEqual(data["display"], "standalone")
        self.assertEqual(data["start_url"], "/")
        self.assertEqual({icon["sizes"] for icon in data["icons"]}, {"192x192", "512x512"})
        for icon in data["icons"]:
            with self.client.get(icon["src"]) as response:
                self.assertEqual(response.status_code, 200)
        with self.client.get("/service-worker.js") as worker:
            self.assertEqual(worker.status_code, 200)
            self.assertEqual(worker.headers["Service-Worker-Allowed"], "/")

    def test_legacy_sqlite_api_is_not_reachable_from_other_devices(self):
        response = money.app.test_client().get("/api/initialize", environ_base={"REMOTE_ADDR": "192.168.0.221"})
        self.assertEqual(response.status_code, 403)

    def test_sample_csv_layouts_import_duplicates_and_undo(self):
        samples = Path(__file__).parent / "samples"
        expectations = {"amount.csv": 85000, "debit-credit.csv": 85000, "comma-decimal.csv": 120900}
        for filename, expected_bank in expectations.items():
            contents = (samples / filename).read_bytes()
            preview = self.client.post("/api/import/preview", data={"file": (BytesIO(contents), filename)}, content_type="multipart/form-data")
            self.assertEqual(preview.status_code, 200, preview.json)
            draft = preview.json
            checked = self.client.post("/api/import/check", json={"mapping": draft["mapping"], "rows": draft["rows"]})
            self.assertEqual(checked.status_code, 200, checked.json)
            selected = [{"include": True, "person": "Imported income", "category": "Food", "cash": False} for _ in draft["rows"]]
            saved = self.client.post("/api/import/save", json={"headers": draft["headers"], "mapping": draft["mapping"], "rows": draft["rows"], "selected": selected})
            self.assertEqual(saved.status_code, 200, saved.json)
            self.assertEqual(saved.json["added"], 2, f"{filename}: {saved.json}")
            checked_again = self.client.post("/api/import/check", json={"mapping": draft["mapping"], "rows": draft["rows"]})
            self.assertTrue(all(row["duplicate"] for row in checked_again.json["rows"]))
            self.client.post("/api/import/undo", json={"import_id": saved.json["import_id"]})
            self.assertEqual(self.client.get("/api/initialize").json["balances"]["bank"], 0)


if __name__ == "__main__":
    unittest.main()
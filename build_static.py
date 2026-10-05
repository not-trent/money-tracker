import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR / "dist"


def build():
    if OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    shutil.copytree(BASE_DIR / "static", OUTPUT_DIR / "static")
    shutil.copy2(BASE_DIR / "static" / "service-worker.js", OUTPUT_DIR / "service-worker.js")
    environment = Environment(loader=FileSystemLoader(BASE_DIR / "templates"), autoescape=True)
    template = environment.get_template("index.html")
    html = template.render(url_for=lambda endpoint, filename: f"/static/{filename}")
    (OUTPUT_DIR / "index.html").write_text(html, encoding="utf-8")
    print(f"Static PWA built in {OUTPUT_DIR}")


if __name__ == "__main__":
    build()
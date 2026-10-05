# Money Tracker

A private, single-user finance tracker built with Flask, SQLite, HTML, CSS and JavaScript. All data is stored locally in `money.db`; the app binds only to `127.0.0.1:5001`.

## Start

Install Python 3.10 or newer (or `uv`). On Windows, double-click `start.bat`. On Linux or macOS, run `bash ./start.sh`. The start script creates a local virtual environment, installs Flask, and starts the app at http://localhost:5001. If Python is managed by `uv`, the scripts use `uv run` instead. The initial screen asks for starting balances.

For phone access on your private Wi-Fi, double-click `start-mobile.bat` instead. Open the computer's local Wi-Fi address on the phone at port `5001`, then use Chrome's **Add to Home screen** menu. The phone and computer must stay on the same trusted Wi-Fi, and the computer must remain on with the app running. This mobile mode has no login and is reachable by other devices on that Wi-Fi; do not use it on public/guest networks or set up router port forwarding. Regular `start.bat` remains computer-only.

The app also includes a PWA manifest, app icons, and a service worker that caches the interface assets only; financial API responses are never cached. Android Chrome requires a trusted HTTPS connection before it offers **Install app**. The plain local HTTP address is usable in Chrome but is not installable. For a local trusted certificate on Windows:

1. Install mkcert with `winget install --id FiloSottile.mkcert -e`.
2. In PowerShell, from the `money-tracker` folder, run `mkcert -install` and `New-Item -ItemType Directory -Force certs`.
3. Create a certificate for your current PC Wi-Fi IP: `mkcert -cert-file .\certs\lan-cert.pem -key-file .\certs\lan-key.pem 192.168.0.158`.
4. Run `mkcert -CAROOT`, copy the `rootCA.pem` from that folder to the phone over USB, rename the copy to `rootCA.crt`, and install it in Android's **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**. Menu names vary by Android version.
5. Restart `start-mobile.bat`, open `https://192.168.0.158:5001` in Chrome, then choose **Install app** from Chrome's menu (or the Install control in Settings).

If your PC's Wi-Fi address changes, regenerate the certificate for its new IP and reinstall the updated local CA if needed. The certificate folder is git-ignored; never share the private key. Installing this CA makes the phone trust certificates it issues, so keep the CA private and remove it from Android settings if you no longer need it.

To run tests after setup:

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
```

## Your data

The database lives beside `app.py` as `money.db`. Use **Settings → Back up my data** to download a copy. Keep the database and its backup private; it contains your financial history.

## Current scope

The app includes the six requested areas, income and expense entry, cash-send withdrawals, savings reminders, goals, period reports, CSV export, history, backup, and a CSV statement review/import flow. CSV review lets you select columns, excludes detected duplicates by default, and learns person/category labels from descriptions. Starting balances remain adjustable in Settings. Chart.js is bundled in `static/vendor/`, so charts need no internet connection.
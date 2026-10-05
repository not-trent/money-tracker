# Money Tracker

A no-login personal finance PWA. Each browser installation keeps a separate ledger in its own IndexedDB; there is no account, data sync, or financial-data upload to the host. Flask serves the local development version at port 5001. The old `money.db` is retained only for migrating the original computer ledger.

## Start

Install Python 3.10 or newer (or `uv`). On Windows, double-click `start.bat`. On Linux or macOS, run `bash ./start.sh`. The initial screen asks for starting balances for this browser installation.

For temporary phone access on your private Wi-Fi, double-click `start-mobile.bat`. The computer must remain on and the phone must trust the local certificate. The server's old SQLite API is blocked to non-local clients; the PWA itself stores new data only in the browser.

The PWA includes a manifest, PNG app icons, and a service worker that caches interface assets only. Android Chrome needs HTTPS to install it. The local `start-mobile.bat` certificate setup below is only for testing on your home Wi-Fi; for a shareable link, use a static HTTPS host such as Cloudflare Pages. Build the static site with:

```powershell
uv run --with-requirements requirements.txt --python 3.14 python build_static.py
```

Deploy the `dist/` folder to a static HTTPS host. For Cloudflare Pages, connect this GitHub repository and set the build command to `pip install -r requirements.txt && python build_static.py` and the output directory to `dist`. Anyone with the link can install the PWA, but each device/browser has its own separate ledger. Records do not sync between devices.

For temporary local phone testing with `start-mobile.bat`, create a trusted certificate:

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

Use **Settings → Back up my data** to save a JSON backup on that device. **Restore a device backup** imports it and replaces the current device's data. Transfer the backup file yourself, such as by USB; it contains financial details.

The original computer ledger remains in `money.db`. To migrate it into this browser's local PWA storage, run `uv run --with-requirements requirements.txt --python 3.14 python export_device_backup.py`, then open Settings in the PWA and restore `money-tracker-device-backup.json`. The export file is git-ignored and should be transferred privately if restoring on a different device. The former `/api/` SQLite routes are blocked to other devices.

## Current scope

The app includes the six requested areas, income and expense entry, cash-send withdrawals, savings reminders, goals, period reports, CSV export, history, backup, and a CSV statement review/import flow. CSV review lets you select columns, excludes detected duplicates by default, and learns person/category labels from descriptions. Starting balances remain adjustable in Settings. Chart.js is bundled in `static/vendor/`, so charts need no internet connection.
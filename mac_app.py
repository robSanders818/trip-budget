"""Trip Budget for the Mac: http://localhost:8790

    uv run mac_app.py

The same app as the iPhone version, but trips and attached files are saved as plain files
under data/ in this folder (data/trips/<id>.json, data/files/<id>.<ext>).

"Save for phone" on the home screen encrypts everything with your sync passphrase into
sync/trip-budget.sync, commits only that file, and pushes. The repo is public (GitHub Pages),
so only the encrypted file ever leaves this Mac. On the phone, "Sync from Mac" downloads and
decrypts it. The passphrase is kept in the macOS Keychain.
"""

import base64
import gzip
import hashlib
import json
import mimetypes
import os
import re
import secrets
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import keyring
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).parent.resolve()
DATA = ROOT / "data"
TRIPS = DATA / "trips"
FILES = DATA / "files"
SETTINGS = DATA / "settings.json"
SYNC_STATE = DATA / "last_sync.json"
SYNC_FILE = ROOT / "sync" / "trip-budget.sync"
PORT = 8790

KEYCHAIN_SERVICE = "trip-budget-sync"
KEYCHAIN_ACCOUNT = "sync"
SYNC_MAGIC = b"TBS1"  # format: magic | salt(16) | iv(12) | AES-256-GCM(gzip(json))
PBKDF2_ITERATIONS = 310_000  # must match SYNC_ITERATIONS in app.js

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Only the app itself is served, never data/, sync/ or .git.
STATIC_FILES = {"index.html", "app.js", "app.css", "manifest.webmanifest"}
STATIC_DIRS = ("icons/", "vendor/pdfjs/")

lock = threading.Lock()


# ---------------- storage ----------------


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def load_settings() -> dict:
    return json.loads(SETTINGS.read_text()) if SETTINGS.exists() else {}


def file_path(fid: str) -> Path | None:
    return next(FILES.glob(f"{fid}.*"), None) if FILES.exists() else None


def file_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def file_ext(ctype: str) -> str:
    ext = {"image/jpeg": ".jpg"}.get(ctype) or mimetypes.guess_extension(ctype or "") or ".bin"
    return ext


# ---------------- sync ----------------


def build_bundle() -> tuple[bytes, str]:
    """Everything as one JSON document in the app's backup format, plus a digest of its content."""
    trips = [json.loads(p.read_text()) for p in sorted(TRIPS.glob("*.json"))] if TRIPS.exists() else []
    images = {}
    for p in sorted(FILES.iterdir()) if FILES.exists() else []:
        if p.is_file() and not p.name.endswith(".tmp"):
            images[p.stem] = {"type": file_type(p), "data": base64.b64encode(p.read_bytes()).decode()}
    content = {"trips": trips, "images": images, "currencies": load_settings().get("currencies")}
    digest = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    bundle = {"app": "tripbudget", "v": 1, "exported": datetime.now().astimezone().isoformat(), **content}
    return json.dumps(bundle, separators=(",", ":")).encode(), digest


def encrypt(plain: bytes, passphrase: str) -> bytes:
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, PBKDF2_ITERATIONS, 32)
    return SYNC_MAGIC + salt + iv + AESGCM(key).encrypt(iv, gzip.compress(plain, 9), None)


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=90)


def push_sync(new_passphrase: str | None) -> tuple[int, dict]:
    if new_passphrase:
        keyring.set_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, new_passphrase)
    passphrase = keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    if not passphrase:
        return 409, {"need": "passphrase"}

    plain, digest = build_bundle()
    last = json.loads(SYNC_STATE.read_text()) if SYNC_STATE.exists() else {}
    if last.get("digest") == digest and SYNC_FILE.exists() and not new_passphrase:
        return 200, {"ok": True, "message": "Nothing changed since your last save, so there was nothing new to push."}

    write_atomic(SYNC_FILE, encrypt(plain, passphrase))
    rel = str(SYNC_FILE.relative_to(ROOT))
    steps = [("add", git("add", "--", rel))]
    # Commit only the sync file, leaving any other work in progress untouched.
    steps.append(("commit", git("commit", "-m", "Sync trip data from Mac", "--only", "--", rel)))
    if steps[-1][1].returncode == 0:
        steps.append(("push", git("push")))
    log = "\n".join(f"$ git {name}\n{(r.stdout + r.stderr).strip()}" for name, r in steps)
    failed = next((name for name, r in steps if r.returncode != 0), None)
    if failed:
        return 500, {"ok": False, "message": f"git {failed} failed. The sync file was saved but not pushed.", "log": log}

    SYNC_STATE.write_text(json.dumps({"digest": digest, "at": datetime.now().astimezone().isoformat()}))
    size_kb = SYNC_FILE.stat().st_size / 1024
    return 200, {"ok": True, "log": log,
                 "message": f"Pushed ({size_kb:,.0f} KB, encrypted). In about a minute, tap “Sync from Mac” on your phone."}


def sync_status() -> dict:
    last = json.loads(SYNC_STATE.read_text()) if SYNC_STATE.exists() else {}
    return {"lastSaved": last.get("at"),
            "hasPassphrase": bool(keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT))}


# ---------------- HTTP ----------------


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes = b"", ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode())

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def log_message(self, *args) -> None:  # keep the terminal quiet
        pass

    def _route(self) -> tuple[str, str]:
        parts = unquote(urlparse(self.path).path).strip("/").split("/")
        if parts[0] != "api" or len(parts) < 2:
            return "", ""
        return parts[1], "/".join(parts[2:])

    # -------- GET --------
    def do_GET(self) -> None:
        kind, key = self._route()
        if kind:
            return self._api_get(kind, key)
        path = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        if path == "index.html":
            # Tell the page it's the Mac version, so it saves to files instead of the browser.
            html = (ROOT / "index.html").read_text().replace(
                '<script src="app.js">', '<script>window.TB_DESKTOP = true</script>\n  <script src="app.js">')
            return self._send(200, html.encode(), "text/html; charset=utf-8")
        target = (ROOT / path).resolve()
        allowed = path in STATIC_FILES or path.startswith(STATIC_DIRS)
        if not allowed or ROOT not in target.parents or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = "text/javascript" if target.suffix == ".js" else (mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def _api_get(self, kind: str, key: str) -> None:
        with lock:
            if kind == "trips" and not key:
                trips = [json.loads(p.read_text()) for p in sorted(TRIPS.glob("*.json"))] if TRIPS.exists() else []
                return self._json(trips)
            if kind == "files" and not key:
                return self._json([p.stem for p in FILES.iterdir() if p.is_file() and not p.name.endswith(".tmp")]
                                  if FILES.exists() else [])
            if kind == "files" and ID_RE.match(key):
                p = file_path(key)
                return self._send(200, p.read_bytes(), file_type(p)) if p else self._send(404)
            if kind == "settings" and ID_RE.match(key):
                settings = load_settings()
                return self._json(settings[key]) if key in settings else self._send(404)
            if kind == "sync" and key == "status":
                return self._json(sync_status())
        self._send(404)

    # -------- PUT --------
    def do_PUT(self) -> None:
        kind, key = self._route()
        if not ID_RE.match(key or ""):
            return self._send(400)
        body = self._body()
        with lock:
            if kind == "trips":
                write_atomic(TRIPS / f"{key}.json", json.dumps(json.loads(body), indent=1).encode())
            elif kind == "files":
                old = file_path(key)
                new = FILES / f"{key}{file_ext(self.headers.get('Content-Type', ''))}"
                write_atomic(new, body)
                if old and old != new:
                    old.unlink()
            elif kind == "settings":
                settings = load_settings()
                settings[key] = json.loads(body)
                write_atomic(SETTINGS, json.dumps(settings, indent=1).encode())
            else:
                return self._send(404)
        self._json({"ok": True})

    # -------- DELETE --------
    def do_DELETE(self) -> None:
        kind, key = self._route()
        if not ID_RE.match(key or ""):
            return self._send(400)
        with lock:
            p = TRIPS / f"{key}.json" if kind == "trips" else file_path(key) if kind == "files" else None
            if p and p.exists():
                p.unlink()
        self._json({"ok": True})

    # -------- POST --------
    def do_POST(self) -> None:
        kind, key = self._route()
        if kind != "sync" or key != "push":
            return self._send(404)
        passphrase = (json.loads(self._body() or b"{}").get("passphrase") or "").strip() or None
        with lock:
            code, result = push_sync(passphrase)
        self._json(result, code)


def main() -> None:
    url = f"http://localhost:{PORT}"
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is already in use — Trip Budget is probably already running.\n"
              f"Open {url}, or stop the other copy with:  lsof -ti tcp:{PORT} | xargs kill")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    print(f"Trip Budget running at {url}  (Ctrl+C to stop)\nData folder: {DATA}")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

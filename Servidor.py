#!/usr/bin/env python3
# HTTP 8080: estáticos (ZIP o carpeta) + proxy /api/* → ESP32 + Fallback SPA robusto
import os, sys, json, urllib.request, urllib.error, mimetypes, zipfile, posixpath
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))
STATIC_ZIP = os.environ.get("STATIC_ZIP")
STATIC_DIR = os.environ.get("STATIC_DIR")
DEFAULT_BASE_ENV = os.environ.get("ESP32_BASE")

import argparse
ap = argparse.ArgumentParser(description="HTTP 8080: web desde ZIP/carpeta + proxy /api/* → ESP32")
ap.add_argument("--zip", dest="zip_path")
ap.add_argument("--dir", dest="dir_path")
ap.add_argument("--port", type=int, default=PORT)
ap.add_argument("--esp32", dest="esp32_base")
args = ap.parse_args()
PORT = args.port
if args.zip_path: STATIC_ZIP = args.zip_path
if args.dir_path: STATIC_DIR = args.dir_path
"""
Normaliza una URL base para el ESP32. Si `raw` está vacío se usa `fallback`.
Siempre devuelve esquema http/https y sin slash final.
"""
def normalize_base(raw, fallback: str) -> str:
    candidate = "" if raw is None else str(raw).strip()
    if not candidate:
        candidate = fallback
    if not candidate.lower().startswith(("http://", "https://")):
        if candidate.startswith("//"):
            candidate = "http:" + candidate
        else:
            candidate = "http://" + candidate
    return candidate.rstrip("/")

DEFAULT_ESP32_BASE = normalize_base(DEFAULT_BASE_ENV, "http://192.168.4.1")
if args.esp32_base:
    DEFAULT_ESP32_BASE = normalize_base(args.esp32_base, DEFAULT_ESP32_BASE)

ESP32_BASE = DEFAULT_ESP32_BASE
BASE_LOCK = threading.Lock()

def get_esp32_base() -> str:
    with BASE_LOCK:
        return ESP32_BASE

def set_esp32_base(new_base) -> str:
    global ESP32_BASE
    normalized = normalize_base(new_base, DEFAULT_ESP32_BASE)
    with BASE_LOCK:
        if normalized == ESP32_BASE:
            return ESP32_BASE
        ESP32_BASE = normalized
    print(f"[Proxy] ESP32_BASE -> {ESP32_BASE}")
    return ESP32_BASE

def esp32_fetch(path, method="GET", data:bytes=None, timeout=5, content_type=None):
    url = get_esp32_base() + path
    req = urllib.request.Request(url, method=method, data=data)
    if content_type: req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        ctype = resp.headers.get("Content-Type","application/json; charset=utf-8")
        return body, ctype, resp.status

def guess_type(path):
    ctype, _ = mimetypes.guess_type(path)
    if not ctype:
        if path.endswith(".js"): ctype = "application/javascript"
        elif path.endswith(".css"): ctype = "text/css; charset=utf-8"
        else: ctype = "application/octet-stream"
    return ctype

def norm_web_path(url_path:str)->str:
    p = url_path.split('?',1)[0].split('#',1)[0]
    p = p.lstrip('/')
    p = posixpath.normpath(p)
    return "" if p=="." else p

# ZIP loader
ZIP = None; ZIP_INDEX = None; ZIP_NAMES = set()
if STATIC_ZIP and os.path.isfile(STATIC_ZIP):
    ZIP = zipfile.ZipFile(STATIC_ZIP, 'r')
    ZIP_NAMES = set(ZIP.namelist())
    for cand in ("index.html","index.htm","Index.html","INDEX.HTML"):
        if cand in ZIP_NAMES: ZIP_INDEX = cand; break

def read_from_zip(web_path:str):
    if ZIP is None: return None, None, 404
    target = "index.html" if (web_path=="" or web_path.endswith("/")) else web_path.replace("\\","/")
    if target in ZIP_NAMES:
        with ZIP.open(target,'r') as fh:
            data = fh.read()
        return data, guess_type(target), 200
    return None, None, 404

def read_from_dir(base:str, web_path:str):
    if not base: return None, None, 404
    rel = "index.html" if (web_path=="" or web_path.endswith("/")) else web_path.replace("\\","/")
    fs_path = os.path.normpath(os.path.join(base, rel))
    base_abs = os.path.abspath(base); fs_abs = os.path.abspath(fs_path)
    if not fs_abs.startswith(base_abs): return None, None, 403
    if not os.path.isfile(fs_abs): return None, None, 404
    with open(fs_abs,"rb") as f:
        data=f.read()
    return data, guess_type(fs_abs), 200

def serve_index(handler):
    # Resuelve index.html desde ZIP o DIR (prioriza DIR si existe)
    if STATIC_DIR and os.path.isdir(STATIC_DIR):
        data, ctype, code = read_from_dir(STATIC_DIR, "index.html")
        if code==200: return handler._send(200, data, ctype)
    if ZIP:
        # usa ZIP_INDEX si existe
        key = ZIP_INDEX or "index.html"
        if key in ZIP_NAMES:
            data, ctype, code = read_from_zip(key)
            if code==200: return handler._send(200, data, ctype)
    # fallback mínimo si no hay assets
    current_base = get_esp32_base()
    html = f"""<!doctype html><meta charset='utf-8'><title>Servidor 8080</title>
    <style>body{{font-family:system-ui;margin:24px}}</style>
    <h1>Servidor 8080</h1>
    <p>No se encontró <code>index.html</code> en DIR/ZIP.</p>
    <pre>ESP32_BASE = {current_base}\nDEFAULT = {DEFAULT_ESP32_BASE}</pre>
    <ul>
      <li><a href="/api/status">/api/status</a></li>
      <li><a href="/api/sensors">/api/sensors</a></li>
      <li><a href="/api/config">/api/config</a></li>
      <li><a href="/_config/esp32_base">/_config/esp32_base</a></li>
    </ul>"""
    return handler._send(200, html.encode("utf-8"), "text/html; charset=utf-8")

class Handler(BaseHTTPRequestHandler):
    server_version="ZipStaticProxy/1.3"; sys_version=""

    def _send(self, status:int, body:bytes, ctype="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type")
        self.end_headers()

    def do_GET(self):
        # Salud
        if self.path == "/_health": return self._send(200, b'{"ok":true}')

        if self.path == "/_config/esp32_base":
            payload = {"base": get_esp32_base(), "default": DEFAULT_ESP32_BASE}
            return self._send(200, json.dumps(payload).encode("utf-8"))

        # Proxy API
        if self.path.startswith("/api/"):
            try:
                body, ctype, code = esp32_fetch(self.path, method="GET")
                return self._send(code, body, ctype)
            except urllib.error.URLError as e:
                j = {"ok": False, "error": str(e), "hint": "Revisa ESP32_BASE o conexión."}
                return self._send(502, json.dumps(j).encode("utf-8"))

        # Estáticos
        web_path = norm_web_path(self.path)
        # Si parece archivo (tiene punto), intenta servirlo tal cual
        if "." in posixpath.basename(web_path):
            if ZIP:
                d,c,code = read_from_zip(web_path)
                if code==200: return self._send(200,d,c)
            if STATIC_DIR and os.path.isdir(STATIC_DIR):
                d,c,code = read_from_dir(STATIC_DIR, web_path)
                if code==200: return self._send(200,d,c)
            # Si el archivo no existe, reescribe a index.html (SPA)
            return serve_index(self)

        # Cualquier ruta "limpia" (p.ej. /dashboard, /admin/usuarios) → index.html (SPA)
        return serve_index(self)

    def do_POST(self):
        if self.path == "/_config/esp32_base":
            length = int(self.headers.get("Content-Length","0") or 0)
            raw = self.rfile.read(length) if length>0 else b"{}"
            try:
                payload = json.loads((raw.decode("utf-8", errors="ignore") or "{}"))
            except json.JSONDecodeError:
                msg = {"ok": False, "error": "JSON inválido"}
                return self._send(400, json.dumps(msg).encode("utf-8"))
            base_value = payload.get("base")
            if base_value is None or isinstance(base_value, str):
                new_base = set_esp32_base(base_value)
                resp = {"ok": True, "base": new_base, "default": DEFAULT_ESP32_BASE}
                return self._send(200, json.dumps(resp).encode("utf-8"))
            msg = {"ok": False, "error": "Campo 'base' debe ser string"}
            return self._send(400, json.dumps(msg).encode("utf-8"))

        if self.path in ("/api/start","/api/stop","/api/config"):
            length = int(self.headers.get("Content-Length","0") or 0)
            body = self.rfile.read(length) if length>0 else b"{}"
            try:
                if self.path == "/api/config":
                    data, ctype, code = esp32_fetch("/api/config", method="POST", data=body, content_type="application/json")
                else:
                    data, ctype, code = esp32_fetch(self.path, method="POST", data=b"{}", content_type="application/json")
                return self._send(code, data, ctype)
            except urllib.error.URLError as e:
                j = {"ok": False, "error": str(e)}
                return self._send(502, json.dumps(j).encode("utf-8"))
        return self._send(404, json.dumps({"ok":False,"error":"Not found"}).encode("utf-8"))

def run():
    mode = "panel embebido (sin assets)"
    if STATIC_DIR and os.path.isdir(STATIC_DIR): mode = f"DIR: {STATIC_DIR}"
    elif STATIC_ZIP and os.path.isfile(STATIC_ZIP): mode = f"ZIP: {STATIC_ZIP}"
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[OK] Servidor en http://{HOST}:{PORT}")
    print(f"     Modo estáticos: {mode}")
    print(f"     ESP32_BASE actual: {get_esp32_base()} (default: {DEFAULT_ESP32_BASE})")
    print("     API: /api/status (GET), /api/sensors (GET), /api/start (POST), /api/stop (POST), /api/config (GET/POST)")
    print("     Config: GET/POST /_config/esp32_base (actualiza destino del proxy)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Bye] Cerrando...")
    finally:
        httpd.server_close()

if __name__ == "__main__":
    run()

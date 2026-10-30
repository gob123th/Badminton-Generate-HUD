#!/usr/bin/env python3
"""Tiny static server for this folder (localhost only).
Sends COOP/COEP headers so the browser enables multi-threaded WASM (faster on CPU)."""
import http.server
import os
import pathlib
import socketserver
import sys
import webbrowser
import threading

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
HERE = pathlib.Path(__file__).resolve().parent


def join_parts():
    """Models > 100 MB are stored in git as <file>.part0, .part1, … (GitHub's file limit): join them once."""
    for p0 in sorted((HERE / "models").rglob("*.part0")):
        out = p0.with_suffix("")
        if out.exists() and out.stat().st_size > 0:
            continue
        print(f"รวมไฟล์โมเดล {out.relative_to(HERE)}")
        tmp = out.with_name(out.name + ".tmp")
        with open(tmp, "wb") as w:
            i = 0
            while (part := out.with_name(f"{out.name}.part{i}")).exists():
                w.write(part.read_bytes())
                i += 1
        os.replace(tmp, out)


join_parts()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
                      ".html": "text/html; charset=utf-8", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
    url = f"http://localhost:{PORT}/"
    print(f"เปิดใช้งานที่ {url}  (กด Ctrl+C เพื่อปิด)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

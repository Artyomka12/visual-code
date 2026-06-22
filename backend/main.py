"""
HTTP-сервер на встроенных модулях Python — никаких pip-пакетов не нужно.
Запуск: python main.py
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import os
import sys

from validator import validate
from tracer import trace_code

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
}


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        try:
            print(f'  {self.command} {self.path}  {args[1]}')
        except Exception:
            pass

    # ── CORS preflight ──────────────────────────────────────
    def do_OPTIONS(self):
        self._cors(200)

    # ── Static files ────────────────────────────────────────
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            path = '/index.html'
        if path == '/health':
            self._json({'status': 'ok'})
            return

        file_path = os.path.normpath(os.path.join(FRONTEND_DIR, path.lstrip('/')))
        # Security: prevent path traversal
        if not file_path.startswith(os.path.normpath(FRONTEND_DIR)):
            self._cors(403)
            return

        ext = os.path.splitext(file_path)[1]
        mime = MIME.get(ext, 'application/octet-stream')

        try:
            with open(file_path, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self._add_cors_headers()
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self._cors(404)

    # ── /trace endpoint ─────────────────────────────────────
    def do_POST(self):
        if self.path != '/trace':
            self._cors(404)
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
        except Exception:
            self._json({'error': {'type': 'ParseError', 'message': 'Неверный JSON', 'line': None}, 'steps': [], 'truncated': False})
            return

        code = body.get('code', '').strip()
        if not code:
            self._json({'error': {'type': 'ValidationError', 'message': 'Код не может быть пустым', 'line': None}, 'steps': [], 'truncated': False})
            return

        valid, err_msg = validate(code)
        if not valid:
            self._json({'error': {'type': 'ValidationError', 'message': err_msg, 'line': None}, 'steps': [], 'truncated': False})
            return

        result = trace_code(code)
        self._json(result)

    # ── Helpers ─────────────────────────────────────────────
    def _add_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _cors(self, code):
        self.send_response(code)
        self._add_cors_headers()
        self.end_headers()

    def _json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self._add_cors_headers()
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = 8080
    server = HTTPServer(('', port), Handler)
    print(f'')
    print(f'  Сервер запущен: http://localhost:{port}')
    print(f'  Открой в браузере: http://localhost:{port}')
    print(f'  Для остановки нажми Ctrl+C')
    print(f'')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Сервер остановлен.')

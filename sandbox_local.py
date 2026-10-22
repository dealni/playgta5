"""Servidor do teste local: mantém os arquivos da release intactos."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import serve_local

PORT = 18765


class SandboxHandler(serve_local.Handler):
    def parse_request(self):
        if not super().parse_request():
            return False
        if self.headers.get('Host') not in (f'localhost:{PORT}', f'127.0.0.1:{PORT}'):
            self.send_error(403, 'Local host only')
            return False
        return True

    def end_headers(self):
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
                         "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                         "font-src 'self' data:; media-src 'self' blob:; "
                         "worker-src 'self' blob:; connect-src 'self'; "
                         "object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'")
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, 'Directory listing disabled')
        return None


if __name__ == '__main__':
    if not (serve_local.ROOT / 'index.html').is_file():
        raise SystemExit('Os arquivos do jogo ainda não estão completos.')
    address = f'http://localhost:{PORT}/?mode=sandbox&low=1&fps=30&res=1280x720'
    print('Abra no Google Chrome: ' + address, flush=True)
    print('Ctrl+C encerra o servidor.', flush=True)
    with ThreadingHTTPServer(('127.0.0.1', PORT), SandboxHandler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

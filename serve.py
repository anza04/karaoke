"""Tiny static server for the karaoke app.

Spotify requires the redirect URI to be an exact loopback address, so this always
serves on http://127.0.0.1:8888/ (register exactly that in the Spotify dashboard).
"""
import http.server
import os
import sys
import webbrowser

HOST, PORT = "127.0.0.1", 8888
URL = f"http://{HOST}:{PORT}/"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows' registry sometimes maps .js to text/plain, which breaks ES modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.ThreadingHTTPServer((HOST, PORT), Handler) as server:
        print(f"Karaoke is running at {URL}  (Ctrl+C to stop)")
        if "--no-browser" not in sys.argv:
            webbrowser.open(URL)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

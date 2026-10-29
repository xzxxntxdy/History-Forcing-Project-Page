#!/usr/bin/env python3
"""Serve this project locally, including byte ranges for seekable videos."""

import argparse
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re


class RangeRequestHandler(SimpleHTTPRequestHandler):
    """Add single-byte-range responses to the standard static-file server."""

    # Some Windows MIME registries omit WebP; full-size figure links must open
    # as images rather than trigger application/octet-stream downloads.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webp": "image/webp"}

    _byte_range = None

    def handle(self):
        # Seeking or navigating away commonly closes an active video request.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        self._byte_range = None
        header = self.headers.get("Range")
        path = self.translate_path(self.path)
        # Keep the standard handler's directory redirects and index behavior.
        if header is None or os.path.isdir(path):
            return super().send_head()
        if path.endswith("/"):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            source = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            stat = os.fstat(source.fileno())
            size = stat.st_size
            modified = self.date_time_string(stat.st_mtime)
            # No ETag is issued; an unmatched If-Range requests the full file.
            if_range = self.headers.get("If-Range")
            if if_range is not None and if_range != modified:
                source.close()
                return super().send_head()

            match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
            try:
                if match is None or size == 0:
                    raise ValueError("Invalid range")
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), size - 1) if last else size - 1
                    if start >= size or start > end:
                        raise ValueError("Unsatisfiable range")
                else:
                    length = int(last)
                    if length <= 0:
                        raise ValueError("Invalid suffix range")
                    start, end = max(0, size - length), size - 1
            except ValueError:
                source.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            source.seek(start)
            self._byte_range = (start, end)
            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Last-Modified", modified)
            self.end_headers()
            return source
        except BaseException:
            source.close()
            raise

    def copyfile(self, source, outputfile):
        if self._byte_range is None:
            return super().copyfile(source, outputfile)
        start, end = self._byte_range
        remaining = end - start + 1
        while remaining:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765)")
    parser.add_argument("--bind", default="127.0.0.1", help="Listen address (default: 127.0.0.1)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    directory = Path(__file__).resolve().parent
    handler = partial(RangeRequestHandler, directory=str(directory))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving {directory}\nhttp://{args.bind}:{args.port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")


if __name__ == "__main__":
    main()

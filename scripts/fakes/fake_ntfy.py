#!/usr/bin/env python3
"""A fake ntfy server for tests: what the chief's paste messages and Dictate & Delegate's stream need.

  POST|PUT /<topic>          publish: the body is the message; Title/X-Title, Tags/X-Tags/ta,
                             Actions/X-Actions, Click and Priority/X-Priority/p headers are kept
                             (X-Fake-Time: unix seconds to give the message, for tests of old ones)
  GET /<topic>/json          the JSON stream ntfy serves: an "open" event, the messages since
                             ?since=<unix seconds> (or "all"), then new ones as they're published,
                             with a keepalive every 20 s; ?poll=1 sends what's there and closes

Test control (not part of ntfy):

  POST /test/reset           forgets messages and the log
  GET  /test/requests        what happened, oldest first: {"method": "publish", "topic", "title",
                             "tags", "actions", "message"} or {"method": "subscribe", "topic",
                             "since", "poll"}

Usage: python3 scripts/fakes/fake_ntfy.py [--port 8799]
"""
import argparse
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

lock = threading.Condition()
messages = []  # every published message, oldest first
log = []


def header(headers, *names):
    for n in names:
        if headers.get(n) is not None:
            return headers.get(n)
    return ""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        self.do_POST()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if path == "/test/reset":
            with lock:
                messages.clear()
                log.clear()
            return self.reply(200, {})
        topic = path.strip("/")
        if not topic or "/" in topic:
            return self.reply(404, {"error": "not found"})
        tags = [t.strip() for t in header(self.headers, "X-Tags", "Tags", "Tag", "ta").split(",") if t.strip()]
        m = {"id": secrets.token_hex(6), "time": int(time.time()), "event": "message", "topic": topic,
             "message": body.decode("utf-8", "replace")}
        title = header(self.headers, "X-Title", "Title", "t")
        if title:
            m["title"] = title
        if tags:
            m["tags"] = tags
        click = header(self.headers, "X-Click", "Click")
        if click:
            m["click"] = click
        actions = header(self.headers, "X-Actions", "Actions", "Action")
        priority = header(self.headers, "X-Priority", "Priority", "Prio", "p")
        if priority:
            names = {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5, "urgent": 5}
            m["priority"] = names.get(priority.lower(), int(priority) if priority.isdigit() else 3)
        fake_time = header(self.headers, "X-Fake-Time")
        if fake_time.isdigit():
            m["time"] = int(fake_time)
        entry = {"method": "publish", "topic": topic, "title": title, "tags": tags,
                 "actions": actions, "message": m["message"]}
        if priority:
            entry["priority"] = m["priority"]
        with lock:
            messages.append(m)
            log.append(entry)
            lock.notify_all()
        self.reply(200, m)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/test/requests":
            with lock:
                return self.reply(200, {"requests": list(log)})
        parts = url.path.strip("/").split("/")
        if len(parts) != 2 or parts[1] != "json":
            return self.reply(404, {"error": "not found"})
        topic = parts[0]
        q = parse_qs(url.query)
        since = q.get("since", ["all"])[0]
        since_time = 0 if since == "all" else int(since) if since.isdigit() else int(time.time())
        poll = q.get("poll", ["0"])[0] in ("1", "true", "yes")
        with lock:
            log.append({"method": "subscribe", "topic": topic, "since": since, "poll": poll})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.end_headers()

        def write(obj):
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        try:
            if not poll:
                write({"id": secrets.token_hex(6), "time": int(time.time()), "event": "open", "topic": topic})
            with lock:
                sent = [m for m in messages if m["topic"] == topic and m["time"] >= since_time]
                seen = len(messages)
            for m in sent:
                write(m)
            if poll:
                return
            while True:
                with lock:
                    lock.wait_for(lambda: len(messages) > seen, timeout=20)
                    new = messages[seen:]
                    seen = len(messages)
                for m in new:
                    if m["topic"] == topic:
                        write(m)
                if not new:
                    write({"id": secrets.token_hex(6), "time": int(time.time()), "event": "keepalive", "topic": topic})
        except (BrokenPipeError, ConnectionResetError):
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()

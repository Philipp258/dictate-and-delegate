#!/usr/bin/env python3
"""Jev's template choice on labelled dictations, with real money (about $0.001 per run on your own
OpenRouter key).

Asks Jev (POST /api/alpha/decisions) exactly what the app asks after a dictation: only which saved
template it names, read from app/src/main/java/app/driftdictation/Jev.java (since 3.7.0 Jev never
starts Refine or sends to the chief; the user taps). Each dictation is labelled with the template it
names ("" for none). Prints how many were right and writes a Markdown report.

  set -a; . .tools/openrouter.env; set +a   # OPENROUTER_API_KEY
  scripts/qa/jev-check.py qa-out/jev.md
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = os.environ.get("OPENROUTER_DECISIONS", "https://openrouter.ai/api/alpha/decisions")
JEV = os.path.join(ROOT, "app/src/main/java/app/driftdictation/Jev.java")
TEMPLATES = ["Apartment application", "Weekly update", "Absage Termin"]

# (dictation, the template it names, "" for none).
LABELLED = [
    ("hi Marco can you bring two more boxes of tulips tomorrow, the yellow ones, thanks", ""),
    ("Call Jana tomorrow at ten, then send the invoice for September.", ""),
    ("reply to the landlord that the viewing on Saturday works for me, polite and short", ""),
    ("write an email to my landlord that the heating is broken, polite", ""),
    ("Henry, book a table for four", ""),
    ("Hallo Frau Schmidt, vielen Dank für Ihre Nachricht, ich melde mich morgen.", ""),
    ("use my apartment application for the two-room flat on Hauptstraße 5, the viewing is on Saturday", "Apartment application"),
    ("send my apartment application to the agent for the flat in Ehrenfeld, mention I work from home", "Apartment application"),
    ("fill in my weekly update: shipped the panel, next the tests", "Weekly update"),
    ("weekly update please, done the migration, blocked on review", "Weekly update"),
    ("schreib eine Absage für den Termin am Donnerstag, nimm meine Vorlage", "Absage Termin"),
    ("Absage für morgen um zehn, wie immer", "Absage Termin"),
    ("I'll write the weekly update later, remind me", ""),
]


def java_constant(name):
    """A String constant from Jev.java: its literals joined, like javac does."""
    code = open(JEV, encoding="utf-8").read()
    lit = r'"(?:[^"\\]|\\.)*"'
    block = re.search(r"\b" + name + r"\s*=\s*(" + lit + r"(?:\s*\+\s*" + lit + r")*)", code).group(1)
    return "".join(json.loads('"' + s + '"') for s in re.findall(r'"((?:[^"\\]|\\.)*)"', block))


def body(dictation):
    """Jev.body(dictation, TEMPLATES), as the app builds it."""
    options = {"none": java_constant("TEMPLATE_NONE")}
    for name in TEMPLATES:
        options[name] = java_constant("TEMPLATE_OPTION").replace("%s", name)
    return {"model": java_constant("MODEL"), "state": {"dictation": dictation},
            "questions": {"template": {"type": "choice", "instructions": java_constant("TEMPLATE"),
                                       "criteria": options}}}


def ask(dictation):
    req = urllib.request.Request(URL, json.dumps(body(dictation)).encode(), {
        "Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"],
        "Content-Type": "application/json", "X-Title": "Dictate & Delegate"})
    started = time.time()
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        r = {"error": e.code, "body": e.read().decode(errors="replace")[:300]}
    return r, time.time() - started


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda d: ask(d[0]), LABELLED))
    rows, cost, seconds, failed = [], 0.0, [], 0
    for (said, template), (r, s) in zip(LABELLED, results):
        a = r.get("answers")
        if not a:
            failed += 1
            rows.append((said, template, None, json.dumps(r)[:200]))
            continue
        cost += (r.get("usage") or {}).get("cost") or 0
        seconds.append(s)
        choice = a.get("template", {}).get("choice", "none")
        rows.append((said, template, "" if choice == "none" else choice, ""))
    ok = [r for r in rows if r[2] is not None]
    right = sum(r[1] == r[2] for r in ok)
    lines = ["# Jev check", "", "Model `%s`, %d dictations (%d failed), $%.6f in total, median %.2f s."
             % (java_constant("MODEL"), len(rows), failed, cost, sorted(seconds)[len(seconds) // 2] if seconds else 0), "",
             "## Template", "", "%d of %d right." % (right, len(ok)), "",
             "| Dictation | expected | Jev | |", "| --- | --- | --- | --- |"]
    for said, template, got, err in rows:
        if got is None:
            lines.append("| %s | %s | | ✗ %s |" % (said, template or "–", err))
            continue
        lines.append("| %s | %s | %s | %s |" % (said.replace("|", "\\|"), template or "–", got or "–", "✓" if got == template else "✗"))
    open(sys.argv[1], "w").write("\n".join(lines) + "\n")
    print("\n".join(lines[:12]))


if __name__ == "__main__":
    main()

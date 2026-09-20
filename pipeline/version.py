"""Stamp site/index.html and the tour fetch with a build id.

index.html itself is served with a short cache lifetime; everything it points
at is immutable for a given id, so a redeploy can never leave a browser mixing
a new app.js with an old tour.json.
"""
import hashlib
import os
import re
import sys

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")


def main():
    parts = []
    for f in ("app.js", "style.css", "data/tour.json"):
        p = os.path.join(SITE, f)
        if os.path.exists(p):
            parts.append(open(p, "rb").read())
    build = hashlib.sha1(b"".join(parts)).hexdigest()[:8]

    idx = os.path.join(SITE, "index.html")
    s = open(idx).read()
    s = re.sub(r'(href="style\.css)(\?v=[0-9a-f]+)?"', rf'\1?v={build}"', s)
    s = re.sub(r'(src="app\.js)(\?v=[0-9a-f]+)?"', rf'\1?v={build}"', s)
    open(idx, "w").write(s)

    app = os.path.join(SITE, "app.js")
    a = open(app).read()
    a = re.sub(r"const BUILD = '[^']*';", f"const BUILD = '{build}';", a)
    open(app, "w").write(a)
    print(f"build {build}")


main()

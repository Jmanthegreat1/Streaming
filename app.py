"""
Subtitle translation API — the backend the browser extension calls.

Exposes POST /translate  { "texts": [...], "source": "auto", "target": "en" }
returning          { "translations": [...] }

Designed to run on Render (gunicorn app:app) but also runs locally:
    pip install -r requirements.txt
    python app.py
"""

import os
from functools import lru_cache

from flask import Flask, request, jsonify
from flask_cors import CORS
from deep_translator import GoogleTranslator

app = Flask(__name__)
# The extension runs on arbitrary sites (kan.org.il, etc.), so allow any origin.
CORS(app)


@lru_cache(maxsize=10000)
def _translate_one(text, source, target):
    """Translate a single line. Cached so repeated subtitle lines are instant.

    A fresh GoogleTranslator per call on purpose — the object isn't thread-safe,
    and gunicorn may serve requests concurrently.
    """
    return GoogleTranslator(source=source, target=target).translate(text) or text


@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "subtitle-translate"})


@app.route("/translate", methods=["POST"])
def translate():
    data = request.get_json(silent=True) or {}

    texts = data.get("texts")
    if texts is None:
        single = data.get("text")
        texts = [single] if single is not None else []

    source = data.get("source") or "auto"
    target = data.get("target") or "en"

    results = []
    for raw in texts:
        line = (raw or "").strip()
        if not line:
            results.append("")
            continue
        try:
            results.append(_translate_one(line, source, target))
        except Exception:
            results.append(line)  # never fail a request over one bad line

    return jsonify({"translations": results})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

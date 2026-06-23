"""
Subtitle translation API — the backend the browser extension calls.

Endpoints
---------
POST /translate       { "texts": [...], "source": "auto", "target": "en" }
                   -> { "translations": [...] }

POST /ocr-translate   { "image": "data:image/png;base64,...", "source": "auto",
                        "target": "en", "lang": "heb" }
                   -> { "text": "<recognized>", "translation": "<translated>" }

Runs on Render via the bundled Dockerfile (which installs Tesseract + Hebrew).
Locally, point it at a Tesseract install with TESSERACT_CMD / TESSDATA_PREFIX.
"""

import os
import re
import base64
import binascii
from functools import lru_cache
from io import BytesIO

from flask import Flask, request, jsonify
from flask_cors import CORS
from deep_translator import GoogleTranslator
from PIL import Image, ImageChops, ImageFilter
import pytesseract

app = Flask(__name__)
CORS(app)  # the extension runs on arbitrary sites, so allow any origin

# Allow pointing at a local Tesseract during development (on Render it's on PATH).
_cmd = os.environ.get("TESSERACT_CMD")
if _cmd:
    pytesseract.pytesseract.tesseract_cmd = _cmd


@lru_cache(maxsize=10000)
def _translate_one(text, source, target):
    """Translate one line. Cached so repeated subtitle lines are instant.

    A fresh GoogleTranslator per call on purpose — it isn't thread-safe and
    gunicorn may serve requests concurrently.
    """
    return GoogleTranslator(source=source, target=target).translate(text) or text


def _fix_segment_punct(seg):
    """Normalize sentence punctuation in one segment: pick the end mark
    (? > ! > .) from whatever is present, strip ALL misplaced marks (the RTL
    scramble), and re-attach one at the end. Decimals (5.5) are protected."""
    t = (seg or "").strip()
    if not t:
        return ""
    inner = t[:-1]
    if not re.search(r"[?!]", inner) and not re.search(r"(?<!\d)\.(?!\d)", inner):
        return t  # already clean
    if "?" in t:
        end = "?"
    elif "!" in t:
        end = "!"
    elif re.search(r"(?<!\d)\.(?!\d)", t):
        end = "."
    else:
        end = ""
    body = re.sub(r"[?!]+", " ", t)
    body = re.sub(r"(?<!\d)\.+(?!\d)", " ", body)
    body = re.sub(r"\s+", " ", body).strip()
    return body + end if body else t


def _reorder_punct(s):
    """Fix punctuation across a whole line, handling each dialogue segment
    (split on ' - ') separately so multi-speaker lines come out right."""
    s = re.sub(r"^\s*\.\s*(?=[-–—])", "", s)  # stray period before a leading dash
    parts = re.split(r"(\s*[-–—]\s+)", s)
    out = [p if re.fullmatch(r"\s*[-–—]\s+", p or "") else _fix_segment_punct(p) for p in parts]
    return "".join(out).strip()


def translate_text(text, source, target):
    text = (text or "").strip()
    if not text:
        return ""
    try:
        return _translate_one(text, source, target)
    except Exception:
        return text


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
    return jsonify({"translations": [translate_text(t, source, target) for t in texts]})


def _decode_image(data_url):
    """Accept a data: URL or a bare base64 string and return a PIL image."""
    if "," in data_url and data_url.strip().startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    return Image.open(BytesIO(raw))


@app.route("/ocr-translate", methods=["POST"])
def ocr_translate():
    data = request.get_json(silent=True) or {}
    image = data.get("image")
    if not image:
        return jsonify({"error": "No image provided."}), 400

    source = data.get("source") or "auto"
    target = data.get("target") or "en"
    lang = data.get("lang") or "heb"
    psm = str(data.get("psm") or 6)

    try:
        img = _decode_image(image)
    except (binascii.Error, ValueError, OSError):
        return jsonify({"error": "Could not decode the image."}), 400

    # Subtitles are WHITE text over moving video. Keep only near-white pixels
    # (all channels high) as black-on-white — this isolates the text and drops
    # the (often colored) background that otherwise reads as random words.
    thresh = int(data.get("thresh") or 215)
    r, g, b = img.convert("RGB").split()
    band = lambda c: c.point(lambda p: 255 if p >= thresh else 0)
    mask = ImageChops.multiply(ImageChops.multiply(band(r), band(g)), band(b))
    img = ImageChops.invert(mask)  # black text on white
    img = img.filter(ImageFilter.MedianFilter(3))  # drop isolated specks (stray dots/dashes)
    if img.width < 900:
        factor = 900 / img.width
        img = img.resize((round(img.width * factor), round(img.height * factor)))

    # Single fast LSTM pass; image is already black-on-white.
    config = f"--oem 1 --psm {psm} -c tessedit_do_invert=0"
    try:
        raw = pytesseract.image_to_string(img, lang=lang, config=config)
    except pytesseract.TesseractError as e:
        return jsonify({"error": "OCR failed: " + str(e)}), 500

    text = " ".join(" ".join(ln.split()) for ln in raw.splitlines() if ln.strip())

    # Drop OCR noise: junk arrows, isolated symbol tokens, dash/dot runs.
    text = re.sub(r"[<>]", " ", text)
    text = re.sub(r"(?:^|\s)[|_~`^*¦•·=]+(?=\s|$)", " ", text)
    text = re.sub(r"(?:^|\s)[-–—.]{2,}(?=\s|$)", " ", text)  # runs like --- or ..
    text = re.sub(r"(?:^|\s)[.]{1,2}(?=\s|$)", " ", text)
    text = " ".join(text.split()).strip(" |_~`^*¦•·=")
    text = _reorder_punct(text)

    # Guard against OCR noise (specks, white shirts, clocks/numbers) becoming
    # random words: need a couple of Hebrew letters AND Hebrew must dominate.
    if lang.startswith(("heb", "iw")):
        heb = len(re.findall(r"[א-ת]", text))
        alnum = len(re.findall(r"[א-ת0-9A-Za-z]", text))
        if heb < 2 or heb < alnum * 0.6:
            return jsonify({"text": "", "translation": ""})

    translation = _reorder_punct(translate_text(text, source, target))
    return jsonify({"text": text, "translation": translation})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

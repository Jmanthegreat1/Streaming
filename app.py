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


def _end_mark(cluster):
    """The one end mark a punctuation cluster stands for: ... > ? > ! > . ;
    comma/colon-only clusters stand for nothing."""
    if re.fullmatch(r"\.{2,}", cluster):
        return "..."
    if "?" in cluster:
        return "?"
    if "!" in cluster:
        return "!"
    if "." in cluster:
        return "."
    return ""


def _descramble_heb_segment(seg):
    """Undo the RTL scramble in one OCR'd segment: marks glued to the FRONT of
    the line (or of a following word) belong at the end of the word before.
    Interior punctuation is left exactly where it is."""
    t = (seg or "").strip()
    if not t:
        return ""
    # A word's end-mark drifted onto the next word ("שלום ?מה") or floats at
    # the end. Dots are not touched here (decimal / ellipsis ambiguity).
    t = re.sub(r"(\S)\s+([?!]+)(?=\S)", r"\1\2 ", t)
    t = re.sub(r"(\S)\s+([?!]+)$", r"\1\2", t)
    m = re.match(r"^([?!.,:;]+)\s*(.*)$", t, flags=re.S)
    if m:
        rest = m.group(2).strip()
        if not rest:
            return ""  # a lone mark is noise, not a subtitle
        if not re.search(r"[?!.]$", rest):
            rest += _end_mark(m.group(1))
        t = rest
    return re.sub(r"\s+", " ", t).strip()


def _descramble_heb_punct(s):
    """Fix the RTL punctuation scramble across a whole line, handling each
    dialogue segment (split on ' - ') separately."""
    s = re.sub(r"^\s*\.\s*(?=[-–—])", "", s)  # stray period before a leading dash
    parts = re.split(r"(\s*[-–—]\s+)", s)
    out = [p if re.fullmatch(r"\s*[-–—]\s+", p or "") else _descramble_heb_segment(p) for p in parts]
    return "".join(out).strip()


def _decode_entities(s):
    """The free translate endpoints return HTML entities (&#39; for ')."""
    for k, v in (("&quot;", '"'), ("&apos;", "'"), ("&lt;", " "), ("&gt;", " "), ("&amp;", "&")):
        s = s.replace(k, v)
    def _chr(base):
        def sub(m):
            n = int(m.group(1), base)
            return chr(n) if 32 <= n < 0x110000 else " "
        return sub
    s = re.sub(r"&#(\d+);", _chr(10), s)
    s = re.sub(r"&#[xX]([0-9A-Fa-f]+);", _chr(16), s)
    return s


def _finalize_english(s):
    """Tidy the translated line WITHOUT restructuring it: decode HTML entities,
    drop junk symbols, move a leading mark cluster to the end where it belongs,
    fix spacing around marks, collapse repeats. Interior punctuation that the
    translator produced ("What? Let's go.") is never rearranged."""
    s = _decode_entities(s or "")
    s = re.sub(r"[<>#*|~=^_{}\[\]\\/@`\x00-\x1f\x7f]", " ", s)
    s = s.strip()
    m = re.match(r"^([?!.,:;]+)\s*(.*)$", s, flags=re.S)
    if m and not re.fullmatch(r"\.{2,}", m.group(1)):  # a leading "..." is a real continuation
        s = m.group(2).strip()
        if s and not re.search(r"[?!.]$", s):
            s += _end_mark(m.group(1))
    s = re.sub(r"\s+([,.;:?!])", r"\1", s)  # "Yes , no ." → "Yes, no."
    s = re.sub(r"([,;:?!])(?=[^\W\d_])", r"\1 ", s)  # mark glued to the next word
    s = re.sub(r"\?{2,}", "?", s)
    s = re.sub(r"!{2,}", "!", s)
    s = re.sub(r",{2,}", ",", s)
    s = re.sub(r"\.{4,}", "...", s)
    s = re.sub(r"(?<!\.)\.\.(?!\.)", ".", s)  # ".." is a typo; "..." is kept
    s = re.sub(r"\s+", " ", s).strip()
    return s if re.search(r"[^\W_]", s) else ""


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

    # Single fast LSTM pass; image is already black-on-white. The blacklist
    # stops Tesseract emitting junk glyphs (>, #, |…) in the first place.
    # NOTE: no backslash/quote/space in the blacklist — pytesseract shlex-splits this.
    config = f"--oem 1 --psm {psm} -c tessedit_do_invert=0 -c tessedit_char_blacklist=<>#*|~=_{{}}[]/@^"
    try:
        raw = pytesseract.image_to_string(img, lang=lang, config=config)
    except pytesseract.TesseractError as e:
        return jsonify({"error": "OCR failed: " + str(e)}), 500

    text = " ".join(" ".join(ln.split()) for ln in raw.splitlines() if ln.strip())

    # Keep only letters / digits / basic punctuation — drops junk symbols wholesale.
    text = re.sub(r"[^A-Za-zא-ת0-9\s.,?!'\"%:;\-]", " ", text)
    text = re.sub(r"(?:^|\s)[-–—.]{2,}(?=\s|$)", " ", text)  # runs like --- or ..
    text = re.sub(r"(?:^|\s)\.(?=\s|$)", " ", text)  # standalone dot
    text = " ".join(text.split())
    text = _descramble_heb_punct(text)

    # A real subtitle has an actual Hebrew WORD (3+ letters), several Hebrew
    # letters, or is a single compact word (כן / לא / מה?), and Hebrew dominates.
    # Rejects scene-noise junk like "ל 8 מ".
    if lang.startswith(("heb", "iw")):
        heb = len(re.findall(r"[א-ת]", text))
        alnum = len(re.findall(r"[א-ת0-9A-Za-z]", text))
        has_word = bool(re.search(r"[א-ת]{3,}", text))
        single_token = bool(re.fullmatch(r"[א-ת]{2,3}[?!.]?", text))
        if not single_token and ((not has_word and heb < 4) or heb < alnum * 0.55):
            return jsonify({"text": "", "translation": ""})

    translation = _finalize_english(translate_text(text, source, target))
    return jsonify({"text": text, "translation": translation})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)

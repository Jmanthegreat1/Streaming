FROM python:3.12-slim

# Tesseract OCR engine + the Hebrew language model.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-heb \
    && rm -rf /var/lib/apt/lists/*

# Swap Debian's fast Hebrew model for the accurate one (tessdata_best) — the
# same model the extension bundles for on-device OCR. Slower, far fewer misreads.
ADD https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main/heb.traineddata /usr/share/tesseract-ocr/5/tessdata/heb.traineddata
RUN chmod 644 /usr/share/tesseract-ocr/5/tessdata/heb.traineddata

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Hosts set $PORT (Render, Koyeb); default 7860 also matches Hugging Face Spaces.
ENV PORT=7860
EXPOSE 7860
# Threads matter: OCR shells out to tesseract and translation is network I/O,
# so 2×4 threads lets the extension's 6 parallel reads overlap instead of queuing.
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT} --timeout 120 --workers 2 --threads 4"]

FROM python:3.12-slim

# Tesseract OCR engine + the Hebrew language model.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-heb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Render provides $PORT; default to 10000 for local docker runs.
ENV PORT=10000
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT} --timeout 120 --workers 2"]

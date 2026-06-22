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

# Hosts set $PORT (Render, Koyeb); default 7860 also matches Hugging Face Spaces.
ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "gunicorn app:app --bind 0.0.0.0:${PORT} --timeout 120 --workers 2"]

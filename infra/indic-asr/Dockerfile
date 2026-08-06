FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

ENV HF_HOME=/root/.cache/huggingface
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD curl -f http://localhost:8001/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]

# The probe is throwaway, so the image is too: one stage, no build tooling, no cache
# tricks. What matters is that uvicorn is installed with its `standard` extras, because
# that is what brings the `websockets` implementation — without it the WebSocket half of
# the spike fails for a reason that has nothing to do with IAP, which is the one outcome
# a spike must not produce.
FROM python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Cloud Run hands the port in $PORT; 8080 is only the local default.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --ws websockets --proxy-headers --forwarded-allow-ips='*'"]

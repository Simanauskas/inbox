FROM python:3.12-slim
# faster-whisper 1.1.1 needs PyAV < 14 (av 16 removed an argument it uses)
RUN pip install --no-cache-dir faster-whisper==1.1.1 requests "av==13.1.0"

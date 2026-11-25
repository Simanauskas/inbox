# Reply suggestions service (server/suggest/suggest.py): Python + numpy for the memory search.
FROM python:3.12-slim
RUN pip install --no-cache-dir numpy==2.1.3
WORKDIR /app
CMD ["python", "/app/suggest.py", "--loop"]

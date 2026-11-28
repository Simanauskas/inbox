# People service (server/people/people.py): Python + a Postgres driver (reads Synapse's
# messages with a read-only database user).
FROM python:3.12-slim
RUN pip install --no-cache-dir "psycopg[binary]==3.2.3"
WORKDIR /app
CMD ["python", "/app/people.py", "--loop"]

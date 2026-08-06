#!/bin/sh
# Apply DB migrations, then start the server.
# Migrations run against DIRECT_DATABASE_URL (bypasses PgBouncer pooling).
set -e

echo "[entrypoint] applying database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy || {
  echo "[entrypoint] migrate deploy failed — is the database reachable?" >&2
  exit 1
}

echo "[entrypoint] starting Next.js..."
exec "$@"

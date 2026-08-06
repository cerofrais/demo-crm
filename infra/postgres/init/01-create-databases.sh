#!/bin/bash
# ============================================================================
# Trē Wellness CRM — Postgres bootstrap (runs once on first container start).
#
# Single Postgres service, THREE databases:
#   - CRM application db  ($CRM_DB_NAME owned by $CRM_DB_USER)
#   - Keycloak db         ($KC_DB_NAME  owned by $KC_DB_USER)
#   - Evolution API db    ($WA_DB_NAME  owned by $WA_DB_USER) — WhatsApp gateway
#
# The official postgres image executes every *.sh / *.sql in
# /docker-entrypoint-initdb.d on an EMPTY data directory. To re-run after the
# fact, wipe the volume:  docker compose down -v
# ============================================================================
set -euo pipefail

echo "[init] creating CRM, Keycloak and WhatsApp databases + roles..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-EOSQL
    -- ---- CRM application role + database ----
    DO \$\$
    BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${CRM_DB_USER}') THEN
          -- CREATEDB lets `prisma migrate dev` spin up its shadow database in dev.
          CREATE ROLE "${CRM_DB_USER}" LOGIN CREATEDB PASSWORD '${CRM_DB_PASSWORD}';
       END IF;
    END
    \$\$;

    SELECT 'CREATE DATABASE "${CRM_DB_NAME}" OWNER "${CRM_DB_USER}"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${CRM_DB_NAME}')\gexec

    GRANT ALL PRIVILEGES ON DATABASE "${CRM_DB_NAME}" TO "${CRM_DB_USER}";

    -- ---- Keycloak role + database ----
    DO \$\$
    BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${KC_DB_USER}') THEN
          CREATE ROLE "${KC_DB_USER}" LOGIN PASSWORD '${KC_DB_PASSWORD}';
       END IF;
    END
    \$\$;

    SELECT 'CREATE DATABASE "${KC_DB_NAME}" OWNER "${KC_DB_USER}"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${KC_DB_NAME}')\gexec

    GRANT ALL PRIVILEGES ON DATABASE "${KC_DB_NAME}" TO "${KC_DB_USER}";

    -- ---- Evolution API (WhatsApp) role + database ----
    DO \$\$
    BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${WA_DB_USER}') THEN
          CREATE ROLE "${WA_DB_USER}" LOGIN PASSWORD '${WA_DB_PASSWORD}';
       END IF;
    END
    \$\$;

    SELECT 'CREATE DATABASE "${WA_DB_NAME}" OWNER "${WA_DB_USER}"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${WA_DB_NAME}')\gexec

    GRANT ALL PRIVILEGES ON DATABASE "${WA_DB_NAME}" TO "${WA_DB_USER}";
EOSQL

# Ensure the CRM user owns the public schema in its own db (Prisma needs this).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${CRM_DB_NAME}" <<-EOSQL
    GRANT ALL ON SCHEMA public TO "${CRM_DB_USER}";
    ALTER SCHEMA public OWNER TO "${CRM_DB_USER}";
EOSQL

# Same for Evolution API — it runs its own migrations on startup.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${WA_DB_NAME}" <<-EOSQL
    GRANT ALL ON SCHEMA public TO "${WA_DB_USER}";
    ALTER SCHEMA public OWNER TO "${WA_DB_USER}";
EOSQL

echo "[init] done: databases '${CRM_DB_NAME}', '${KC_DB_NAME}' and '${WA_DB_NAME}' ready."

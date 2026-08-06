# =============================================================================
# Trē Wellness CRM — Next.js production image (multi-stage, standalone output).
# Build context is the repo root. Built by docker-compose service `nextjs`.
# =============================================================================

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, not
# read at container startup — must be passed as a build arg (docker-compose
# build.args), not just set in .env. Changing the value needs a rebuild, not
# just a restart. See docs/08-env-vars.md.
ARG NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC=30
ENV NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC=$NEXT_PUBLIC_LEADS_AUTOREFRESH_INTERVAL_SEC
# `build` runs `prisma generate && next build`
RUN npm run build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone server bundle + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma schema, migrations & engine so we can run migrate deploy at startup
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

COPY infra/docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]

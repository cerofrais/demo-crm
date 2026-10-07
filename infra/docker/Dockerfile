# =============================================================================
# Trē Wellness CRM — Next.js production image (multi-stage, standalone output).
# Build context is the repo root. Built by docker-compose service `nextjs`.
# =============================================================================

# ---- deps ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
# Prefer IPv4 and retry hard. The production host has no working IPv6 route
# (DNS still returns AAAA records, so npm's parallel fetches sat on dead v6
# connections until they hit `npm error code ETIMEDOUT` ~90s in and failed the
# whole build — reproducible even with --no-cache). Bandwidth is fine on v4;
# this just stops the resolver handing out an address that can't be reached,
# and rides out the occasional stall instead of aborting the image build.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

# ---- builder ----
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Same IPv4 preference as the deps stage — `npm run build` also reaches out
# (prisma engine fetch, next/font), so it can stall the same way.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
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
# Same IPv4 preference the build stages already use, and for the same reason —
# the hosts have no IPv6 default route while DNS still answers with AAAA. At
# RUNTIME this shows up as an intermittent bare `fetch failed` on outbound
# calls (Meta Graph, Plivo): undici picks whichever address the resolver
# happened to return first, so the same send succeeds or fails at random. A
# WhatsApp follow-up died this way on 2026-08-20 while the retry two minutes
# later went through.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

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

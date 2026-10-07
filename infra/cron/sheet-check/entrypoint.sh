#!/bin/sh
# sheet-check-cron — calls the CRM's lead sheet check once a day.
#
# The CRM decides whether a check is actually due (every N days, set on the
# Lead Sheet Check page), so this only has to be reliably daily. A plain
# "every 3 days" cron line can't do that: */3 in the day-of-month field
# restarts on the 1st, giving uneven gaps across month ends.
set -eu

if [ -z "${SHEET_CHECK_CRON_SECRET:-}" ]; then
  echo "sheet-check-cron: SHEET_CHECK_CRON_SECRET is not set — refusing to start" >&2
  exit 1
fi

# busybox crond starts jobs with a bare environment, so hand the job its
# settings through files rather than env vars. Readable by root only.
umask 077
mkdir -p /run/sheet-check
printf '%s' "$SHEET_CHECK_CRON_SECRET" > /run/sheet-check/secret
printf '%s' "${SHEET_CHECK_URL:-http://nextjs:3000/api/internal/sheet-check/tick}" > /run/sheet-check/url

# 03:30 UTC is 09:00 IST (no DST), which avoids needing tzdata in the image.
cat > /etc/crontabs/root <<CRON
30 3 * * * /bin/sh /opt/sheet-check/tick.sh >> /proc/1/fd/1 2>&1
CRON

echo "sheet-check-cron: will call $(cat /run/sheet-check/url) daily at 09:00 IST"
exec crond -f -l 6

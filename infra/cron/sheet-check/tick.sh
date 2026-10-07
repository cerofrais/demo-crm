#!/bin/sh
# One call to the CRM's tick endpoint. Also runnable by hand:
#   docker exec tre-sheet-check-cron sh /opt/sheet-check/tick.sh
URL=$(cat /run/sheet-check/url)
SECRET=$(cat /run/sheet-check/secret)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sheet-check: calling the CRM"
# Long timeout: a due check reads every sheet and may push leads.
if OUT=$(wget -q -O - -T 900 --header="X-Cron-Secret: $SECRET" --post-data="" "$URL" 2>&1); then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sheet-check: $OUT"
else
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sheet-check: call failed — $OUT"
fi

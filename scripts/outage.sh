#!/usr/bin/env bash
# Simulated outage, driven entirely by the app's own chaos header. Nothing is
# installed, nothing outside this project is touched, and no state persists:
# stop the script and the "incident" is over.
#
#   ./scripts/outage.sh            # 180s of failing checkouts
#   ./scripts/outage.sh 60 timeout # or: decline | timeout | error | slow
set -euo pipefail

DURATION_SECONDS="${1:-180}"
MODE="${2:-timeout}"
BASE="${BASE:-http://localhost:8000}"
# One tenant takes the hit, so you can watch a per-tenant dashboard do its job
# instead of everything going red at once.
TENANT="${TENANT:-tenant_initech}"

echo "outage: ${DURATION_SECONDS}s of mode=${MODE} for ${TENANT}"
echo "watch: Grafana > 00 - Stack health,  Prometheus > Alerts,  Loki > {tenant_id=\"${TENANT}\"}"

end=$((SECONDS + DURATION_SECONDS))
while [ "$SECONDS" -lt "$end" ]; do
  # Three concurrent checkouts per second, all carrying the chaos header.
  for _ in 1 2 3; do
    curl -s -o /dev/null -X POST "${BASE}/api/checkout" \
      -H 'content-type: application/json' \
      -H "x-tenant-id: ${TENANT}" \
      -H "x-chaos: ${MODE}" \
      -d "{\"customer\":{\"email\":\"outage-$RANDOM@example.com\",\"name\":\"Fake Buyer\"},\"card\":{\"number\":\"4242 4242 4242 4242\",\"exp\":\"11/29\",\"cvv\":\"123\"},\"items\":[{\"sku\":\"${TENANT}-SKU0001\",\"quantity\":1}]}" &
  done
  # Keep healthy traffic flowing from another tenant: a real incident is a mix,
  # and "is it only one tenant?" is the first question you ask.
  curl -s -o /dev/null -H "x-tenant-id: tenant_acme" "${BASE}/api/products?limit=3"
  sleep 1
done

echo "outage: stopped. Alerts resolve on their own within the rule's 'for' window."

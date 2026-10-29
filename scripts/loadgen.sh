#!/usr/bin/env bash
# Fake traffic for the learning stack. Nothing here touches a real system and
# every identity is fake.
#
#   ./scripts/loadgen.sh                 # 60s at ~5 req/s
#   ./scripts/loadgen.sh 300 12          # 300s at ~12 req/s
#   TENANTS="tenant_acme" ./scripts/loadgen.sh 60 3
set -euo pipefail

DURATION_SECONDS="${1:-60}"
RPS="${2:-5}"
BASE="${BASE:-http://localhost:8000}"
read -r -a TENANTS <<< "${TENANTS:-tenant_acme tenant_globex tenant_initech tenant_umbrella}"
SLEEP=$(awk "BEGIN{printf \"%.3f\", 1/$RPS}")

echo "loadgen: ${DURATION_SECONDS}s @ ~${RPS} req/s against ${BASE} for ${#TENANTS[@]} tenant(s)"

end=$((SECONDS + DURATION_SECONDS))
i=0
sent=0
while [ "$SECONDS" -lt "$end" ]; do
  tenant=${TENANTS[$((RANDOM % ${#TENANTS[@]}))]}
  line=$((1 + RANDOM % 40))
  sku="${tenant}-SKU$(printf '%04d' "$line")"
  buyer="fake.buyer$((RANDOM % 500))@example.com"
  req_id="loadgen-$(date +%s)-${i}"

  case $((i % 12)) in
    0 | 1 | 2)
      curl -s -o /dev/null -H "x-tenant-id: ${tenant}" -H "x-request-id: ${req_id}" "${BASE}/api/products?limit=5"
      ;;
    3 | 4 | 5 | 6)
      curl -s -o /dev/null -X POST "${BASE}/api/checkout" \
        -H 'content-type: application/json' -H "x-tenant-id: ${tenant}" -H "x-request-id: ${req_id}" \
        -d "{\"customer\":{\"email\":\"${buyer}\",\"name\":\"Fake Buyer\"},\"card\":{\"number\":\"4242 4242 4242 4242\",\"exp\":\"11/29\",\"cvv\":\"123\"},\"items\":[{\"sku\":\"${sku}\",\"quantity\":1}]}"
      ;;
    7)
      curl -s -o /dev/null -H "x-tenant-id: ${tenant}" "${BASE}/api/orders/1"
      ;;
    8)
      curl -s -o /dev/null -H "x-tenant-id: ${tenant}" "${BASE}/api/reports/tenant-summary"
      ;;
    9)
      # Deliberate tail-latency noise so p95 and p99 separate from the average.
      curl -s -o /dev/null -H "x-tenant-id: ${tenant}" "${BASE}/api/slow?ms=$((50 + RANDOM % 400))"
      ;;
    10)
      curl -s -o /dev/null -H "x-tenant-id: ${tenant}" "${BASE}/api/error/not-found"
      ;;
    11)
      curl -s -o /dev/null "${BASE}/readyz"
      ;;
  esac

  i=$((i + 1))
  sent=$((sent + 1))
  sleep "$SLEEP"
done

echo "loadgen: finished, ${sent} requests sent"

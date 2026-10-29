#!/bin/sh
# First boot inside a fresh container: the node_modules volume is empty, so
# install once from the lockfile. After that the volume is warm and start-up
# takes about a second.
#
# The test is on the binary we are about to run, not on a marker file. That
# matters here for a reason worth remembering: compose sets NODE_ENV=production
# for this app, and `npm ci` then silently skips devDependencies - and tsx lives
# in devDependencies. A marker file would have said "already installed" while
# the thing we needed was missing, and `npx tsx` quietly papered over it by
# downloading tsx from the network on every single container start.
set -e

if [ ! -x /app/node_modules/.bin/tsx ]; then
  echo "[entry] first boot: npm ci --include=dev (later boots skip this)"
  npm ci --include=dev --no-audit --no-fund
fi

exec "$@"

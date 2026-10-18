#!/bin/sh
# One container, two processes. FalkorDB is only ever spoken to over loopback, so it is not
# exposed and needs no password; the only thing listening on the outside is the Python process.
set -e

mkdir -p "${CRASHGRAPH_DATA:-/data}"

redis-server \
  --loadmodule /var/lib/falkordb/bin/falkordb.so \
  --bind 127.0.0.1 \
  --port 6379 \
  --dir "${CRASHGRAPH_DATA:-/data}" \
  --dbfilename crashgraph.db \
  --save 60 1 \
  --daemonize no &
DB_PID=$!

# If the database dies the container should die with it, rather than serving a console that
# cannot answer anything.
trap 'kill -TERM "$DB_PID" 2>/dev/null; exit 0' TERM INT

printf 'waiting for FalkorDB'
i=0
until redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then echo " — gave up"; exit 1; fi
  printf '.'
  sleep 0.5
done
echo " ready"

exec python server.py

#!/bin/sh
set -eu

curl -fsS -X POST \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${BACKEND_INTERNAL_URL}/api/internal/dispatch" >/proc/1/fd/1 2>/proc/1/fd/2 || true

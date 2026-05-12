#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-dist}"
OUTPUT_ROOT="${2:-artifacts}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUTPUT_ROOT}/static-scan-${TIMESTAMP}"
OUT_FILE="${OUT_DIR}/static-scan.txt"

mkdir -p "${OUT_DIR}"

echo "Trust Checker static scan" > "${OUT_FILE}"
echo "timestamp_utc: ${TIMESTAMP}" >> "${OUT_FILE}"
echo "target_dir: ${TARGET_DIR}" >> "${OUT_FILE}"
echo >> "${OUT_FILE}"

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "Target directory not found: ${TARGET_DIR}" | tee -a "${OUT_FILE}"
  exit 1
fi

PATTERN='fetch\(|axios\(|XMLHttpRequest|new\s+WebSocket\(|navigator\.sendBeacon\(|FormData\('

echo "search_pattern: ${PATTERN}" >> "${OUT_FILE}"
echo >> "${OUT_FILE}"

echo "=== Matches ===" >> "${OUT_FILE}"
if command -v rg >/dev/null 2>&1; then
  rg -n --no-heading --glob '!**/*.map' --glob '!**/*.min.*' "${PATTERN}" "${TARGET_DIR}" >> "${OUT_FILE}" || true
  MATCH_COUNT="$(rg -n --no-heading --glob '!**/*.map' --glob '!**/*.min.*' "${PATTERN}" "${TARGET_DIR}" | wc -l | tr -d ' ')"
else
  grep -RInE --exclude='*.map' --exclude='*.min.js' --exclude='*.min.css' "${PATTERN}" "${TARGET_DIR}" >> "${OUT_FILE}" || true
  MATCH_COUNT="$(grep -RInE --exclude='*.map' --exclude='*.min.js' --exclude='*.min.css' "${PATTERN}" "${TARGET_DIR}" | wc -l | tr -d ' ')"
fi

echo >> "${OUT_FILE}"
echo "=== Summary ===" >> "${OUT_FILE}"
echo "matches: ${MATCH_COUNT}" >> "${OUT_FILE}"

echo "Static scan report written to: ${OUT_FILE}"

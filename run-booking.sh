#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Archibus Booking Bot — Runner Script
#  Called by systemd timer or manually: bash run-booking.sh
#
#  Multi-instance mode: launches 3 parallel racers.
#  Each targets a different preferred room. First to BOOK
#  acquires the lock; others stand down gracefully.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment variables
set -a
source "$SCRIPT_DIR/.env"
set +a

# Ensure screenshots directory exists
mkdir -p "$SCRIPT_DIR/screenshots"

echo "═══════════════════════════════════════════════"
echo "  Archibus Booking Bot — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  Mode: 3 parallel instances (race to BOOK)"
echo "═══════════════════════════════════════════════"

# Launch 3 instances in parallel.
# BOOKING_INSTANCE tells each one which room is its primary target.
BOOKING_INSTANCE=1 node "$SCRIPT_DIR/book.mjs" &
PID1=$!
BOOKING_INSTANCE=2 node "$SCRIPT_DIR/book.mjs" &
PID2=$!
BOOKING_INSTANCE=3 node "$SCRIPT_DIR/book.mjs" &
PID3=$!

echo "[runner] Launched instances 1 (PID $PID1), 2 (PID $PID2), 3 (PID $PID3)"

# Wait for all 3 to finish. Capture exit codes.
EXIT1=0; EXIT2=0; EXIT3=0
wait $PID1 || EXIT1=$?
wait $PID2 || EXIT2=$?
wait $PID3 || EXIT3=$?

echo "[runner] Instance exit codes: 1=$EXIT1  2=$EXIT2  3=$EXIT3"

# Overall success if at least one instance exited cleanly (0)
if [ "$EXIT1" -eq 0 ] || [ "$EXIT2" -eq 0 ] || [ "$EXIT3" -eq 0 ]; then
    echo "[runner] At least one instance succeeded. Done."
    exit 0
else
    echo "[runner] All 3 instances failed!"
    exit 1
fi

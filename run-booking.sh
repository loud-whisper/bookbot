#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Archibus Booking Bot — Runner Script
#  Called by systemd timer or manually: bash run-booking.sh
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

# Run the booking bot
echo "═══════════════════════════════════════════════"
echo "  Archibus Booking Bot — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "═══════════════════════════════════════════════"

exec node "$SCRIPT_DIR/book.mjs"

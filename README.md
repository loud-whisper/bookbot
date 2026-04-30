# Archibus Booking Bot — Handoff Document

> **Last updated**: 2026-04-30 by AI assistant (Antigravity)
> **Location**: `/mnt/apps/BookingBot/`

---

## What This Does

Automatically books workspace desks in **Archibus** (Eptura/Horizant) **29 days in advance** using a deterministic **Playwright** browser automation script. No LLM/AI needed — it does the exact same clicks every time.

### Booking Schedule

| Timer fires on | Books for (today + 29d) | Building |
|---|---|---|
| **Sunday** | Monday | **A** — 270 Albert St, Floor 06, Room WS06-072 |
| **Wednesday** | Thursday | **A** — 270 Albert St, Floor 06, Room WS06-072 |
| **Thursday** | Friday | **B** — Place d'Orléans, Floor 02, Room D2-106 |

Timer fires at **11:58:00 AM ET** (no jitter) to pre-load browser/login/floor page, then strikes at exactly **12:00:05 PM** to select date and search for rooms.

---

## Architecture

```
/mnt/apps/BookingBot/
├── book.mjs           # Main Playwright script (instance-aware)
├── run-booking.sh     # Parallel Runner: launches 3 racers (Instance 1, 2, 3)
├── package.json       # Node.js deps (playwright ^1.52.0)
├── .env               # Credentials + Telegram config
├── screenshots/       # Bot saves screenshots (prefixed with i1, i2, i3)
└── /tmp/*.lock        # Atomic lock file to prevent double-booking
```

### Systemd Units (user-level)

- **`~/.config/systemd/user/booking-bot.service`** — oneshot service, runs `run-booking.sh`
- **`~/.config/systemd/user/booking-bot.timer`** — fires Sun/Wed/Thu 11:58:00, `Persistent=true`

### Key Design Decisions

1. **Native, not Docker** — moved from OpenClaw Docker container to native Node.js for simplicity and reliability.
2. **Systemd user timer** — survives reboots (linger enabled), auto-runs missed jobs (`Persistent=true`).
3. **Deterministic** — no LLM; same clicks every time. Fallback room logic if preferred room is taken.
4. **Parallel Racing** — launches 3 instances on Orleans days to target 3 different rooms simultaneously at 12:00:05.
5. **Atomic Locking** — uses a `/tmp/*.lock` file with `O_EXCL` to ensure only one instance actually clicks "BOOK".
6. **Telegram notifications** — sends status (✅ booked, 🧪 dry run, ❌ failed, ⏭️ no-op, 🤝 stood down) via bot API.

---

## Environment Variables (`.env`)

```env
BOOKING_USER=malhotrv
BOOKING_PASS=<password>
BOOKING_DRY_RUN=0        # 1=stop before BOOK click, 0=actually book
BOOKING_PANEL_OPEN_RETRIES=4       # how many times to try opening booking side panel
BOOKING_PANEL_OPEN_WAIT_MS=2000     # pause after each room-click attempt
BOOKING_PANEL_SIGNAL_TIMEOUT_MS=6000 # selector wait while checking panel visibility

TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat_id>
```

---

## How It Works (Step by Step)

1. Calculate target date: `today + 29 days`.
2. **Parallel Launch**: `run-booking.sh` forks 3 `node book.mjs` processes with `BOOKING_INSTANCE=1,2,3`.
3. **Pre-load Phase** (11:58:00 - 12:00:00):
   - Navigate to Archibus, log in.
   - Select building (Instance 1/2/3 each get a different primary room assigned).
   - Select floor, wait on the search page.
4. **Strike Phase** (12:00:05 PM):
   - All 3 instances inject date via `evaluate()` and click Search simultaneously.
5. **Coordination Phase**:
   - Each instance finds its target room and opens the panel.
   - **Critical**: Before clicking "BOOK", each instance tries to create `/tmp/booking-bot-YYYY-MM-DD.lock`.
   - Winner (first to create file) clicks "BOOK".
   - Losers see the lock file, log "Stood Down", and exit cleanly.
6. Verify "Workspace is successfully booked!" confirmation.
7. Send Telegram notification (Winner sends ✅, Losers send 🤝).
8. Clean up: Release lock file on success or failure.

---

## Incident + Fix (2026-03-04)

### Symptom
- Sunday runs often passed, but Wednesday/Thursday noon runs failed when the site was busy.
- Failure point: Step 8 timed out waiting for `"Booking space for"` after room selection.

### Root Cause
- Under heavy load, clicking room text did not reliably open the booking side panel.
- The script assumed a single panel header text (`Booking space for`) would always appear quickly.

### Fix Applied
- Added robust panel-open retries in `book.mjs`:
  - Tries opening the selected room panel multiple times (`BOOKING_PANEL_OPEN_RETRIES`).
  - Waits between attempts (`BOOKING_PANEL_OPEN_WAIT_MS`).
  - Accepts multiple panel signals (`Booking space for`, `Myself`, or `BOOK`) instead of one brittle selector.
- Updated Step 8 to wait/click `Myself` directly with longer timeout.
- Corrected building B fallback prefix typo from `D2-676` to `D2-` so fallback room search is not artificially restricted.

### Validation
- Manual real run completed on **2026-03-04** for target date **2026-04-02 (Thursday)**:
  - Status: `booked`
  - Building: `A`
  - Room: `WS06-072`
  - Confirmation detected and Telegram notification sent.

---

## Commands Cheat Sheet

```bash
# Manual run (real booking)
cd /mnt/wdc/BookingBot && bash run-booking.sh

# Dry run (stops before BOOK click)
cd /mnt/wdc/BookingBot && BOOKING_DRY_RUN=1 bash run-booking.sh

# Test specific date/building
cd /mnt/wdc/BookingBot && TARGET_DATE=2026-03-01 FORCE_BUILDING=A bash run-booking.sh

# Watch live (non-headless)
cd /mnt/wdc/BookingBot && source .env && HEADLESS=0 BOOKING_DRY_RUN=1 node book.mjs

# Check timer status
systemctl --user list-timers booking-bot.timer
systemctl --user status booking-bot.timer

# View logs
journalctl --user -u booking-bot.service -n 50

# Restart timer after editing units
systemctl --user daemon-reload
systemctl --user restart booking-bot.timer
```

---

## Systemd Setup (one-time, already done)

```bash
# Install deps
cd /mnt/wdc/BookingBot && npm install
npx playwright install --with-deps chromium

# Enable timer + linger
systemctl --user enable --now booking-bot.timer
loginctl enable-linger pchome
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| 502 Bad Gateway | Archibus/Azure is down. Retry later. Bot will auto-retry on next timer fire. |
| Login form timeout | Check `#logon-user-input` selector; SPA may take longer to render. |
| Post-login stuck | Increase `sleep(8000)` after login click. Check screenshots. |
| Room not found | Room may be booked; bot falls back to any room with same prefix. |
| Wrong building | Check `CONFIG.weekdayMap` in book.mjs; override with `FORCE_BUILDING=A\|B`. |
| Fails at Step 8 (`Booking space for` timeout) | Usually booking panel did not open. Use panel retry env vars above; review `booking_error.png` and logs for panel-open attempts. |
| Timer kills run before retries finish | Increase `TimeoutStartSec` in `~/.config/systemd/user/booking-bot.service`, then run `systemctl --user daemon-reload && systemctl --user restart booking-bot.timer`. |
| Date reverts to today after room selection | React date picker silently resets. Fixed in 2026-03-21 patch (5s init wait + post-selection re-verification). Check `booking_date_mismatch.png` screenshot. |
| Telegram not sending | Verify token and chat_id in `.env`; bot must have been messaged once. |
| Timer not firing | Check `systemctl --user list-timers`; ensure linger is on. |

---

## Terminal Blindness Fix (for AI agents)

Added early-return block to `~/.bashrc` for `ANTIGRAVITY_AGENT` env var to prevent VS Code shell integration escape codes from poisoning agent terminal output. Human terminals are unaffected.

---

## Incident + Fix (2026-03-11)

### Symptom
- Wednesday noon run failed. Bot was killed mid-run before it could complete retries.

### Root Causes
1. **`TimeoutStartSec=300`** — systemd killed the process at the 5-minute mark. With the 2-min retry delay + booking attempt time, attempt 2 barely started before SIGABRT.
2. **`roomRow.click()` used default 60s timeout** — after the first panel-open attempt, the DOM changed (room list shifted when panel partially opened). Retry hung 60s waiting for the element to be clickable again.
3. **`BOOKING_PANEL_SIGNAL_TIMEOUT_MS` default was 6s** — too short for the busy noon window on Wed/Thu.
4. **No state cleanup between panel retries** — partial panel state was left open, confusing subsequent clicks.

### Fixes Applied
- `TimeoutStartSec`: 300 → **1200** in `~/.config/systemd/user/booking-bot.service`
- `click()` in `clickRoomAction`: added `{ timeout: 8000 }` so retries fail fast instead of spinning 60s
- `BOOKING_PANEL_SIGNAL_TIMEOUT_MS` default: 6000 → **15000** in `book.mjs`
- Added `page.keyboard.press("Escape")` + 500ms sleep before each panel retry to clear partial state

### Validation
- Manual recovery run at 12:09 PM on 2026-03-11 for target date **2026-04-09 (Thursday)**:
  - Status: `booked`
  - Building: `A`
  - Room: `WS06-072`
  - Panel opened on first attempt. Telegram notification sent.

---

## Incident + Fix (2026-03-21)

### Symptom
- Thursday runs (booking Friday at Building B) failed consistently. Mar 19: all 3 attempts failed.
- Bot correctly filled the date field, verified it matched, but after room selection the date silently reverted to today's date.
- Summary showed `Date:March 19, 2026` instead of `April 17, 2026`.

### Root Cause
- The Mar 15 speed optimization reduced the pre-date-fill wait from several seconds to 1s.
- Archibus uses a React date picker that needs time to finish mounting after floor selection. Under noon server load, 1s was not enough — React accepted the typed value but internal state wasn't committed, so it reverted to default (today) when the booking modal opened.
- Building B was more affected than Building A due to different UI rendering paths.

### Fixes Applied
1. **`sleep(1000)` → `sleep(5000)`** before date field interaction (line ~395 in book.mjs)
2. **Added date re-verification after "Myself" click**: re-reads `#startDate` input value after room panel opens. If reverted, throws error to trigger retry loop with fresh search.

### Run History (past 2 weeks)
| Date | Day | Target | Building | Result |
|------|-----|--------|----------|--------|
| Mar 8 | Sun | Apr 6 (Mon) | A | ✅ Pass |
| Mar 11 | Wed | Apr 9 (Thu) | A | ❌ Fail — systemd timeout (fixed same day) |
| Mar 12 | Thu | Apr 10 (Fri) | B | ✅ Pass (fallback room) |
| Mar 15 | Sun | Apr 13 (Mon) | A | ❌ Fail — date reverted |
| Mar 18 | Wed | Apr 16 (Thu) | A | ✅ Pass |
| Mar 19 | Thu | Apr 17 (Fri) | B | ❌ Fail — all 3 attempts, date reverted |

---

## History

- **2026-02-14**: Created by AI assistant. Replaced OpenClaw AI automation with deterministic Playwright script.
- **2026-02-18**: Migrated from Docker to native Node.js at `/mnt/wdc/BookingBot/`. Set up systemd user timer. Applied terminal blindness fix to `~/.bashrc`. Ran missed booking for Thu Mar 19 → ✅ Room WS06-072 booked.
## Recent Updates
- **2026-02-25**: Implemented "11:59 Pre-load and 12:00:15 Strike" strategy to beat website lag. Added 4-tier fallback logic (Preferred -> Specific Backup -> Prefix -> Any Room). Set up 3x Master Retry loop if final BOOK button drops request.
- **2026-03-04**: Fixed busy-time booking modal flakiness by adding room-panel open retries and flexible panel detection (`Booking space for`/`Myself`/`BOOK`). Updated Step 8 selector strategy and corrected Building B fallback prefix to `D2-`. Verified with successful real booking for Thu 2026-04-02.
- **2026-03-11**: Fixed systemd timeout killing the process (`TimeoutStartSec` 300→1200), fixed panel-retry 60s hang (`click({timeout:8000})`), raised panel signal timeout default to 15s, added Escape key to clear partial state before retries. Manually recovered missed booking for Thu 2026-04-09 → ✅ WS06-072 booked.
- **2026-03-15**: Speed optimization — shaved ~20-25s off the post-noon critical path:
  1. **12:00:00 instead of 12:00:15**: Removed the 15s safety buffer. Bot now tight-polls with busy-wait for sub-millisecond precision at exactly noon (sleeps until 500ms before, then busy-loops). This is the biggest gain — 15 free seconds back.
  2. **Replaced `networkidle` waits with element-specific waits**: `networkidle` waited for ALL network traffic to stop (including other users hammering the site at noon). Now waits only for the specific next element needed (e.g., "Book workspaces" card visible, `#startDate` visible, room `li` visible). Faster on busy days AND more reliable.
  3. **Replaced fixed `sleep()` calls with `waitFor` on next element**: Removed ~12s of hardcoded `sleep(2000)`/`sleep(3000)` padding after room panel open, after "Myself" click, after BOOK click, and after floor select. Bot now proceeds the instant the next element is ready. The site-load safety net is preserved via Playwright's `waitFor` timeouts (up to 25s for slow loads) — so the bot is just as reliable on a slow site, it just doesn't waste time when the site responds fast.
  - **No changes to**: room fallback cascade, panel-open retry logic, retry loop, or any selectors. Only timing/wait strategy changed.
- **2026-03-21**: Fixed date picker silent revert bug. Two changes:
  1. **Increased pre-date-fill wait from 1s to 5s**: React date component needs time to fully initialize after floor selection, especially under noon load. The 1s wait (from Mar 15 optimization) was too aggressive — the component accepted input but reverted internally.
  2. **Added post-room-selection date re-verification**: After clicking "Myself", the bot now re-reads `#startDate` to catch silent reverts. If the date has changed back to today, it throws an error to trigger the retry loop (re-search with correct date on next attempt).
  - **Root cause**: Building B (Thursday→Friday) bookings failed on Mar 15 and Mar 19 because the Archibus React date picker reverted to today's date after room panel interaction. The confirmation summary showed `Date:March 19, 2026` instead of `April 17, 2026`. Building A was less affected due to different UI timing characteristics.
  - **Affected runs**: Mar 15 (Sun, Bldg A), Mar 19 (Thu, Bldg B — all 3 attempts failed).
- **2026-04-01**: Discovered duplicate booking bot running on Fedora workstation. Both N5 and Fedora had identical timers firing at ~11:59 AM for the same Archibus account (`malhotrv`). Fedora ran first (12:03 PM, booked WS06-072 ✅), N5 ran 4 min later (12:07 PM, room already taken, all 3 attempts failed ❌). **Fix:** Disabled Fedora's booking-bot.timer. N5 is now the sole instance (24/7 uptime machine).

### Run History (continued)
| Date | Day | Target | Building | Result |
|------|-----|--------|----------|--------|
| Mar 22 | Sun | Apr 20 (Mon) | A | — |
| Mar 26 | Wed | Apr 24 (Thu) | A | — |
| Mar 27 | Thu | Apr 25 (Fri) | B | — |
| Apr 30 | Thu | May 29 (Fri) | B | ❌ Attempt 1: date mismatch (wrong summary date) / ✅ Attempt 2: booked D2-120 (fallback — D2-106 already gone) |

---

## Incident + Fix (2026-04-30)

### Symptoms
- Orleans (Building B) consistently misses preferred room D2-106 and fallback D2-144.
- Attempt 1 always fails with summary date mismatch.
- Attempt 2 succeeds but gets a random leftover room (D2-120, D2-190) because preferred rooms are taken by 12:03 PM.

### Root Causes Found

**1. Pre-load timing logic was in the wrong place.** The noon-wait code sat after Steps 1-4 (login + navigate to floor). The intent was: start at 11:59, pre-load, wait until noon. But under SPA load, login alone takes 8-15s, so the bot was not reaching the floor page until 12:00:15+ — the noon-wait was already expired and provided zero benefit.

**2. Duplicate `fallbackRoom` key silently dropped D2-144.** Lines 42-43 both assigned `fallbackRoom:`. JavaScript silently kept only the last value (`D2-146`), so D2-144 was never tried.

**3. RandomizedDelaySec=5 on the timer added unpredictability.** Combined with SPA load time, the bot could start as late as 11:59:05 and not reach the floor page until 12:00:20+.

**4. sleep(10000) wasted 10s.** After reaching the floor page, the bot waited 10 full seconds "for React to initialize" — in a race for rooms, that is an eternity.

**5. evaluate() was fallback, not primary.** The slower `pressSequentially` (100ms/char = ~1s for the full date) was tried first, with `evaluate()` only as backup. Now reversed.

### Fixes Applied (2026-04-30)

1. **Two-phase architecture**: Bot pre-loads everything at 11:58 and sits idle until **12:00:05 PM** (strike time).
2. **Parallel Racing**: Launches 3 instances (1, 2, 3) to claim different rooms (106, 144, 146) at the same millisecond.
3. **Fixed `fallbackRooms` array**: Changed to `fallbackRooms: ["D2-144", "D2-146", "D2-768"]`.
4. **Timer changed to 11:58:00, RandomizedDelaySec=0**: Deterministic start.
5. **evaluate() date injection**: Instant React state setting instead of slow typing.
6. **In-session date recovery**: Re-sets date and re-searches if the SPA reverts the date field, without restarting the browser.

### Troubleshooting Multi-Instance
- **Lock Files**: If the bot says "Lock already held", check `/tmp/booking-bot-YYYY-MM-DD.lock`. Delete it if a previous run crashed and left it behind.
- **Instance Logs**: Look for `[bot][i1]`, `[bot][i2]`, or `[bot][i3]` in the logs to see which racer did what.
- **Race Results**: It is normal to see one ✅ and two 🤝 (stood down) on successful days.

### Expected Outcome (Orleans)
- Instance 1 gets D2-106.
- If D2-106 is gone, Instance 2 gets D2-144.
- If both gone, Instance 3 gets D2-146.
- All three act as safety nets for each other.

---

## Incident + Fix (2026-04-12)

### Symptoms
- **Apr 9 (Wed)**: All 3 attempts failed with timeout waiting for BOOK confirmation.
- **Apr 12 (Sat)**: Attempt 1 failed (summary showed wrong date); Attempt 2 failed (blank page); Attempt 3 succeeded.
- **Pattern**: First two attempts consistently fail, third attempt passes.

### Root Causes Found

**1. Summary date detection fails under noon load (Attempt 1 on Apr 12)**
- The SPA initially shows today's date in the summary panel, not the target date. Takes ~15-20s to update under noon load.
- Old code used rigid selectors (`[role='dialog']`, `.wp-panel`, `.panel-content`) that don't match the actual booking summary card.
- The date verification check failed immediately, not waiting for the SPA to finish rendering.

**2. Blank page incorrectly treated as "already logged in" (Attempt 2 on Apr 12)**
- Screenshot showed completely blank page with only "Contact the Archibus team" button.
- Old code checked only `title.includes("Workplace") && !title.includes("log in")` — title matched, so bot assumed it was on the building list.
- Bot then wasted 60s trying to click a building that didn't exist, failing with timeout.

**3. BOOK confirmation timeout too short (Apr 9, all 3 attempts)**
- Server was slow under Wed noon load. 45s timeout was insufficient.
- By Attempt 3 (~6 min after noon), server load had dropped and confirmation succeeded.

### Fixes Applied (2026-04-12)

**1. Added polling loop for summary date verification** (book.mjs, lines 549-570)
   - Instead of single check, now polls up to 5 times (4s apart = up to 20s total).
   - Broadly searches all "Date:" parent elements instead of using rigid selectors.
   - Logs what dates it finds for debugging.
   - Variable `dateVerified` replaces string `.includes()` check.

**2. Added blank-page detection and recovery** (book.mjs, lines 268-306)
   - Now checks for actual building-list content in page body ("Search for a building", "Book workspaces", building search text).
   - If page is blank/broken, forces fresh navigation to login page and logs in again **within the same attempt** (doesn't waste an attempt).
   - Prevents silent wait-timeout on dead pages.

**3. Increased BOOK confirmation timeout from 45s to 90s** (book.mjs, lines 610-612)
   - Handles slow server days.

### Expected Outcome
- **Attempt 1** should now succeed in most cases (polling waits for correct date, detects blank pages).
- **Attempt 2** should recover from page load issues instead of failing.
- **Attempt 3** remains reliable fallback (server load has dropped by then).
- Overall: bookings should succeed on first attempt, eliminating the "2 fails → 1 success" pattern.

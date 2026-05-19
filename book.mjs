#!/usr/bin/env node
/**
 * Archibus Workspace Booking Bot
 *
 * Deterministic Playwright script — no LLM needed.
 * Runs daily via timer, calculates target_date = today + 29d,
 * picks the correct building/floor/room, and submits the booking.
 *
 * Multi-instance coordination:
 * - Each instance writes its live status to /tmp/booking-bot-{date}-i{N}.status
 * - The winning instance writes /tmp/booking-bot-{date}.done on confirmation
 * - All instances poll for the done file every 200ms and stand down instantly
 */

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOT_DIR = join(__dirname, "screenshots");

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
    baseUrl: "https://pathfinder.horizantsolutions.com/archibus/schema/ab-products/essential/workplace/index.html",
    bookingUrl:
        "https://pathfinder.horizantsolutions.com/archibus/schema/ab-products/essential/workplace/index.html?taskInfo=%7B%22activityId%22%3A%22AbSpaceHotelling%22%2C%22processId%22%3A%22Bookings%22%2C%22taskId%22%3A%22Create+and+Review+Bookings%22%7D",

    user: process.env.BOOKING_USER,
    pass: process.env.BOOKING_PASS,
    dryRun: (process.env.BOOKING_DRY_RUN ?? "1") === "1",
    instance: parseInt(process.env.BOOKING_INSTANCE ?? "1", 10),

    // Each instance races for its own dedicated primary room.
    // Instance 1 → D2-106, Instance 2 → D2-146, Instance 3 → D2-134
    // All share the same fallbackRooms if their primary is unavailable.
    instanceRooms: {
        B: { 1: "D2-106", 2: "D2-146", 3: "D2-134" },
        A: { 1: "WS06-072", 2: "WS06-072", 3: "WS06-072" },
    },

    buildings: {
        A: {
            name: "The New Two Seventy Building 270 Albert Street (08422)",
            searchText: "Two Seventy",
            floor: "06",
            room: "WS06-072",
            fallbackRooms: ["WS06-052"],
        },
        B: {
            name: "Place d'Orleans Shopping Centre 110 Place d'Orleans Drive (11832)",
            searchText: "Orleans",
            floor: "02",
            room: "D2-106",
            // Only approved rooms. No wildcard fallback — unknown rooms are never booked.
            fallbackRooms: ["D2-144", "D2-768", "D2-190-4"],
        },
    },

    // target weekday → building key  (0=Sun … 6=Sat)
    // Mon(1)=A, Tue(2)=B, Thu(4)=A, Fri(5)=B
    weekdayMap: { 1: "A", 2: "B", 4: "A", 5: "B" },

    timeoutMs: 60_000,
    panelOpenRetries: parseInt(process.env.BOOKING_PANEL_OPEN_RETRIES ?? "4", 10),
    panelOpenWaitMs: parseInt(process.env.BOOKING_PANEL_OPEN_WAIT_MS ?? "2000", 10),
    panelSignalTimeoutMs: parseInt(process.env.BOOKING_PANEL_SIGNAL_TIMEOUT_MS ?? "15000", 10),

    maxRetries: parseInt(process.env.BOOKING_MAX_RETRIES ?? "3", 10),
    retryDelayMs: parseInt(process.env.BOOKING_RETRY_DELAY_MS ?? "120000", 10),
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function fmtISO(d) {
    return d.toISOString().slice(0, 10);
}

function fmtDate(d) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
}

function weekdayName(d) {
    return d.toLocaleDateString("en-US", { weekday: "long" });
}

function fmtLongDate(d) {
    return d.toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric",
        timeZone: "America/New_York",
    });
}

function screenshotPath(name) {
    return join(SCREENSHOT_DIR, name);
}

function targetDate() {
    if (process.env.TARGET_DATE) {
        const [y, m, d] = process.env.TARGET_DATE.split("-").map(Number);
        return new Date(y, m - 1, d, 12, 0, 0, 0);
    }
    const d = new Date();
    d.setDate(d.getDate() + 29);
    return d;
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ─── Lock File ──────────────────────────────────────────────────────────────
function lockPath(d) {
    return `/tmp/booking-bot-${fmtISO(d)}.lock`;
}

function acquireLock(d, instance, room) {
    const path = lockPath(d);
    try {
        const fd = fs.openSync(path, "wx");
        fs.writeSync(fd, JSON.stringify({ instance, room, timestamp: new Date().toISOString() }));
        fs.closeSync(fd);
        console.log(`[bot][i${instance}] Lock acquired for ${room}`);
        return { acquired: true };
    } catch (err) {
        if (err.code === "EEXIST") {
            try {
                const data = JSON.parse(fs.readFileSync(path, "utf8"));
                console.log(`[bot][i${instance}] Lock held by i${data.instance} for ${data.room} — standing down`);
                return { acquired: false, winner: data };
            } catch {
                return { acquired: false, winner: null };
            }
        }
        throw err;
    }
}

function releaseLock(d) {
    try { fs.unlinkSync(lockPath(d)); } catch { /* ignore */ }
}

// ─── Inter-instance Communication ───────────────────────────────────────────
// Each instance owns its own status file — no write contention.
// The done file is written once by the winner and signals all others to stop.

function statusFilePath(d, inst) {
    return `/tmp/booking-bot-${fmtISO(d)}-i${inst}.status`;
}

function doneFilePath(d) {
    return `/tmp/booking-bot-${fmtISO(d)}.done`;
}

function writeStatus(d, inst, status) {
    try {
        fs.writeFileSync(statusFilePath(d, inst), status);
        // Also log sibling statuses so journalctl shows the full picture
        const siblings = {};
        for (let i = 1; i <= 3; i++) {
            if (i === inst) continue;
            try { siblings[`i${i}`] = fs.readFileSync(statusFilePath(d, i), "utf8").trim(); }
            catch { siblings[`i${i}`] = "-"; }
        }
        const siblingsStr = Object.entries(siblings).map(([k, v]) => `${k}:${v}`).join(" | ");
        console.log(`[bot][i${inst}] ▶ ${status}  (${siblingsStr})`);
    } catch { /* /tmp write failure is non-fatal */ }
}

function declareDone(d, inst, room) {
    try {
        fs.writeFileSync(doneFilePath(d), JSON.stringify({
            instance: inst, room, ts: new Date().toISOString(),
        }));
        console.log(`[bot][i${inst}] ✅ Done file written — signalling siblings to stand down`);
    } catch { /* non-fatal */ }
}

function checkDone(d, myInst) {
    try {
        const data = JSON.parse(fs.readFileSync(doneFilePath(d), "utf8"));
        if (data.instance !== myInst) return data; // another instance won
    } catch { /* file not there yet */ }
    return null;
}

// ─── Stand-down Error ────────────────────────────────────────────────────────
class StandDownError extends Error {
    constructor(msg) { super(msg); this.name = "StandDownError"; }
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
        if (!resp.ok) console.error(`[telegram] HTTP ${resp.status}: ${await resp.text()}`);
        else console.log("[bot] Telegram notification sent");
    } catch (err) {
        console.error(`[telegram] Failed: ${err.message}`);
    }
}

const STATUS_EMOJI = {
    booked: "✅", dry_run_pre_submit: "🧪", no_op: "⏭️", failed: "❌",
    already_exists: "📌", stood_down: "🤝",
};

async function result(status, target, building, details) {
    const out = {
        status,
        target_date: fmtISO(target),
        weekday: weekdayName(target),
        building: building ?? "none",
        details,
        dry_run: CONFIG.dryRun,
        timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(out, null, 2));
    const emoji = STATUS_EMOJI[status] ?? "ℹ️";
    const msg = [
        `${emoji} *Archibus Booking Bot*`, ``,
        `Status: \`${status}\``,
        `Date: ${fmtISO(target)} (${weekdayName(target)})`,
        `Building: ${building ?? "none"}`,
        `Details: ${details}`,
        `Dry run: ${CONFIG.dryRun}`,
    ].join("\n");
    await sendTelegram(msg);
    return out;
}

// ─── Panel helpers ───────────────────────────────────────────────────────────
async function clickRoomAction(roomRow, roomLabel) {
    const actionBtn = roomRow
        .locator("button")
        .filter({ hasText: /workpoint-workstation/i })
        .first();
    if (await actionBtn.isVisible().catch(() => false)) {
        await actionBtn.click();
        console.log(`[bot] Opened booking panel via action button for ${roomLabel}`);
        return;
    }
    await roomRow.click({ timeout: 8000 });
    console.log(`[bot] Opened booking panel via row click for ${roomLabel}`);
}

async function bookingPanelIsVisible(page) {
    const signals = [
        page.getByText(/booking space for/i).first(),
        page.getByText(/myself/i).first(),
        page.locator("button:has-text('BOOK')").first(),
    ];
    for (const s of signals) {
        if (await s.isVisible().catch(() => false)) return true;
    }
    return false;
}

async function openBookingPanelWithRetries(page, roomRow, roomLabel, abortCheck) {
    for (let i = 1; i <= CONFIG.panelOpenRetries; i++) {
        abortCheck?.();
        await clickRoomAction(roomRow, roomLabel);
        await sleep(CONFIG.panelOpenWaitMs);
        abortCheck?.();

        if (await bookingPanelIsVisible(page)) return;

        await page
            .waitForSelector("text=Booking space for", { timeout: CONFIG.panelSignalTimeoutMs })
            .then(() => true)
            .catch(() => false);

        if (await bookingPanelIsVisible(page)) return;
        console.log(`[bot] Booking panel not yet open for ${roomLabel} (attempt ${i}/${CONFIG.panelOpenRetries})`);
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(500);
    }
    throw new Error(`Booking panel did not open for ${roomLabel} after ${CONFIG.panelOpenRetries} attempts`);
}

// ─── Booking Attempt ─────────────────────────────────────────────────────────
async function attemptBooking() {
    if (!CONFIG.user || !CONFIG.pass) {
        await result("failed", targetDate(), null, "BOOKING_USER or BOOKING_PASS not set");
        process.exit(1);
    }

    const target = targetDate();
    const instance = CONFIG.instance;
    const dow = target.getDay();
    const bldgKey = process.env.FORCE_BUILDING || CONFIG.weekdayMap[dow];

    if (!bldgKey) {
        await result("no_op", target, null, `No booking policy for ${weekdayName(target)}`);
        process.exit(0);
    }

    // ── Abort / sleep helpers (closures over target + instance) ──────────────
    function abort() {
        const done = checkDone(target, instance);
        if (done) {
            writeStatus(target, instance, `stood_down:won_by_i${done.instance}:${done.room}`);
            throw new StandDownError(`Instance ${done.instance} booked ${done.room} — standing down`);
        }
    }

    async function abortableSleep(ms) {
        const tick = 200;
        let elapsed = 0;
        while (elapsed < ms) {
            const chunk = Math.min(tick, ms - elapsed);
            await new Promise(r => setTimeout(r, chunk));
            elapsed += chunk;
            abort();
        }
    }

    // ── Room assignment ───────────────────────────────────────────────────────
    const bldg = { ...CONFIG.buildings[bldgKey] };
    const instancePrimary = CONFIG.instanceRooms[bldgKey]?.[instance];
    if (instancePrimary && instancePrimary !== bldg.room) {
        const originalPrimary = bldg.room;
        bldg.room = instancePrimary;
        bldg.fallbackRooms = [
            originalPrimary,
            ...(bldg.fallbackRooms ?? []).filter(r => r !== instancePrimary),
        ];
    }

    writeStatus(target, instance, `started:primary=${bldg.room}`);
    console.log(`[bot][i${instance}] Booking ${fmtISO(target)} (${weekdayName(target)}) → Building ${bldgKey}: ${bldg.name}`);
    console.log(`[bot][i${instance}] Floor ${bldg.floor}, primary room ${bldg.room}, dry_run=${CONFIG.dryRun}`);

    abort(); // bail early if a sibling already won before we even launch

    const headless = (process.env.HEADLESS ?? "1") !== "0";
    const browser = await chromium.launch({
        headless,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        slowMo: headless ? 0 : 500,
    });
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        timezoneId: "America/New_York",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.timeoutMs);

    try {
        // ── Step 1: Navigate & Login ──────────────────────────────────────────
        writeStatus(target, instance, "navigating");
        console.log("[bot] Step 1: Navigating to Archibus login…");
        await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded" });
        await abortableSleep(5000);

        await page.screenshot({ path: screenshotPath("step1a_after_load.png"), fullPage: true });
        console.log(`[bot] Page title: ${await page.title()}`);

        const loginForm = await page.waitForSelector("#logon-user-input", { timeout: 30_000 }).catch(() => null);

        if (!loginForm) {
            console.log("[bot] No login form — checking if already logged in…");
            await page.screenshot({ path: screenshotPath("step1b_no_login_form.png"), fullPage: true });
            const bodyText = await page.textContent("body").catch(() => "");
            const hasBuildingContent = bodyText.includes("Search for a building") ||
                bodyText.includes("Select a building") ||
                bodyText.includes("Book workspaces") ||
                bodyText.includes(bldg.searchText);

            if (hasBuildingContent) {
                console.log("[bot] Already logged in, building list visible");
            } else {
                console.log("[bot] Bad page state — forcing fresh navigation…");
                await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded" });
                await abortableSleep(5000);
                const retryForm = await page.waitForSelector("#logon-user-input", { timeout: 30_000 }).catch(() => null);
                if (!retryForm) throw new Error(`Cannot reach login page after retry. Title: ${await page.title()}`);
                await page.fill("#logon-user-input", CONFIG.user);
                await page.fill("#logon-password-input", CONFIG.pass);
                await Promise.all([
                    page.waitForResponse(r => r.url().includes("archibus") && r.status() === 200, { timeout: 30_000 }).catch(() => null),
                    page.getByRole("button", { name: /log\s*in/i }).click(),
                ]);
                await abortableSleep(8000);
            }
        } else {
            await page.fill("#logon-user-input", CONFIG.user);
            await page.fill("#logon-password-input", CONFIG.pass);
            await page.screenshot({ path: screenshotPath("step1c_creds_filled.png"), fullPage: true });
            await Promise.all([
                page.waitForResponse(r => r.url().includes("archibus") && r.status() === 200, { timeout: 30_000 }).catch(() => null),
                page.getByRole("button", { name: /log\s*in/i }).click(),
            ]);
            await abortableSleep(8000);
            await page.screenshot({ path: screenshotPath("step1d_after_login_click.png"), fullPage: true });

            const pageText = await page.textContent("body").catch(() => "");
            if (pageText.includes("Invalid") || pageText.includes("incorrect") || pageText.includes("failed")) {
                await result("failed", target, bldgKey, "Login failed — invalid credentials");
                await browser.close();
                process.exit(1);
            } else if (!pageText.includes("Search for a building") && !pageText.includes("Workplace")) {
                await abortableSleep(10_000);
            }
        }

        writeStatus(target, instance, "logged_in");
        abort();
        console.log("[bot] Step 1 complete");

        // ── Step 2: Select Building ───────────────────────────────────────────
        console.log(`[bot] Step 2: Selecting building ${bldgKey}…`);
        const buildingLink = page.locator(`text=${bldg.name}`).first();
        if (await buildingLink.isVisible().catch(() => false)) {
            await buildingLink.click();
        } else {
            const searchInput = page.locator('input[placeholder*="Search for a building"]');
            if (await searchInput.isVisible().catch(() => false)) {
                await searchInput.fill(bldg.searchText);
                await abortableSleep(1500);
            }
            await page.locator(`text=${bldg.name}`).first().click();
        }
        await page.locator("text=Book workspaces").first().waitFor({ state: "visible", timeout: 30_000 });

        abort();

        // ── Step 3: Book workspaces ───────────────────────────────────────────
        console.log("[bot] Step 3: Opening 'Book workspaces'…");
        await page.locator("text=Book workspaces").first().click();

        // ── Step 4: Select Floor ──────────────────────────────────────────────
        console.log(`[bot] Step 4: Selecting floor ${bldg.floor}…`);
        await page.waitForSelector("text=Workspace booking", { timeout: 20_000 });
        const floorLink = page.locator(`a[aria-label*="Select floor ${bldg.floor}"]`).first();
        if (await floorLink.isVisible().catch(() => false)) {
            await floorLink.click();
        } else {
            await page.locator(`text="${bldg.floor}"`).first().click();
        }
        await page.locator("#startDate").waitFor({ state: "visible", timeout: 20_000 });

        // Prime the date immediately while the React component is fresh.
        // fill() silently fails if the field sits idle for ~100s — React goes stale.
        {
            const di = page.locator("#startDate");
            await di.click();
            await abortableSleep(200);
            await di.fill(fmtDate(target));
            await di.press("Tab");
            await abortableSleep(500);
            const primed = await di.inputValue().catch(() => "");
            if (primed !== fmtDate(target)) {
                const digitsOnly = fmtDate(target).replace(/\//g, "");
                await di.click();
                await page.keyboard.press("Control+a");
                await abortableSleep(100);
                await page.keyboard.type(digitsOnly, { delay: 80 });
                await di.press("Tab");
                await abortableSleep(800);
            }
            const primedFinal = await di.inputValue().catch(() => "");
            console.log(`[bot] Date primed: ${primedFinal}`);
        }

        writeStatus(target, instance, "floor_loaded");
        abort();

        // ── Wait for strike time ──────────────────────────────────────────────
        const now = new Date();
        const strikeTime = new Date();
        strikeTime.setHours(12, 0, 5, 0);
        const msToWait = strikeTime.getTime() - now.getTime();

        if (msToWait > 0) {
            writeStatus(target, instance, `waiting_strike:${Math.round(msToWait / 1000)}s`);
            console.log(`[bot][i${instance}] Pre-loaded. Waiting ${Math.round(msToWait / 1000)}s until 12:00:05…`);
            if (msToWait > 600) await abortableSleep(msToWait - 600);
            while (Date.now() < strikeTime.getTime()) { /* busy-wait last 600ms */ }
            console.log(`[bot][i${instance}] STRIKE — 12:00:05`);
        } else if (msToWait < -60000) {
            console.log(`[bot][i${instance}] Outside pre-load window, proceeding immediately`);
        } else {
            console.log(`[bot][i${instance}] Strike passed by ${Math.round(-msToWait / 1000)}s, proceeding`);
        }

        abort(); // last check before the race begins

        // ── Step 5: Verify/Re-set Date ────────────────────────────────────────
        writeStatus(target, instance, "setting_date");
        const dateInput = page.locator("#startDate");

        let appliedDate = await dateInput.inputValue().catch(() => "");
        if (appliedDate === fmtDate(target)) {
            console.log(`[bot] Date confirmed (pre-set): ${appliedDate}`);
        } else {
            // Date was reset during the wait — try to set it again
            console.log(`[bot] Step 5: Date reset to "${appliedDate}", re-setting to ${fmtDate(target)}…`);
            await abortableSleep(msToWait <= 0 ? 5000 : 2000);

            await dateInput.click();
            await abortableSleep(200);
            await dateInput.fill(fmtDate(target));
            await dateInput.press("Tab");
            await abortableSleep(500);

            appliedDate = await dateInput.inputValue().catch(() => "");
            if (appliedDate !== fmtDate(target)) {
                const digitsOnly = fmtDate(target).replace(/\//g, "");
                console.log(`[bot] fill() date not confirmed ("${appliedDate}"), trying digits-only…`);
                await dateInput.click();
                await page.keyboard.press("Control+a");
                await abortableSleep(100);
                await page.keyboard.type(digitsOnly, { delay: 80 });
                await dateInput.press("Tab");
                await abortableSleep(800);
                appliedDate = await dateInput.inputValue().catch(() => "");
            }

            if (appliedDate !== fmtDate(target)) {
                throw new Error(`Date field stuck. Expected ${fmtDate(target)}, got ${appliedDate || "(empty)"}`);
            }
            console.log(`[bot] Date confirmed: ${appliedDate}`);
        }

        // ── Step 6: Search ────────────────────────────────────────────────────
        writeStatus(target, instance, "searching");
        console.log("[bot] Step 6: Clicking Search…");
        await page.locator("button:has-text('Search')").click();
        await abortableSleep(2000);

        // ── Step 7: Select Room ───────────────────────────────────────────────
        console.log(`[bot] Step 7: Looking for room ${bldg.room}…`);
        await page.waitForSelector(`li[aria-label^="Booking:"]`, { timeout: 60_000 }).catch(() => null);
        abort();

        let roomClicked = false;
        let bookedRoom = null;
        let usedFallback = false;

        // Try primary room
        const preferredRoom = page.locator(`text=${bldg.room}`).first();
        const preferredFound = await preferredRoom
            .waitFor({ state: "visible", timeout: 15_000 })
            .then(() => true)
            .catch(() => false);

        if (preferredFound) {
            abort();
            writeStatus(target, instance, `room_found:${bldg.room}`);
            console.log(`[bot] Found primary room ${bldg.room}`);
            const row = page.locator(`li[aria-label^="Booking:"]`).filter({ hasText: bldg.room }).first();
            await openBookingPanelWithRetries(page, row, bldg.room, abort);
            roomClicked = true;
            bookedRoom = bldg.room;
        } else {
            // Second-chance recheck before falling back
            console.log(`[bot] Primary ${bldg.room} not visible yet — rechecking in 5s…`);
            await abortableSleep(5000);
            if (await preferredRoom.isVisible().catch(() => false)) {
                abort();
                writeStatus(target, instance, `room_found:${bldg.room}`);
                console.log(`[bot] Found primary room ${bldg.room} on recheck`);
                const row = page.locator(`li[aria-label^="Booking:"]`).filter({ hasText: bldg.room }).first();
                await openBookingPanelWithRetries(page, row, bldg.room, abort);
                roomClicked = true;
                bookedRoom = bldg.room;
            }
        }

        // Try named fallbacks
        if (!roomClicked && bldg.fallbackRooms?.length) {
            for (const fbRoom of bldg.fallbackRooms) {
                abort();
                console.log(`[bot] Primary unavailable — trying named fallback ${fbRoom}…`);
                const fbLocator = page.locator(`text=${fbRoom}`).first();
                if (await fbLocator.isVisible().catch(() => false)) {
                    writeStatus(target, instance, `room_found:${fbRoom}(fallback)`);
                    console.log(`[bot] Found fallback room ${fbRoom}`);
                    const fbRow = page.locator(`li[aria-label^="Booking:"]`).filter({ hasText: fbRoom }).first();
                    await openBookingPanelWithRetries(page, fbRow, fbRoom, abort);
                    roomClicked = true;
                    bookedRoom = fbRoom;
                    usedFallback = true;
                    break;
                }
            }
        }

        if (!roomClicked) {
            writeStatus(target, instance, "failed:no_rooms");
            await result("failed", target, bldgKey, `No approved rooms available for ${fmtISO(target)}`);
            await browser.close();
            throw new Error(`No approved rooms available for ${fmtISO(target)}`);
        }

        writeStatus(target, instance, `panel_open:${bookedRoom}`);
        abort();

        // ── Step 8: Click "Myself" ────────────────────────────────────────────
        console.log("[bot] Step 8: Clicking 'Myself'…");
        const myselfOption = page.getByText(/myself/i).first();
        await myselfOption.waitFor({ state: "visible", timeout: 25_000 });
        await myselfOption.click();
        await abortableSleep(3000);

        writeStatus(target, instance, `myself_clicked:${bookedRoom}`);
        abort();

        const roomDetail = usedFallback
            ? `Preferred ${bldg.room} unavailable. Booked fallback: ${bookedRoom}`
            : `Booked preferred room: ${bookedRoom}`;

        // ── Step 9: Verify date ───────────────────────────────────────────────
        console.log("[bot] Step 9: Verifying booking date…");
        const expectedSummaryDate = fmtLongDate(target);
        let cleanSummaryText = "";
        let dateVerified = false;

        for (let poll = 0; poll < 5; poll++) {
            abort();
            const allDateElements = await page.locator("text=Date:").locator("..").allTextContents().catch(() => []);
            const matching = allDateElements.find(t => t.includes(expectedSummaryDate));
            if (matching) {
                cleanSummaryText = matching.replace(/\s+/g, " ").trim();
                dateVerified = true;
                break;
            }
            if (poll === 0) {
                console.log(`[bot] Date elements: ${JSON.stringify(allDateElements.map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean))}`);
            }
            console.log(`[bot] Summary date not yet correct (poll ${poll + 1}/5)…`);
            await abortableSleep(4000);
        }

        const postSelectDate = await page.locator("#startDate").inputValue({ timeout: 5000 }).catch(() => "");
        if (postSelectDate && postSelectDate !== fmtDate(target)) {
            console.log(`[bot] Date field reverted to "${postSelectDate}" — attempting recovery…`);
            await page.locator("#startDate").click({ clickCount: 3 });
            await page.keyboard.press("Delete");
            await abortableSleep(300);
            await page.evaluate(({ selector, value }) => {
                const el = document.querySelector(selector);
                if (!el) return;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                setter.call(el, value);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
            }, { selector: "#startDate", value: fmtDate(target) });
            await page.locator("#startDate").press("Tab");
            await abortableSleep(800);
            const recovered = await page.locator("#startDate").inputValue().catch(() => "");
            if (recovered !== fmtDate(target)) {
                throw new Error(`Date reverted to ${postSelectDate} and recovery failed (got ${recovered})`);
            }
            console.log(`[bot] Date recovered. Re-running Search…`);
            await page.locator("button:has-text('Search')").click();
            await abortableSleep(2000);
            throw new Error(`Date reverted — re-searched, needs fresh room selection`);
        }

        if (!dateVerified) {
            await page.screenshot({ path: screenshotPath("booking_date_mismatch.png"), fullPage: true }).catch(() => {});
            throw new Error(`Summary date mismatch. Expected ${expectedSummaryDate}, got "${cleanSummaryText || "missing"}"`);
        }

        writeStatus(target, instance, `date_verified:${bookedRoom}`);
        abort();

        // ── Step 9.5: Dry run ─────────────────────────────────────────────────
        if (CONFIG.dryRun) {
            console.log("[bot] DRY RUN — stopping before BOOK click");
            await page.screenshot({ path: screenshotPath("booking_dry_run.png"), fullPage: true });
            await result("dry_run_pre_submit", target, bldgKey, `Stopped before BOOK click (dry run). ${roomDetail}`);
            await browser.close();
            process.exit(0);
        }

        // ── Step 10: Acquire lock then click BOOK ─────────────────────────────
        writeStatus(target, instance, `acquiring_lock:${bookedRoom}`);
        const lockResult = acquireLock(target, instance, bookedRoom);
        if (!lockResult.acquired) {
            const winner = lockResult.winner;
            const msg = winner
                ? `i${winner.instance} already holds lock for ${winner.room} — standing down`
                : `Lock exists (unknown winner) — standing down`;
            writeStatus(target, instance, `stood_down:lock`);
            await result("stood_down", target, bldgKey, msg);
            await browser.close();
            return;
        }

        writeStatus(target, instance, `clicking_book:${bookedRoom}`);
        abort(); // one final check after lock acquired — before clicking

        console.log(`[bot][i${instance}] Lock held. Clicking BOOK…`);
        const bookBtn = page.locator("button:has-text('BOOK')").first();
        await bookBtn.waitFor({ state: "visible", timeout: 15_000 });
        await bookBtn.click();

        // ── Step 11: Confirm ──────────────────────────────────────────────────
        console.log("[bot] Step 11: Waiting for confirmation…");
        const confirmation = await Promise.race([
            page.waitForSelector("text=Workspace is successfully booked", { timeout: 90_000 }).then(() => "success"),
            page.waitForSelector("text=already booked", { timeout: 90_000 }).then(() => "already_booked"),
            page.waitForSelector("text=error, text=failed, text=invalid", { timeout: 90_000 }).then(() => "error"),
        ]).catch(() => "timeout");

        if (confirmation === "success") {
            await page.screenshot({ path: screenshotPath("booking_confirmed.png"), fullPage: true });
            writeStatus(target, instance, `booked:${bookedRoom}`);
            declareDone(target, instance, bookedRoom); // signals all siblings to stand down NOW
            console.log(`[bot][i${instance}] Booking confirmed!`);
            await result("booked", target, bldgKey, roomDetail);
            releaseLock(target);
        } else if (confirmation === "already_booked") {
            writeStatus(target, instance, `already_booked:${bookedRoom}`);
            releaseLock(target);
            await result("already_exists", target, bldgKey, `Already booked. ${roomDetail}`);
        } else {
            releaseLock(target);
            const pageMsg = await page.textContent("body").catch(() => "");
            await page.screenshot({ path: screenshotPath("booking_unknown.png"), fullPage: true });
            throw new Error(`BOOK click — no confirmation. Status: ${confirmation}. Page: ${pageMsg.slice(0, 100)}…`);
        }

    } catch (err) {
        if (err.name === "StandDownError") throw err; // pass through cleanly, no screenshot
        console.error("[bot] Error:", err.message);
        writeStatus(target, instance, `failed:${err.message.slice(0, 60)}`);
        await page.screenshot({ path: screenshotPath("booking_error.png"), fullPage: true }).catch(() => {});
        await result("failed", target, bldgKey ?? null, `Error: ${err.message}`);
        throw err;
    } finally {
        await browser.close();
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            console.log(`[bot] ═══ Attempt ${attempt}/${CONFIG.maxRetries} ═══`);
            await attemptBooking();
            return;
        } catch (err) {
            if (err.name === "StandDownError") {
                console.log(`[bot] Standing down: ${err.message}`);
                return; // clean exit, no retry
            }
            console.error(`[bot] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < CONFIG.maxRetries) {
                const delayMin = Math.round(CONFIG.retryDelayMs / 60000);
                console.log(`[bot] Retrying in ${delayMin} minute(s)…`);
                await sendTelegram(
                    `⏳ *Archibus Booking Bot*\n\nAttempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message}\nRetrying in ${delayMin} min…`
                );
                await sleep(CONFIG.retryDelayMs);
            } else {
                console.error(`[bot] All ${CONFIG.maxRetries} attempts exhausted.`);
                const target = targetDate();
                await result("failed", target, null, `All ${CONFIG.maxRetries} attempts failed. Last: ${err.message}`);
                process.exit(1);
            }
        }
    }
}

main();

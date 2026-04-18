#!/usr/bin/env node
/**
 * Archibus Workspace Booking Bot
 *
 * Deterministic Playwright script — no LLM needed.
 * Runs daily via cron, calculates target_date = today + 29d,
 * picks the correct building/floor/room, and submits the booking.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

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

    buildings: {
        A: {
            name: "The New Two Seventy Building 270 Albert Street (08422)",
            searchText: "Two Seventy",
            floor: "06",
            room: "WS06-072",
            fallbackRoom: "WS06-052",
            fallbackPrefix: "WS06-",
        },
        B: {
            name: "Place d'Orleans Shopping Centre 110 Place d'Orleans Drive (11832)",
            searchText: "Orleans",
            floor: "02",
            room: "D2-106",
            fallbackRoom: "D2-144",
            fallbackRoom: "D2-146",
            fallbackPrefix: "D2-",
        },
    },

    // target weekday → building key  (0=Sun … 6=Sat)
    // Mon(1)=A, Thu(4)=A, Fri(5)=B
    weekdayMap: { 1: "A", 4: "A", 5: "B" },

    timeoutMs: 60_000,
    panelOpenRetries: parseInt(process.env.BOOKING_PANEL_OPEN_RETRIES ?? "4", 10),
    panelOpenWaitMs: parseInt(process.env.BOOKING_PANEL_OPEN_WAIT_MS ?? "2000", 10),
    panelSignalTimeoutMs: parseInt(process.env.BOOKING_PANEL_SIGNAL_TIMEOUT_MS ?? "15000", 10),

    // Retry config (for site slowness at noon)
    maxRetries: parseInt(process.env.BOOKING_MAX_RETRIES ?? "3", 10),
    retryDelayMs: parseInt(process.env.BOOKING_RETRY_DELAY_MS ?? "120000", 10), // 2 minutes
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function targetDate() {
    // Override: TARGET_DATE=YYYY-MM-DD for testing
    if (process.env.TARGET_DATE) {
        const [y, m, d] = process.env.TARGET_DATE.split("-").map(Number);
        return new Date(y, m - 1, d, 12, 0, 0, 0); // noon to avoid DST edge cases
    }
    const d = new Date();
    // Archibus allows booking 29 days ahead (today = day 1)
    // e.g. Sun Feb 15 → Mon Mar 16, Wed Feb 18 → Thu Mar 19
    d.setDate(d.getDate() + 29);
    return d;
}

function fmtDate(d) {
    // MM/DD/YYYY — the format the Archibus date picker uses
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
}

function fmtISO(d) {
    return d.toISOString().slice(0, 10);
}

function weekdayName(d) {
    return d.toLocaleDateString("en-US", { weekday: "long" });
}

function fmtLongDate(d) {
    return d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "America/New_York",
    });
}

function screenshotPath(name) {
    return join(SCREENSHOT_DIR, name);
}

// ─── Telegram ───────────────────────────────────────────────────────────────
async function sendTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // silently skip if not configured

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
        if (!resp.ok) console.error(`[telegram] HTTP ${resp.status}: ${await resp.text()}`);
        else console.log("[bot] Telegram notification sent ✅");
    } catch (err) {
        console.error(`[telegram] Failed to send: ${err.message}`);
    }
}

const STATUS_EMOJI = {
    booked: "✅", dry_run_pre_submit: "🧪", no_op: "⏭️", failed: "❌",
    already_exists: "📌",
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

    // Send Telegram notification
    const emoji = STATUS_EMOJI[status] ?? "ℹ️";
    const msg = [
        `${emoji} *Archibus Booking Bot*`,
        ``,
        `Status: \`${status}\``,
        `Date: ${fmtISO(target)} (${weekdayName(target)})`,
        `Building: ${building ?? "none"}`,
        `Details: ${details}`,
        `Dry run: ${CONFIG.dryRun}`,
    ].join("\n");
    await sendTelegram(msg);

    return out;
}

async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

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
    const panelSignals = [
        page.getByText(/booking space for/i).first(),
        page.getByText(/myself/i).first(),
        page.locator("button:has-text('BOOK')").first(),
    ];

    for (const signal of panelSignals) {
        if (await signal.isVisible().catch(() => false)) return true;
    }
    return false;
}

async function openBookingPanelWithRetries(page, roomRow, roomLabel) {
    for (let i = 1; i <= CONFIG.panelOpenRetries; i++) {
        await clickRoomAction(roomRow, roomLabel);
        await sleep(CONFIG.panelOpenWaitMs);

        if (await bookingPanelIsVisible(page)) return;

        await page
            .waitForSelector("text=Booking space for", { timeout: CONFIG.panelSignalTimeoutMs })
            .then(() => true)
            .catch(() => false);

        if (await bookingPanelIsVisible(page)) return;
        console.log(`[bot] Booking panel did not appear yet for ${roomLabel} (attempt ${i}/${CONFIG.panelOpenRetries})`);
        // Dismiss any partially-open state before retrying
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(500);
    }

    throw new Error(`Booking panel did not open for ${roomLabel} after ${CONFIG.panelOpenRetries} attempts`);
}

// ─── Booking Attempt ────────────────────────────────────────────────────────
async function attemptBooking() {
    // Validate credentials
    if (!CONFIG.user || !CONFIG.pass) {
        await result("failed", targetDate(), null, "BOOKING_USER or BOOKING_PASS not set");
        process.exit(1); // no point retrying missing creds
    }

    const target = targetDate();
    const dow = target.getDay(); // 0=Sun
    // Override: FORCE_BUILDING=A|B for testing on any weekday
    const bldgKey = process.env.FORCE_BUILDING || CONFIG.weekdayMap[dow];

    if (!bldgKey) {
        await result("no_op", target, null, `No booking policy for ${weekdayName(target)}`);
        process.exit(0);
    }

    const bldg = CONFIG.buildings[bldgKey];
    console.log(
        `[bot] Booking for ${fmtISO(target)} (${weekdayName(target)}) → Building ${bldgKey}: ${bldg.name}`
    );
    console.log(`[bot] Floor ${bldg.floor}, preferred room ${bldg.room}, dry_run=${CONFIG.dryRun}`);

    // Launch browser
    const headless = (process.env.HEADLESS ?? "1") !== "0";
    console.log(`[bot] Launching browser (headless=${headless})…`);
    const browser = await chromium.launch({
        headless,
        args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        slowMo: headless ? 0 : 500, // slow down for visual watching
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
        console.log("[bot] Step 1: Navigating to Archibus login…");
        await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded" });
        await sleep(5000); // let React SPA bootstrap

        // Screenshot: what does the page look like after load?
        await page.screenshot({ path: screenshotPath("step1a_after_load.png"), fullPage: true });
        console.log(`[bot] Page title: ${await page.title()}`);
        console.log(`[bot] Page URL: ${page.url()}`);

        // Wait for React SPA to render the login form
        console.log("[bot] Waiting for login form to render…");
        const loginForm = await page.waitForSelector("#logon-user-input", { timeout: 30_000 }).catch(() => null);

        if (!loginForm) {
            // Maybe already logged in, or different page — but we can't trust the page state.
            // The SPA may have loaded into a broken/blank state (seen in production: blank page
            // with only "Contact the Archibus team" button, title "ARCHIBUS Workplace").
            // Instead of assuming we're on the building list, verify by checking for actual content.
            console.log("[bot] No login form found — checking if already past login…");
            await page.screenshot({ path: screenshotPath("step1b_no_login_form.png"), fullPage: true });
            const title = await page.title();
            const bodyText = await page.textContent("body").catch(() => "");
            console.log(`[bot] Current title: ${title}`);
            console.log(`[bot] Body text length: ${bodyText.length} chars`);

            // Require ACTUAL building-list content, not just a title match
            const hasBuildingContent = bodyText.includes("Search for a building") ||
                bodyText.includes("Select a building") ||
                bodyText.includes("Book workspaces") ||
                bodyText.includes(bldg.searchText);

            if (hasBuildingContent) {
                console.log("[bot] Already logged in with building list visible, proceeding…");
            } else {
                // Page is in a bad state — force a fresh load of the login page
                console.log("[bot] Page is in an invalid state (no building list found). Forcing fresh navigation…");
                await page.goto(CONFIG.baseUrl, { waitUntil: "domcontentloaded" });
                await sleep(5000);
                const retryForm = await page.waitForSelector("#logon-user-input", { timeout: 30_000 }).catch(() => null);
                if (!retryForm) {
                    throw new Error(`Cannot reach login page after retry. Title: ${await page.title()}`);
                }
                // Fill and submit login
                await page.fill("#logon-user-input", CONFIG.user);
                await page.fill("#logon-password-input", CONFIG.pass);
                console.log("[bot] Credentials filled on retry");
                await Promise.all([
                    page.waitForResponse(resp => resp.url().includes("archibus") && resp.status() === 200, { timeout: 30_000 }).catch(() => null),
                    page.getByRole("button", { name: /log\s*in/i }).click(),
                ]);
                await sleep(8000);
                console.log(`[bot] Post-retry-login title: ${await page.title()}`);
            }
        } else {
            // Fill username
            await page.fill("#logon-user-input", CONFIG.user);
            console.log("[bot] Username filled");

            // Fill password
            await page.fill("#logon-password-input", CONFIG.pass);
            console.log("[bot] Password filled");

            await page.screenshot({ path: screenshotPath("step1c_creds_filled.png"), fullPage: true });

            // Click Log in and wait for navigation/SPA transition
            console.log("[bot] Clicking Log in…");
            await Promise.all([
                page.waitForResponse(resp => resp.url().includes("archibus") && resp.status() === 200, { timeout: 30_000 }).catch(() => null),
                page.getByRole("button", { name: /log\s*in/i }).click(),
            ]);

            console.log("[bot] Login clicked, waiting for page transition…");
            await sleep(8000); // generous wait for SPA transition

            await page.screenshot({ path: screenshotPath("step1d_after_login_click.png"), fullPage: true });
            console.log(`[bot] Post-login title: ${await page.title()}`);
            console.log(`[bot] Post-login URL: ${page.url()}`);

            // Check if login succeeded — look for multiple possible indicators
            const pageText = await page.textContent("body").catch(() => "");
            if (pageText.includes("Search for a building") || pageText.includes("Workplace")) {
                console.log("[bot] ✅ Login successful — building list detected");
            } else if (pageText.includes("Invalid") || pageText.includes("incorrect") || pageText.includes("failed")) {
                await result("failed", target, bldgKey, "Login failed — invalid credentials");
                await browser.close();
                process.exit(1); // no point retrying bad creds
            } else {
                // Still transitioning? Wait more
                console.log("[bot] Page still transitioning, waiting longer…");
                await sleep(10_000);
                await page.screenshot({ path: screenshotPath("step1e_extended_wait.png"), fullPage: true });
                console.log(`[bot] Extended wait title: ${await page.title()}`);
            }
        }
        console.log("[bot] Step 1 complete — proceeding to building selection");

        // ── Step 2: Select Building ───────────────────────────────────────────
        console.log(`[bot] Step 2: Selecting building ${bldgKey}…`);

        // Try clicking the building by its full text
        const buildingLink = page.locator(`text=${bldg.name}`).first();
        const buildingVisible = await buildingLink.isVisible().catch(() => false);

        if (buildingVisible) {
            await buildingLink.click();
        } else {
            // Building might require searching
            const searchInput = page.locator('input[placeholder*="Search for a building"]');
            if (await searchInput.isVisible().catch(() => false)) {
                await searchInput.fill(bldg.searchText);
                await sleep(1500);
            }
            // Click the building after search
            await page.locator(`text=${bldg.name}`).first().click();
        }

        // Wait for the "Book workspaces" card to appear (proves building page loaded)
        await page.locator("text=Book workspaces").first().waitFor({ state: "visible", timeout: 30_000 });

        // ── Step 3: Click "Book workspaces" card ──────────────────────────────
        console.log("[bot] Step 3: Opening 'Book workspaces'…");
        await page.locator("text=Book workspaces").first().click();

        // ── Step 4: Select Floor ──────────────────────────────────────────────
        console.log(`[bot] Step 4: Selecting floor ${bldg.floor}…`);

        // Wait for the workspace booking page
        await page.waitForSelector("text=Workspace booking", { timeout: 20_000 });

        // Click the floor in the left sidebar
        const floorLink =
            page.locator(`a[aria-label*="Select floor ${bldg.floor}"]`).first();
        const floorVisible = await floorLink.isVisible().catch(() => false);

        if (floorVisible) {
            await floorLink.click();
        } else {
            // Fallback: click by floor text
            await page.locator(`text="${bldg.floor}"`).first().click();
        }
        // Wait for date input to confirm floor loaded
        await page.locator("#startDate").waitFor({ state: "visible", timeout: 20_000 });

        // ── Wait for exactly 12:00:00 before selecting date ──────────────────
        const now = new Date();
        if (now.getHours() === 11 && now.getMinutes() >= 58) {
            const targetTime = new Date();
            targetTime.setHours(12, 0, 0, 0);
            const msToWait = targetTime.getTime() - now.getTime();
            if (msToWait > 0) {
                console.log(`[bot] Pre-loaded at ${now.toLocaleTimeString()}. Waiting ${Math.round(msToWait/1000)}s until 12:00:00 PM to select date and search…`);
                // Sleep until ~500ms before noon, then tight-poll for precision
                if (msToWait > 1000) {
                    await sleep(msToWait - 500);
                }
                while (Date.now() < targetTime.getTime()) {
                    // busy-wait for sub-millisecond precision
                }
                console.log(`[bot] Time is 12:00:00 PM. Executing Date Selection and Search!`);
            }
        }

        // ── Step 5: Set Target Date ───────────────────────────────────────────
        console.log(`[bot] Step 5: Setting date to ${fmtDate(target)}…`);

        const dateInput = page.locator("#startDate");
        // Wait for the date field to be stable — React date components need time
        // to finish initializing after floor selection, especially under noon load.
        // 5s was sometimes not enough on extremely busy days.
        await sleep(10000);

        // Clear the field and type date character-by-character
        await dateInput.click({ clickCount: 3 }); // select all
        await page.keyboard.press("Delete");
        await sleep(500);
        await dateInput.pressSequentially(fmtDate(target), { delay: 100 });
        await dateInput.press("Tab");
        await sleep(1000);

        // Verify the date stuck
        let appliedDate = await dateInput.inputValue().catch(() => "");
        if (appliedDate !== fmtDate(target)) {
            console.log(`[bot] ⚠️ Date field shows "${appliedDate}" after pressSequentially, trying evaluate() fallback…`);
            await page.evaluate(({ selector, value }) => {
                const el = document.querySelector(selector);
                if (!el) return;
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, "value"
                ).set;
                nativeInputValueSetter.call(el, value);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
            }, { selector: "#startDate", value: fmtDate(target) });
            await sleep(1000);
            appliedDate = await dateInput.inputValue().catch(() => "");
        }

        if (appliedDate !== fmtDate(target)) {
            throw new Error(`Date field did not keep target value. Expected ${fmtDate(target)}, got ${appliedDate || "(empty)"}`);
        }
        console.log(`[bot] Date confirmed: ${appliedDate}`);

        // ── Step 6: Click Search ──────────────────────────────────────────────
        console.log("[bot] Step 6: Clicking Search…");
        await page.locator("button:has-text('Search')").click();
        await sleep(2000); // let results load

        // ── Step 7: Select Room ───────────────────────────────────────────────
        console.log(`[bot] Step 7: Looking for room ${bldg.room}…`);
        console.log(`[bot] Waiting for rooms to load…`);
        await page.waitForSelector(`li[aria-label^="Booking:"]`, { timeout: 60_000 }).catch(() => null);

        // Try preferred room first
        let roomClicked = false;
        let bookedRoom = null;
        let usedFallback = false;
        const preferredRoom = page.locator(`text=${bldg.room}`).first();
        if (await preferredRoom.isVisible().catch(() => false)) {
            console.log(`[bot] Found preferred room ${bldg.room}`);
            const preferredRoomRow = page
                .locator(`li[aria-label^="Booking:"]`)
                .filter({ hasText: bldg.room })
                .first();
            await openBookingPanelWithRetries(page, preferredRoomRow, bldg.room);
            roomClicked = true;
            bookedRoom = bldg.room;
        }

        // Second choice: specific fallback room
        if (!roomClicked && bldg.fallbackRoom) {
            console.log(`[bot] ⚠️ Preferred room ${bldg.room} not available, trying second choice ${bldg.fallbackRoom}...`);
            const secondChoice = page.locator(`text=${bldg.fallbackRoom}`).first();
            if (await secondChoice.isVisible().catch(() => false)) {
                console.log(`[bot] Found second choice room ${bldg.fallbackRoom}`);
                const secondChoiceRow = page
                    .locator(`li[aria-label^="Booking:"]`)
                    .filter({ hasText: bldg.fallbackRoom })
                    .first();
                await openBookingPanelWithRetries(page, secondChoiceRow, bldg.fallbackRoom);
                roomClicked = true;
                bookedRoom = bldg.fallbackRoom;
                usedFallback = true;
            }
        }
        // Fallback: any room matching the prefix
        if (!roomClicked) {
            console.log(
                `[bot] ⚠️ Preferred room ${bldg.room} not available, looking for fallback prefix ${bldg.fallbackPrefix}…`
            );
            usedFallback = true;
            const fallbackRoom = page
                .locator(`li[aria-label^="Booking:"]`)
                .filter({ hasText: bldg.fallbackPrefix })
                .first();
            if (await fallbackRoom.isVisible().catch(() => false)) {
                bookedRoom = (await fallbackRoom.textContent())?.trim() ?? "unknown";
                console.log(`[bot] Using fallback room: ${bookedRoom}`);
                await openBookingPanelWithRetries(page, fallbackRoom, bookedRoom);
                roomClicked = true;
            }
        }

        if (!roomClicked) {
            // Try clicking any available room at all
            usedFallback = true;
            const anyRoom = page.locator('li[aria-label^="Booking:"]').first();
            if (await anyRoom.isVisible().catch(() => false)) {
                bookedRoom = (await anyRoom.textContent())?.trim() ?? "unknown";
                console.log(`[bot] Using first available room: ${bookedRoom}`);
                await openBookingPanelWithRetries(page, anyRoom, bookedRoom);
                roomClicked = true;
            }
        }

        if (!roomClicked) {
            await result("failed", target, bldgKey, `❗ Preferred room ${bldg.room} was NOT available and no fallback rooms found on the selected floor/date`);
            await browser.close();
            throw new Error(`No rooms available for ${fmtISO(target)}`);
        }

        // ── Step 8: Click "Myself" ────────────────────────────────────────────
        console.log("[bot] Step 8: Clicking 'Myself'…");
        const myselfOption = page.getByText(/myself/i).first();
        await myselfOption.waitFor({ state: "visible", timeout: 25_000 });
        await myselfOption.click();
        await sleep(3000); // Wait for summary to update

        // Build result detail string with room info
        const roomDetail = usedFallback
            ? `⚠️ Preferred room ${bldg.room} was NOT available. Booked fallback room: ${bookedRoom}`
            : `Booked preferred room: ${bookedRoom}`;

        // ── Date re-verification ──────────────────────────────────────────────
        console.log("[bot] Step 9: Verifying booking date before final click…");
        const expectedSummaryDate = fmtLongDate(target);

        // Poll for the correct summary date — under noon load, the SPA sometimes
        // initially shows today's date before updating to the target date.
        let cleanSummaryText = "";
        let dateVerified = false;
        for (let poll = 0; poll < 5; poll++) {
            // Search broadly — the summary panel has no special role/class attributes
            const allDateElements = await page.locator("text=Date:").locator("..").allTextContents().catch(() => []);
            const matching = allDateElements.find(t => t.includes(expectedSummaryDate));
            if (matching) {
                cleanSummaryText = matching.replace(/\s+/g, " ").trim();
                dateVerified = true;
                break;
            }
            if (poll === 0) {
                const found = allDateElements.map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean);
                console.log(`[bot] Date elements found: ${JSON.stringify(found)}`);
            }
            console.log(`[bot] Summary date not yet correct (poll ${poll + 1}/5), waiting 4s…`);
            await sleep(4000);
        }

        console.log(`[bot] Detected summary date: "${cleanSummaryText}"`);

        // Also re-check the date input field directly
        const postSelectDate = await page.locator("#startDate").inputValue({ timeout: 5000 }).catch(() => "");
        if (postSelectDate && postSelectDate !== fmtDate(target)) {
            console.log(`[bot] ⚠️ Date field reverted to "${postSelectDate}" after room selection! Re-setting to ${fmtDate(target)}…`);
            await page.locator("#startDate").click({ clickCount: 3 });
            await page.keyboard.press("Delete");
            await sleep(500);
            await page.locator("#startDate").pressSequentially(fmtDate(target), { delay: 50 });
            await page.locator("#startDate").press("Tab");
            await sleep(2000);
            throw new Error(`Date reverted to ${postSelectDate} after room selection — retry needed`);
        }

        if (!dateVerified) {
            await page.screenshot({ path: screenshotPath("booking_date_mismatch.png"), fullPage: true }).catch(() => { });
            throw new Error(`Summary date mismatch. Expected ${expectedSummaryDate}, got "${cleanSummaryText || "missing"}"`);
        }

        // ── Step 9.5: DRY RUN check ───────────────────────────────────────────
        if (CONFIG.dryRun) {
            console.log("[bot] ⚠️  DRY RUN — stopping before final BOOK click");
            await page.screenshot({ path: screenshotPath("booking_dry_run.png"), fullPage: true });
            console.log(`[bot] Screenshot saved to ${screenshotPath("booking_dry_run.png")}`);
            await result("dry_run_pre_submit", target, bldgKey, `Stopped before BOOK click (dry run). ${roomDetail}`);
            await browser.close();
            process.exit(0);
        }

        // ── Step 10: Click BOOK ───────────────────────────────────────────────
        console.log("[bot] Step 10: Clicking BOOK…");
        const bookBtn = page.locator("button:has-text('BOOK')").first();
        await bookBtn.waitFor({ state: "visible", timeout: 15_000 });
        await bookBtn.click();

        // ── Step 11: Confirm success ──────────────────────────────────────────
        console.log("[bot] Step 11: Checking for confirmation…");
        const confirmation = await Promise.race([
            page.waitForSelector("text=Workspace is successfully booked", { timeout: 90_000 }).then(() => "success"),
            page.waitForSelector("text=already booked", { timeout: 90_000 }).then(() => "already_booked"),
            page.waitForSelector("text=error, text=failed, text=invalid", { timeout: 90_000 }).then(() => "error"),
        ]).catch(() => "timeout");

        if (confirmation === "success") {
            await page.screenshot({ path: screenshotPath("booking_confirmed.png"), fullPage: true });
            console.log("[bot] ✅ Booking confirmed!");
            await result("booked", target, bldgKey, roomDetail);
        } else if (confirmation === "already_booked") {
            console.log("[bot] 📌 Workspace already booked (likely by a previous attempt that timed out)");
            await result("already_exists", target, bldgKey, `Workspace already booked. ${roomDetail}`);
        } else {
            const pageMsg = await page.textContent("body").catch(() => "");
            await page.screenshot({ path: screenshotPath("booking_unknown.png"), fullPage: true });
            throw new Error(`BOOK click did not result in confirmation. Status: ${confirmation}. Page snippet: ${pageMsg.slice(0, 100)}...`);
        }
    } catch (err) {
        console.error("[bot] ❌ Error:", err.message);
        await page.screenshot({ path: screenshotPath("booking_error.png"), fullPage: true }).catch(() => { });
        await result("failed", target, bldgKey ?? null, `Error: ${err.message}`);
        throw err; // bubble up to retry loop
    } finally {
        await browser.close();
    }
}

// ─── Main (with retry logic) ────────────────────────────────────────────────
async function main() {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            console.log(`[bot] ═══ Attempt ${attempt}/${CONFIG.maxRetries} ═══`);
            await attemptBooking();
            return; // success — exit
        } catch (err) {
            console.error(`[bot] ❌ Attempt ${attempt} failed: ${err.message}`);

            if (attempt < CONFIG.maxRetries) {
                const delayMin = Math.round(CONFIG.retryDelayMs / 60000);
                console.log(`[bot] ⏳ Retrying in ${delayMin} minute(s)…`);
                await sendTelegram(
                    `⏳ *Archibus Booking Bot*\n\nAttempt ${attempt}/${CONFIG.maxRetries} failed: ${err.message}\nRetrying in ${delayMin} min…`
                );
                await sleep(CONFIG.retryDelayMs);
            } else {
                console.error(`[bot] ❌ All ${CONFIG.maxRetries} attempts exhausted.`);
                const target = targetDate();
                await result("failed", target, null, `All ${CONFIG.maxRetries} attempts failed. Last error: ${err.message}`);
                process.exit(1);
            }
        }
    }
}

main();
// Test improvement - add error handling

import test from "node:test";
import assert from "node:assert/strict";
import { dateInputAfterRefresh, searchRefreshTime, setStartDate } from "./book.mjs";

test("searchRefreshTime targets 12:00:30 on the current day", () => {
    const now = new Date("2026-07-24T11:58:10-04:00");
    const strike = searchRefreshTime(now);

    assert.equal(strike.getHours(), 12);
    assert.equal(strike.getMinutes(), 0);
    assert.equal(strike.getSeconds(), 30);
    assert.equal(strike.getMilliseconds(), 0);
    assert.equal(strike.getFullYear(), now.getFullYear());
    assert.equal(strike.getMonth(), now.getMonth());
    assert.equal(strike.getDate(), now.getDate());
});

test("setStartDate retries alternate date entry methods until the target date sticks", async () => {
    const expected = "06/22/2026";
    const calls = [];
    let value = "05/24/2026";

    const dateInput = {
        async click() {
            calls.push("click");
        },
        async fill(nextValue) {
            calls.push(`fill:${nextValue}`);
        },
        async press(key) {
            calls.push(`press:${key}`);
        },
        async evaluate(_fn, nextValue) {
            calls.push(`evaluate:${nextValue}`);
            value = nextValue;
        },
        async inputValue() {
            return value;
        },
    };

    const page = {
        keyboard: {
            async press(key) {
                calls.push(`keyboard.press:${key}`);
            },
            async type(text) {
                calls.push(`keyboard.type:${text}`);
            },
        },
    };

    const applied = await setStartDate(page, dateInput, expected, async () => {});

    assert.equal(applied, expected);
    assert.deepEqual(calls, [
        "click",
        "fill:06/22/2026",
        "press:Tab",
        "click",
        "keyboard.press:Control+a",
        "keyboard.type:06222026",
        "press:Tab",
        "evaluate:06/22/2026",
    ]);
});

test("dateInputAfterRefresh reopens the booking flow when refresh loses the date field", async () => {
    let waitCount = 0;
    let reopened = false;
    const dateInput = {
        async waitFor() {
            waitCount++;
            if (waitCount === 1) {
                throw new Error("date field missing after refresh");
            }
        },
    };
    const page = {
        locator(selector) {
            assert.equal(selector, "#startDate");
            return dateInput;
        },
        async waitForSelector(selector) {
            throw new Error(`should reopen booking flow, not wait for ${selector}`);
        },
    };

    const returned = await dateInputAfterRefresh(page, { floor: "06" }, async () => {
        reopened = true;
    });

    assert.equal(returned, dateInput);
    assert.equal(reopened, true);
    assert.equal(waitCount, 2);
});

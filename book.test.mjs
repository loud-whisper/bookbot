import test from "node:test";
import assert from "node:assert/strict";
import { setStartDate } from "./book.mjs";

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

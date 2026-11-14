// Due dates from the rule-based parser must not depend on the server's timezone.
// This file runs in its own process (node --test isolates files), so changing TZ here is safe.
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const ai = await import("../lib/ai.js");

const business = { businessName: "B", ownerName: "Rosa", description: "", currency: "USD", toneSample: "" };
const due = async (text, today) => (await ai.understandNote({ text, today, business, customers: [] })).due_date;

for (const [tz, offsetMinutes] of [["Pacific/Kiritimati", -840], ["Pacific/Auckland", null], ["America/Los_Angeles", null], ["Pacific/Pago_Pago", 660], ["UTC", 0]]) {
  test(`weekday and default due dates in ${tz}`, async (t) => {
    process.env.TZ = tz;
    if (offsetMinutes !== null && new Date(2026, 10, 11).getTimezoneOffset() !== offsetMinutes) return t.skip("this Node build has no data for " + tz);
    assert.equal(await due("Tom pays Friday, $10", "2026-11-11"), "2026-11-13");
    assert.equal(await due("Tom pays Wednesday, $10", "2026-11-11"), "2026-11-18");
    assert.equal(await due("Tom took bread, $10", "2026-11-11"), "2026-11-18");
    // Across daylight-saving changes (US: 1 Nov 2026, NZ: 27 Sep 2026).
    assert.equal(await due("Tom pays Monday, $10", "2026-10-30"), "2026-11-02");
    assert.equal(await due("Tom pays Monday, $10", "2026-09-25"), "2026-09-28");
  });
}

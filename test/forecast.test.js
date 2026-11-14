// lib/forecast.js: the per-invoice view and the 14-day cash outlook. Pure functions, fixed dates.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OPEN, daysBetween, viewInvoice, cashOutlook } from "../lib/forecast.js";
import { addDays } from "../lib/store.js";

const T = "2026-11-13";
const inv = (o) => ({ id: "i", amount: 100, paidAmount: 0, status: "SENT", dueDate: T, lastReminderAt: null, paypalId: null, ...o });

describe("daysBetween", () => {
  test("whole days, signed, across DST and year ends", () => {
    assert.equal(daysBetween(T, T), 0);
    assert.equal(daysBetween("2026-11-13", "2026-11-20"), 7);
    assert.equal(daysBetween("2026-11-20", "2026-11-13"), -7);
    assert.equal(daysBetween("2026-10-30", "2026-11-02"), 3);
    assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  });
});

describe("viewInvoice", () => {
  test("outstanding is amount minus paid, never negative, rounded to cents", () => {
    assert.equal(viewInvoice(inv({ amount: 320, paidAmount: 100 }), T).outstanding, 220);
    assert.equal(viewInvoice(inv({ amount: 0.3, paidAmount: 0.1 }), T).outstanding, 0.2);
    assert.equal(viewInvoice(inv({ amount: 50, paidAmount: 60 }), T).outstanding, 0);
  });

  test("days late / until due", () => {
    const late = viewInvoice(inv({ dueDate: addDays(T, -9) }), T);
    assert.equal(late.daysLate, 9);
    assert.equal(late.daysUntilDue, -9);
    const future = viewInvoice(inv({ dueDate: addDays(T, 3) }), T);
    assert.equal(future.daysLate, 0);
    assert.equal(future.daysUntilDue, 3);
    assert.equal(viewInvoice(inv({ dueDate: T }), T).daysLate, 0); // due today is not late
  });

  test("settled invoices are never late", () => {
    for (const status of ["PAID", "CANCELLED", "REFUNDED"]) {
      assert.equal(OPEN.has(status), false);
      assert.equal(viewInvoice(inv({ status, dueDate: addDays(T, -30) }), T).daysLate, 0);
    }
    for (const status of ["SENT", "PARTIALLY_PAID", "UNPAID", "SCHEDULED", "DRAFT"]) assert.equal(viewInvoice(inv({ status, dueDate: addDays(T, -2) }), T).daysLate, 2);
  });

  test("days since the last reminder", () => {
    assert.equal(viewInvoice(inv(), T).lastReminderDaysAgo, null);
    // Timestamps are stored in UTC; what counts is the owner's local calendar day, early or late in the day.
    const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
    assert.equal(viewInvoice(inv({ lastReminderAt: at(2026, 11, 7, 15, 0) }), T).lastReminderDaysAgo, 6);
    assert.equal(viewInvoice(inv({ lastReminderAt: at(2026, 11, 13, 0, 5) }), T).lastReminderDaysAgo, 0);
    assert.equal(viewInvoice(inv({ lastReminderAt: at(2026, 11, 13, 23, 55) }), T).lastReminderDaysAgo, 0);
    assert.equal(viewInvoice(inv({ lastReminderAt: at(2026, 11, 12, 23, 55) }), T).lastReminderDaysAgo, 1);
  });

  test("'live' means a real PayPal invoice, not a simulated one", () => {
    assert.equal(viewInvoice(inv({ paypalId: null }), T).live, false);
    assert.equal(viewInvoice(inv({ paypalId: "SIM-inv_1" }), T).live, false);
    assert.equal(viewInvoice(inv({ paypalId: "INV2-AAAA-BBBB" }), T).live, true);
  });

  test("does not modify the stored invoice", () => {
    const stored = inv({ amount: 320, paidAmount: 100 });
    const copy = structuredClone(stored);
    viewInvoice(stored, T);
    assert.deepEqual(stored, copy);
  });
});

describe("14-day cash outlook", () => {
  test("covers today plus the next 14 days", () => {
    const f = cashOutlook({ cash: 500, bills: [], invoices: [] }, T);
    assert.equal(f.days.length, 15);
    assert.equal(f.days[0].date, T);
    assert.equal(f.days[14].date, "2026-11-27");
    assert.ok(f.days.every((d) => d.balance === 500 && d.inflow === 0 && d.outflow === 0));
    assert.deepEqual(f.lowest, { amount: 500, date: T, bill: null });
    assert.equal(f.firstShort, null);
    assert.equal(f.shortfall, 0);
  });

  test("the example bakery: rent in 3 days is not covered", () => {
    const f = cashOutlook({
      cash: 750,
      bills: [{ name: "Rent", amount: 1200, dueDate: addDays(T, 3) }, { name: "Flour & butter supplier", amount: 280, dueDate: addDays(T, 6) }],
      invoices: [
        inv({ id: "marco", amount: 140, dueDate: addDays(T, -9) }),                       // overdue: not counted on
        inv({ id: "aisha", amount: 96, dueDate: addDays(T, -2) }),                        // overdue: not counted on
        inv({ id: "daniela", amount: 320, paidAmount: 100, status: "PARTIALLY_PAID", dueDate: addDays(T, 3) }),
        inv({ id: "james", amount: 60, paidAmount: 60, status: "PAID", dueDate: addDays(T, -4) }),
      ],
    }, T);
    assert.equal(f.cash, 750);
    assert.equal(f.owed, 456);     // 140 + 96 + 220
    assert.equal(f.overdue, 236);  // 140 + 96
    assert.deepEqual(f.days[3], { date: "2026-11-16", inflow: 220, outflow: 1200, balance: -230, bills: ["Rent"] });
    assert.deepEqual(f.firstShort, { date: "2026-11-16", amount: 230, bill: "Rent" });
    assert.deepEqual(f.lowest, { amount: -510, date: "2026-11-19", bill: "Flour & butter supplier" });
    assert.equal(f.shortfall, 510);
    assert.equal(f.days[14].balance, -510);
  });

  test("money expected on its due date can cover a later bill", () => {
    const f = cashOutlook({
      cash: 100,
      bills: [{ name: "Rent", amount: 300, dueDate: addDays(T, 5) }],
      invoices: [inv({ amount: 250, dueDate: addDays(T, 2) })],
    }, T);
    assert.equal(f.days[1].balance, 100);
    assert.equal(f.days[2].balance, 350);
    assert.equal(f.days[5].balance, 50);
    assert.equal(f.firstShort, null);
    assert.equal(f.shortfall, 0);
    assert.deepEqual(f.lowest, { amount: 50, date: addDays(T, 5), bill: "Rent" });
  });

  test("an invoice due today counts today; an overdue one is never counted", () => {
    const f = cashOutlook({ cash: 0, bills: [], invoices: [inv({ amount: 40, dueDate: T }), inv({ amount: 999, dueDate: addDays(T, -1) })] }, T);
    assert.equal(f.days[0].inflow, 40);
    assert.equal(f.days[14].balance, 40);
    assert.equal(f.owed, 1039);
    assert.equal(f.overdue, 999);
  });

  test("bills and invoices outside the window are ignored", () => {
    const f = cashOutlook({
      cash: 100,
      bills: [{ name: "Past", amount: 500, dueDate: addDays(T, -1) }, { name: "Far", amount: 500, dueDate: addDays(T, 15) }, { name: "Edge", amount: 30, dueDate: addDays(T, 14) }],
      invoices: [inv({ amount: 70, dueDate: addDays(T, 15) })],
    }, T);
    assert.equal(f.days[13].balance, 100);
    assert.equal(f.days[14].balance, 70);
    assert.equal(f.shortfall, 0);
  });

  test("several bills on one day; first shortfall is reported once and names the first bill", () => {
    const f = cashOutlook({
      cash: 100,
      bills: [{ name: "Rent", amount: 90.1, dueDate: addDays(T, 1) }, { name: "Gas", amount: 20.2, dueDate: addDays(T, 1) }, { name: "Phone", amount: 50, dueDate: addDays(T, 4) }],
      invoices: [],
    }, T);
    assert.deepEqual(f.days[1].bills, ["Rent", "Gas"]);
    assert.equal(f.days[1].balance, -10.3);
    assert.deepEqual(f.firstShort, { date: addDays(T, 1), amount: 10.3, bill: "Rent" });
    assert.deepEqual(f.lowest, { amount: -60.3, date: addDays(T, 4), bill: "Phone" });
    assert.equal(f.shortfall, 60.3);
  });

  test("settled invoices are not money owed", () => {
    const f = cashOutlook({ cash: 0, bills: [], invoices: [inv({ status: "PAID", paidAmount: 100 }), inv({ status: "CANCELLED", dueDate: addDays(T, 2) })] }, T);
    assert.equal(f.owed, 0);
    assert.equal(f.days[14].balance, 0);
  });
});

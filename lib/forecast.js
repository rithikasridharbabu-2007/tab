// Pure helpers for the per-invoice view and the 14-day cash outlook.
// No I/O and no clock: callers pass in the data and today's date (YYYY-MM-DD), which keeps this testable.
import { addDays, localDate } from "./store.js";

export const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "DRAFT"]);

export const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400_000);

export function viewInvoice(inv, t) {
  const outstanding = Math.max(0, +(inv.amount - inv.paidAmount).toFixed(2));
  const open = OPEN.has(inv.status);
  return {
    ...inv,
    outstanding,
    daysLate: open ? Math.max(0, daysBetween(inv.dueDate, t)) : 0,
    daysUntilDue: daysBetween(t, inv.dueDate),
    // lastReminderAt is a UTC timestamp while `t` is the owner's local date: compare local day with local day.
    lastReminderDaysAgo: inv.lastReminderAt ? daysBetween(localDate(inv.lastReminderAt), t) : null,
    live: Boolean(inv.paypalId && !inv.paypalId.startsWith("SIM-")),
  };
}

export function cashOutlook(d, t) {
  const open = d.invoices.filter((i) => OPEN.has(i.status)).map((i) => viewInvoice(i, t));
  const owed = open.reduce((s, i) => s + i.outstanding, 0);
  const overdue = open.filter((i) => i.daysLate > 0).reduce((s, i) => s + i.outstanding, 0);
  // Day-by-day projection for the next 14 days: bills go out on their due date;
  // invoices not yet due are expected on their due date; overdue ones are NOT counted (uncertain).
  const days = [];
  let bal = d.cash;
  let lowest = { amount: bal, date: t, bill: null };
  let firstShort = null;
  for (let n = 0; n <= 14; n++) {
    const date = addDays(t, n);
    const inflow = open.filter((i) => i.daysLate === 0 && i.dueDate === date).reduce((s, i) => s + i.outstanding, 0);
    const billsToday = d.bills.filter((b) => b.dueDate === date);
    const outflow = billsToday.reduce((s, b) => s + b.amount, 0);
    bal += inflow - outflow;
    days.push({ date, inflow, outflow, balance: +bal.toFixed(2), bills: billsToday.map((b) => b.name) });
    if (bal < 0 && !firstShort) firstShort = { date, amount: +(-bal).toFixed(2), bill: billsToday[0]?.name || null };
    if (bal < lowest.amount) lowest = { amount: +bal.toFixed(2), date, bill: billsToday[0]?.name || null };
  }
  return { cash: d.cash, owed: +owed.toFixed(2), overdue: +overdue.toFixed(2), lowest, firstShort, shortfall: Math.max(0, -lowest.amount), days };
}

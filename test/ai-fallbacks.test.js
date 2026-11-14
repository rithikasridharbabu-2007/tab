// The rule-based fallbacks in lib/ai.js: what Tab does when no AI key is configured.
// The keys are removed before the module is used, so these tests never reach an AI provider.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const ai = await import("../lib/ai.js");

const business = { businessName: "Rosa's Kitchen", ownerName: "Rosa Martínez", description: "a home bakery", currency: "USD", toneSample: "Hi love!" };
const customers = [
  { id: "c_priya", name: "Priya Shah", email: "priya@example.com", language: "English", usual: "Cupcakes, $30 a dozen" },
  { id: "c_marco", name: "Marco Rossi", email: "marco@example.com", language: "Italian", usual: "Birthday cake, $70" },
  { id: "c_daniela", name: "Daniela López", email: "daniela@example.com", language: "Spanish", usual: "Wedding cupcakes" },
];
const WEDNESDAY = "2026-11-11";
const note = (text, today = WEDNESDAY, known = customers) => ai.understandNote({ text, today, business, customers: known });
const weekdayOf = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();

describe("no AI key", () => {
  test("AI is reported as off", () => {
    assert.equal(ai.aiEnabled(), false);
    assert.equal(ai.aiProvider(), null);
  });
});

describe("voice note -> invoice (rules)", () => {
  test("known customer, quantity in words, usual price, weekday", async () => {
    const out = await note("Priya took three dozen cupcakes, she'll pay Friday.");
    assert.equal(out.source, "rules");
    assert.equal(out.matched_customer_id, "c_priya");
    assert.equal(out.customer_name, "Priya Shah");
    assert.equal(out.customer_email, "priya@example.com");
    assert.equal(out.customer_language, "English");
    assert.deepEqual(out.items, [{ name: "Cupcakes", quantity: 3, unit_price: 30 }]);
    assert.equal(out.currency, "USD");
    assert.equal(out.due_date, "2026-11-13");
    assert.match(out.summary, /90\.00 USD/);
    // The price came from the customer's usual price, not the note: the owner is asked to check it.
    assert.equal(out.questions.length, 1);
    assert.match(out.questions[0], /usual price/);
  });

  test("a stated price is used as the total and raises no question", async () => {
    const out = await note("Priya took three dozen cupcakes for $90, pay Friday");
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].quantity, 1);
    assert.equal(out.items[0].unit_price, 90);
    assert.deepEqual(out.questions, []);
  });

  test("understands spoken and symbol amounts", async () => {
    assert.equal((await note("Marco owes 45 dollars for a cake")).items[0].unit_price, 45);
    assert.equal((await note("Marco owes 20 bucks")).items[0].unit_price, 20);
    assert.equal((await note("Marco owes €12.50")).items[0].unit_price, 12.5);
    assert.equal((await note("Marco owes $ 70")).items[0].unit_price, 70);
  });

  test("amounts with a thousands separator are not truncated", async () => {
    assert.equal((await note("Daniela ordered the wedding cake, $1,200, due Saturday")).items[0].unit_price, 1200);
    assert.equal((await note("Daniela ordered the wedding cake for 1,250.50 dollars")).items[0].unit_price, 1250.5);
    // A comma that just ends a clause is not part of the number.
    assert.equal((await note("Marco owes $70, he pays Monday")).items[0].unit_price, 70);
  });

  test("never invents a price: asks instead", async () => {
    const unknown = await note("Tom took some bread, pays Monday");
    assert.equal(unknown.matched_customer_id, null);
    assert.equal(unknown.customer_name, "Tom");
    assert.equal(unknown.items[0].unit_price, 0);
    assert.match(unknown.summary, /amount unknown/);
    assert.equal(unknown.questions.length, 1);
    assert.match(unknown.questions[0], /price/i);

    // Known customer whose usual order has no price on file.
    const daniela = await note("Daniela wants two dozen wedding cupcakes");
    assert.equal(daniela.matched_customer_id, "c_daniela");
    assert.equal(daniela.customer_language, "Spanish");
    assert.equal(daniela.items[0].unit_price, 0);
    assert.match(daniela.questions[0], /price/i);
  });

  test("numeric quantity times usual price", async () => {
    const out = await note("Marco wants 2 cakes for Saturday");
    assert.deepEqual(out.items, [{ name: "Birthday cake", quantity: 2, unit_price: 70 }]);
    assert.equal(out.customer_language, "Italian");
    assert.equal(out.due_date, "2026-11-14");
  });

  test("customer match is case-insensitive", async () => {
    assert.equal((await note("PRIYA took a dozen cupcakes")).matched_customer_id, "c_priya");
  });

  test("a customer with a blank first-name token does not match every note", async () => {
    const odd = [{ id: "c_blank", name: " Zed", email: "", language: "French", usual: "" }, ...customers];
    assert.equal((await note("Priya took three dozen cupcakes", WEDNESDAY, odd)).matched_customer_id, "c_priya");
    assert.equal((await note("Tom took some bread", WEDNESDAY, odd)).matched_customer_id, null);
    assert.equal((await note("zed took some bread", WEDNESDAY, odd)).matched_customer_id, "c_blank");
  });

  test("long notes are shortened for the item name", async () => {
    const long = "Tom took " + "a very large order of assorted pastries ".repeat(3) + "for $80";
    const out = await note(long);
    assert.equal(out.items[0].name.length, 60);
    assert.ok(out.items[0].name.endsWith("..."));
  });
});

describe("due date resolution (rules)", () => {
  test("every weekday resolves to its next occurrence, 1-7 days ahead", async () => {
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (const [idx, name] of names.entries()) {
      const { due_date } = await note(`Tom pays ${name}, $10`);
      assert.match(due_date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(weekdayOf(due_date), idx, `${name} -> ${due_date}`);
      const ahead = (Date.parse(due_date) - Date.parse(WEDNESDAY)) / 86400_000;
      assert.ok(ahead >= 1 && ahead <= 7, `${name} is ${ahead} days ahead`);
    }
  });

  test("the weekday that is today means next week, not today", async () => {
    assert.equal((await note("Tom pays Wednesday, $10")).due_date, "2026-11-18");
  });

  test("no day mentioned -> 7 days from today", async () => {
    assert.equal((await note("Tom took bread, $10")).due_date, "2026-11-18");
  });

  test("rolls over month and year ends", async () => {
    assert.equal((await note("Tom pays Friday, $10", "2026-12-30")).due_date, "2027-01-01");
    assert.equal((await note("Tom pays Monday, $10", "2028-02-26")).due_date, "2028-02-28");
    assert.equal((await note("Tom took bread, $10", "2028-02-26")).due_date, "2028-03-04"); // leap year
  });
});

describe("messages (rules)", () => {
  const invoice = { customerName: "Priya Shah", amount: 90, currency: "USD", dueDate: "2026-11-13", items: [{ name: "Cupcakes", quantity: 3, unitPrice: 30 }], customerLanguage: "English" };

  for (const kind of ["invoice", "reminder", "firm_reminder", "split_offer"]) {
    test(`${kind}: names the customer, the amount and signs off as the owner`, async () => {
      const out = await ai.writeMessage({ kind, invoice, business, daysLate: 9 });
      assert.equal(out.source, "rules");
      assert.equal(out.english, out.message);
      assert.match(out.message, /^Hi Priya/);
      assert.match(out.message, /90\.00 USD/);
      assert.ok(out.message.endsWith("— Rosa"));
      assert.equal(out.subject, "Rosa's Kitchen: invoice for 90.00 USD");
    });
  }

  test("firm reminder states the due date and how late it is", async () => {
    const out = await ai.writeMessage({ kind: "firm_reminder", invoice, business, daysLate: 9 });
    assert.match(out.message, /2026-11-13 \(9 days ago\)/);
  });
});

describe("follow-up planner (rules)", () => {
  const inv = (o) => ({ id: "x", customer: "X", outstanding: 50, dueDate: "2026-11-20", daysLate: 0, remindersSent: 0, lastReminderDaysAgo: null, status: "SENT", ...o });
  const plan = (o) => ai.planCollections({ today: WEDNESDAY, business, cash: 750, bills: [], invoices: [], ...o });
  const actionFor = async (o) => (await plan({ invoices: [inv(o)] })).actions[0];

  test("picks an action per invoice", async () => {
    assert.equal((await actionFor({ daysLate: 0 })).action, "remind");
    assert.equal((await actionFor({ daysLate: 3, outstanding: 100 })).action, "remind");
    assert.equal((await actionFor({ daysLate: 3, outstanding: 200 })).action, "split_offer");
    assert.equal((await actionFor({ daysLate: 0, outstanding: 200 })).action, "remind"); // not late: no split offer
    assert.equal((await actionFor({ daysLate: 7, outstanding: 100 })).action, "remind");
    assert.equal((await actionFor({ daysLate: 8, outstanding: 100 })).action, "firm_reminder");
    assert.equal((await actionFor({ daysLate: 30, outstanding: 500 })).action, "firm_reminder");
  });

  test("leaves people alone if they were reminded in the last 2 days", async () => {
    assert.equal((await actionFor({ daysLate: 30, lastReminderDaysAgo: 0 })).action, "wait");
    assert.equal((await actionFor({ daysLate: 30, lastReminderDaysAgo: 1 })).action, "wait");
    assert.equal((await actionFor({ daysLate: 30, lastReminderDaysAgo: 2 })).action, "firm_reminder");
  });

  test("orders by lateness, then by amount, and gives a reason", async () => {
    const out = await plan({ invoices: [
      inv({ id: "small", daysLate: 2, outstanding: 20 }),
      inv({ id: "notdue", daysLate: 0, outstanding: 900, dueDate: "2026-11-15" }),
      inv({ id: "latest", daysLate: 9, outstanding: 140 }),
      inv({ id: "big", daysLate: 2, outstanding: 96 }),
    ] });
    assert.equal(out.source, "rules");
    assert.deepEqual(out.actions.map((a) => a.invoice_id), ["latest", "big", "small", "notdue"]);
    assert.equal(out.actions[0].reason, "9 days late, 140.00 outstanding");
    assert.equal(out.actions[3].reason, "Due 2026-11-15");
  });

  test("shortfall is measured against the next bill", async () => {
    const out = await plan({ cash: 750, bills: [
      { name: "Flour", amount: 280, dueDate: "2026-11-17" },
      { name: "Rent", amount: 1200, dueDate: "2026-11-13" },
    ] });
    assert.equal(out.shortfall, 450);
    assert.equal(out.headline, "You're $450 short for Rent on Friday.");
  });

  test("covered when cash meets the next bill, or there are no bills", async () => {
    const covered = await plan({ cash: 1200, bills: [{ name: "Rent", amount: 1200, dueDate: "2026-11-13" }] });
    assert.equal(covered.shortfall, 0);
    assert.equal(covered.headline, "You're covered for your next bill.");
    const none = await plan({ cash: 0, bills: [] });
    assert.equal(none.shortfall, 0);
    assert.deepEqual(none.actions, []);
  });

  test("a bill whose date has already passed is not the 'next bill'", async () => {
    const out = await plan({ cash: 750, bills: [
      { name: "Old rent", amount: 5000, dueDate: "2026-10-01" },
      { name: "Flour", amount: 800, dueDate: "2026-11-17" },
    ] });
    assert.equal(out.shortfall, 50);
    assert.match(out.headline, /short for Flour on Tuesday/);
    const onlyPast = await plan({ cash: 750, bills: [{ name: "Old rent", amount: 5000, dueDate: "2026-10-01" }] });
    assert.equal(onlyPast.shortfall, 0);
    // A bill due today still counts.
    const dueToday = await plan({ cash: 750, bills: [{ name: "Rent", amount: 1000, dueDate: WEDNESDAY }] });
    assert.equal(dueToday.shortfall, 250);
  });

  test("explanation totals what is owed", async () => {
    const out = await plan({ cash: 750, invoices: [inv({ outstanding: 140 }), inv({ id: "y", outstanding: 96 })] });
    assert.match(out.explanation, /\$750 now/);
    assert.match(out.explanation, /owe you \$236/);
  });
});

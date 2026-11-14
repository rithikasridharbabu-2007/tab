// lib/store.js: the JSON-file store and its date helpers. Uses a throwaway DATA_DIR.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tab-store-test-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.SANDBOX_BUYER_EMAIL;
const FILE = path.join(DATA_DIR, "db.json");
const store = await import("../lib/store.js");
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const onDisk = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
// A fresh copy of the module (its in-memory cache is per module instance).
let n = 0;
const freshStore = () => import(`../lib/store.js?instance=${++n}`);

describe("date helpers", () => {
  test("addDays crosses months, years and leap days, in both directions", () => {
    assert.equal(store.addDays("2026-11-13", 0), "2026-11-13");
    assert.equal(store.addDays("2026-11-13", 14), "2026-11-27");
    assert.equal(store.addDays("2026-11-28", 3), "2026-12-01");
    assert.equal(store.addDays("2026-12-30", 3), "2027-01-02");
    assert.equal(store.addDays("2026-01-02", -3), "2025-12-30");
    assert.equal(store.addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(store.addDays("2027-02-28", 1), "2027-03-01");
  });

  test("addDays is not thrown off by daylight-saving changes", () => {
    assert.equal(store.addDays("2026-03-07", 1), "2026-03-08");
    assert.equal(store.addDays("2026-03-08", 1), "2026-03-09");
    assert.equal(store.addDays("2026-10-31", 2), "2026-11-02");
  });

  test("today is the local calendar date as YYYY-MM-DD", () => {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const t = store.today();
    assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
    // Allow for the clock ticking past midnight between the two reads.
    assert.ok(t === local || t === store.addDays(local, 1), `${t} vs ${local}`);
  });

  test("newId is prefixed and unique", () => {
    const ids = new Set(Array.from({ length: 500 }, () => store.newId("inv")));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^inv_[0-9a-f]{10}$/);
  });
});

describe("load / save / reset", () => {
  test("first load seeds the example data and writes it to disk", () => {
    assert.equal(fs.existsSync(FILE), false);
    const db = store.load();
    assert.deepEqual(Object.keys(db).sort(), ["activity", "bills", "business", "cash", "customers", "invoices"]);
    assert.deepEqual(onDisk(), db);
  });

  test("load returns the same in-memory object every time", () => {
    assert.equal(store.load(), store.load());
  });

  test("seed data is internally consistent", () => {
    const db = store.load();
    const t = store.today();
    assert.equal(db.business.currency, "USD");
    assert.ok(db.cash > 0);
    for (const inv of db.invoices) {
      assert.equal(inv.amount, inv.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
      assert.ok(inv.paidAmount <= inv.amount);
      assert.equal(inv.sample, true, "sample invoices must never reach PayPal");
      assert.equal(inv.paypalId, null);
      assert.match(inv.dueDate, /^\d{4}-\d{2}-\d{2}$/);
      const customer = db.customers.find((c) => c.id === inv.customerId);
      assert.ok(customer, `${inv.id} points at a known customer`);
      assert.equal(inv.customerName, customer.name);
    }
    assert.equal(db.invoices.find((i) => i.status === "PAID").paidAmount, db.invoices.find((i) => i.status === "PAID").amount);
    for (const bill of db.bills) assert.ok(bill.dueDate > t && bill.dueDate <= store.addDays(t, 14), "bills fall inside the 14-day outlook");
  });

  test("seed data only uses reserved example.com addresses", () => {
    const db = store.load();
    for (const c of db.customers) assert.match(c.email, /@example\.com$/);
    for (const i of db.invoices) assert.match(i.customerEmail, /@example\.com$/);
  });

  test("save persists changes atomically (no temp file left behind)", () => {
    const db = store.load();
    db.cash = 1234.56;
    db.activity.unshift({ at: "2026-11-13T00:00:00.000Z", text: "test", kind: "info" });
    store.save();
    assert.equal(onDisk().cash, 1234.56);
    assert.equal(onDisk().activity[0].text, "test");
    assert.deepEqual(fs.readdirSync(DATA_DIR), ["db.json"]);
  });

  test("save creates the data directory if it is missing", () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    store.save();
    assert.equal(onDisk().cash, 1234.56);
  });

  test("reset restores the example data in memory and on disk", () => {
    const db = store.reset();
    assert.equal(db.cash, 750);
    assert.deepEqual(db.activity, []);
    assert.equal(store.load(), db);
    assert.equal(onDisk().cash, 750);
  });

  test("a new process reads what the last one saved", async () => {
    const db = store.load();
    db.cash = 42;
    db.customers.push({ id: "c_new", name: "New Person", email: "new@example.com", language: "English", usual: "" });
    store.save();
    const again = (await freshStore()).load();
    assert.notEqual(again, db);
    assert.deepEqual(again, db);
    store.reset();
  });

  test("SANDBOX_BUYER_EMAIL replaces the placeholder customer email on load", async () => {
    assert.equal(onDisk().customers[0].email, "customer@example.com");
    process.env.SANDBOX_BUYER_EMAIL = "buyer@personal.example.com";
    try {
      const db = (await freshStore()).load();
      assert.equal(db.customers[0].email, "buyer@personal.example.com");
      assert.equal(db.customers[1].email, "marco@example.com");
    } finally {
      delete process.env.SANDBOX_BUYER_EMAIL;
    }
  });

  test("an unreadable data file falls back to the example data instead of crashing", async () => {
    fs.writeFileSync(FILE, "{ not json");
    const db = (await freshStore()).load();
    assert.equal(db.cash, 750);
    assert.equal(onDisk().cash, 750);
  });
});

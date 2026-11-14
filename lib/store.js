// Tiny JSON-file store. Good enough for a single-owner prototype; swap for a DB later.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const FILE = path.join(DATA_DIR, "db.json");

// Local calendar date (the owner thinks in their own days, not UTC).
export const localDate = (when) => new Date(when).toLocaleDateString("en-CA");
export const today = () => localDate(Date.now());
export const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;

let db = null;

export function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // If the sandbox buyer email was configured after the demo data was created, use it now.
    const buyer = process.env.SANDBOX_BUYER_EMAIL;
    if (buyer) for (const c of db.customers) if (c.email === "customer@example.com") c.email = buyer;
  } catch {
    db = seed();
    save();
  }
  return db;
}

export function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export function reset() {
  db = seed();
  save();
  return db;
}

// Demo data: a home bakery with a few customers and the usual mess of who-owes-what.
// Sample invoices are marked `sample: true` - they never touch PayPal.
function seed() {
  const t = today();
  const buyer = process.env.SANDBOX_BUYER_EMAIL || "customer@example.com";
  const customers = [
    { id: "c_priya", name: "Priya Shah", email: buyer, language: "English", usual: "Cupcakes, $30 a dozen" },
    { id: "c_marco", name: "Marco Rossi", email: "marco@example.com", language: "Italian", usual: "Birthday cake, $70" },
    { id: "c_aisha", name: "Aisha Bello", email: "aisha@example.com", language: "English", usual: "Cookies, $24 a dozen" },
    { id: "c_daniela", name: "Daniela López", email: "daniela@example.com", language: "Spanish", usual: "Wedding cupcakes" },
    { id: "c_james", name: "James Okafor", email: "james@example.com", language: "English", usual: "Weekly sourdough, $15 a loaf" },
  ];
  const inv = (o) => ({
    currency: "USD",
    createdAt: new Date().toISOString(),
    paidAmount: 0,
    remindersSent: 0,
    lastReminderAt: null,
    paypalId: null,
    payerUrl: null,
    number: null,
    sample: true,
    history: [],
    ...o,
    amount: o.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0),
  });
  const invoices = [
    inv({
      id: "inv_marco", customerId: "c_marco", customerName: "Marco Rossi", customerEmail: "marco@example.com", customerLanguage: "Italian",
      items: [{ name: "Birthday cake (chocolate)", quantity: 2, unitPrice: 70 }], dueDate: addDays(t, -9), status: "SENT",
      remindersSent: 1, lastReminderAt: addDays(t, -6) + "T15:00:00Z",
      history: [{ at: addDays(t, -16) + "T10:00:00Z", type: "sent", text: "Invoice sent" }, { at: addDays(t, -6) + "T15:00:00Z", type: "reminder", text: "Friendly reminder sent" }],
    }),
    inv({
      id: "inv_aisha", customerId: "c_aisha", customerName: "Aisha Bello", customerEmail: "aisha@example.com", customerLanguage: "English",
      items: [{ name: "Cookies (dozen)", quantity: 4, unitPrice: 24 }], dueDate: addDays(t, -2), status: "SENT",
      history: [{ at: addDays(t, -9) + "T10:00:00Z", type: "sent", text: "Invoice sent" }],
    }),
    inv({
      id: "inv_daniela", customerId: "c_daniela", customerName: "Daniela López", customerEmail: "daniela@example.com", customerLanguage: "Spanish",
      items: [{ name: "Wedding cupcakes (dozen)", quantity: 8, unitPrice: 40 }], dueDate: addDays(t, 3), status: "PARTIALLY_PAID", paidAmount: 100,
      history: [{ at: addDays(t, -5) + "T10:00:00Z", type: "sent", text: "Invoice sent" }, { at: addDays(t, -3) + "T18:20:00Z", type: "payment", text: "Paid 100.00 USD" }],
    }),
    inv({
      id: "inv_james", customerId: "c_james", customerName: "James Okafor", customerEmail: "james@example.com", customerLanguage: "English",
      items: [{ name: "Sourdough loaf", quantity: 4, unitPrice: 15 }], dueDate: addDays(t, -4), status: "PAID", paidAmount: 60,
      history: [{ at: addDays(t, -10) + "T10:00:00Z", type: "sent", text: "Invoice sent" }, { at: addDays(t, -5) + "T09:00:00Z", type: "payment", text: "Paid 60.00 USD" }],
    }),
  ];
  return {
    business: {
      businessName: "Rosa's Kitchen",
      ownerName: "Rosa Martínez",
      description: "a home bakery selling cakes, cupcakes, cookies and bread to neighbours and local events",
      currency: "USD",
      toneSample: "Hi love! Thank you so much for the order 💛 Let me know how everyone liked it! — Rosa",
    },
    cash: 750,
    bills: [
      { id: "b_rent", name: "Rent", amount: 1200, dueDate: addDays(t, 3) },
      { id: "b_flour", name: "Flour & butter supplier", amount: 280, dueDate: addDays(t, 6) },
    ],
    customers,
    invoices,
    activity: [],
  };
}

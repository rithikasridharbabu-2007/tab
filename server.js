import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
import * as store from "./lib/store.js";
import * as paypal from "./lib/paypal.js";
import * as ai from "./lib/ai.js";
import { OPEN, viewInvoice, cashOutlook } from "./lib/forecast.js";

dotenv.config({ path: path.join(HERE, ".env"), quiet: true });

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(HERE, "public")));

const PORT = Number(process.env.PORT || 3000);
// ------------------------------------------------------------------ helpers
const db = () => store.load();
// The invoice view and the 14-day cash outlook are pure functions in lib/forecast.js.
const view = (inv) => viewInvoice(inv, store.today());
const forecast = () => cashOutlook(db(), store.today());

function log(text, kind = "info") {
  const d = db();
  d.activity.unshift({ at: new Date().toISOString(), text, kind });
  d.activity = d.activity.slice(0, 60);
}

function commit() {
  store.save();
  broadcast();
}

function findInvoice(id) {
  const inv = db().invoices.find((i) => i.id === id);
  if (!inv) throw httpError(404, "Invoice not found");
  return inv;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const isSimulated = (inv) => inv.sample || !inv.paypalId || inv.paypalId.startsWith("SIM-");

// Apply a payment/status change coming from PayPal (webhook or poll) or from the simulator.
function applyPayPalStatus(inv, { status, paidAmount }, via) {
  const before = inv.paidAmount;
  const beforeStatus = inv.status;
  if (typeof paidAmount === "number" && paidAmount > before) {
    const delta = +(paidAmount - before).toFixed(2);
    inv.paidAmount = paidAmount;
    db().cash = +(db().cash + delta).toFixed(2);
    inv.history.push({ at: new Date().toISOString(), type: "payment", text: `Paid ${delta.toFixed(2)} ${inv.currency} (${via})` });
    log(`${inv.customerName} paid ${delta.toFixed(2)} ${inv.currency}${via === "cash" ? " in cash" : ""}`, "payment");
  }
  if (status && status !== beforeStatus) {
    inv.status = status;
    if (status === "CANCELLED") log(`Invoice for ${inv.customerName} cancelled`, "info");
  }
  return inv.paidAmount !== before || inv.status !== beforeStatus;
}

// ------------------------------------------------------------------ live updates (Server-Sent Events)
const clients = new Set();
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  res.write("retry: 3000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
function broadcast() {
  const payload = `data: ${JSON.stringify(statePayload())}\n\n`;
  for (const c of clients) c.write(payload);
}
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25_000);

// ------------------------------------------------------------------ state
let incomeCache = { at: 0, value: null };
async function paypalIncome() {
  if (!paypal.paypalEnabled()) return null;
  if (Date.now() - incomeCache.at < 5 * 60_000) return incomeCache.value;
  try {
    incomeCache = { at: Date.now(), value: await paypal.recentIncome(7) };
  } catch (e) {
    incomeCache = { at: Date.now(), value: { error: "Transaction Search not available yet (sandbox data can lag a few hours)" } };
  }
  return incomeCache.value;
}

function statePayload() {
  const d = db();
  return {
    business: d.business,
    cash: d.cash,
    bills: d.bills,
    customers: d.customers,
    invoices: d.invoices.map(view).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    activity: d.activity,
    forecast: forecast(),
    income: incomeCache.value,
    modes: { ai: ai.aiEnabled(), aiLabel: ai.aiProvider()?.label || null, aiError: ai.lastAIError, paypal: paypal.paypalEnabled(), env: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox", webhooks: Boolean(process.env.PAYPAL_WEBHOOK_ID) },
    today: store.today(),
  };
}

app.get("/api/state", async (_req, res) => {
  await paypalIncome();
  res.json(statePayload());
});

app.put("/api/settings", (req, res) => {
  const d = db();
  const { cash, bills, business } = req.body || {};
  if (typeof cash === "number" && cash >= 0) d.cash = cash;
  if (Array.isArray(bills)) {
    d.bills = bills
      .filter((b) => b && b.name && Number(b.amount) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate))
      .map((b) => ({ id: b.id || store.newId("b"), name: String(b.name).slice(0, 80), amount: Number(b.amount), dueDate: b.dueDate }));
  }
  if (business && typeof business === "object") {
    for (const k of ["businessName", "ownerName", "description", "toneSample"]) if (typeof business[k] === "string") d.business[k] = business[k].slice(0, 600);
  }
  commit();
  res.json(statePayload());
});

app.post("/api/reset", (_req, res) => {
  store.reset();
  broadcast();
  res.json(statePayload());
});

// ------------------------------------------------------------------ 1. voice note -> draft invoice
app.post("/api/notes", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) throw httpError(400, "Say or type what the customer bought.");
  const d = db();
  const parsed = await ai.understandNote({ text: text.slice(0, 3000), today: store.today(), business: d.business, customers: d.customers });
  const known = d.customers.find((c) => c.id === parsed.matched_customer_id);
  res.json({
    noteText: text,
    customerId: known?.id || null,
    customerName: known?.name || parsed.customer_name,
    customerEmail: parsed.customer_email || known?.email || process.env.SANDBOX_BUYER_EMAIL || "",
    customerLanguage: parsed.customer_language || known?.language || "English",
    items: parsed.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unit_price })),
    currency: parsed.currency || d.business.currency,
    dueDate: parsed.due_date,
    noteLanguage: parsed.note_language,
    summary: parsed.summary,
    questions: parsed.questions,
    source: parsed.source,
  });
});

// ------------------------------------------------------------------ 2. preview a message
app.post("/api/messages/preview", async (req, res) => {
  const d = db();
  const { kind = "invoice", invoiceId, draft } = req.body || {};
  const inv = invoiceId ? view(findInvoice(invoiceId)) : normalizeDraft(draft);
  res.json(await ai.writeMessage({ kind, invoice: inv, business: d.business, daysLate: inv.daysLate || 0 }));
});

function normalizeDraft(draft) {
  if (!draft) throw httpError(400, "Missing invoice details");
  const items = (draft.items || [])
    .map((i) => ({ name: String(i.name || "").trim().slice(0, 200), quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) }))
    .filter((i) => i.name && i.quantity > 0 && i.unitPrice >= 0);
  if (!items.length) throw httpError(400, "Add at least one item");
  const amount = +items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toFixed(2);
  if (amount <= 0) throw httpError(400, "The invoice total must be more than 0 — what's the price?");
  if (!draft.customerName) throw httpError(400, "Who is the customer?");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate || "")) throw httpError(400, "Due date must be YYYY-MM-DD");
  return {
    customerName: String(draft.customerName).slice(0, 140),
    customerEmail: String(draft.customerEmail || "").trim(),
    customerLanguage: draft.customerLanguage || "English",
    customerId: draft.customerId || null,
    items,
    amount,
    currency: (draft.currency || "USD").toUpperCase(),
    dueDate: draft.dueDate,
    paidAmount: 0,
    remindersSent: 0,
    daysLate: 0,
    noteText: draft.noteText || "",
  };
}

// ------------------------------------------------------------------ 3. create + send a PayPal invoice
app.post("/api/invoices", async (req, res) => {
  const d = db();
  const base = normalizeDraft(req.body?.draft);
  if (paypal.paypalEnabled() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(base.customerEmail)) throw httpError(400, "PayPal needs the customer's email to send the invoice");
  const msg = req.body?.message?.message ? req.body.message : await ai.writeMessage({ kind: "invoice", invoice: base, business: d.business, daysLate: 0 });

  // remember / update the customer
  let customer = d.customers.find((c) => c.id === base.customerId) || d.customers.find((c) => c.name.toLowerCase() === base.customerName.toLowerCase());
  if (!customer) {
    customer = { id: store.newId("c"), name: base.customerName, email: base.customerEmail, language: base.customerLanguage, usual: "" };
    d.customers.push(customer);
  } else {
    if (base.customerEmail) customer.email = base.customerEmail;
    customer.language = base.customerLanguage;
  }

  const inv = {
    ...base,
    id: store.newId("inv"),
    customerId: customer.id,
    createdAt: new Date().toISOString(),
    status: "DRAFT",
    paypalId: null,
    payerUrl: null,
    number: null,
    message: msg.message,
    messageEnglish: msg.english,
    lastReminderAt: null,
    sample: false,
    history: [{ at: new Date().toISOString(), type: "note", text: base.noteText ? `Voice note: “${base.noteText}”` : "Created by hand" }],
  };
  delete inv.daysLate;

  if (paypal.paypalEnabled()) {
    const created = await paypal.createInvoice(inv, d.business);
    inv.paypalId = created.id;
    const sent = await paypal.sendInvoice(created.id, { subject: msg.subject, note: msg.message, requestId: `tab-send-${inv.id}` });
    Object.assign(inv, { status: sent.status, number: sent.number, payerUrl: sent.payerUrl });
  } else {
    Object.assign(inv, { paypalId: `SIM-${inv.id}`, status: "SENT", number: `SIM-${String(d.invoices.length + 1).padStart(4, "0")}` });
  }
  inv.history.push({ at: new Date().toISOString(), type: "sent", text: `Invoice sent via PayPal${isSimulated(inv) ? " (simulated)" : ""} in ${inv.customerLanguage}` });
  d.invoices.push(inv);
  log(`Sent ${inv.customerName} an invoice for ${inv.amount.toFixed(2)} ${inv.currency}`, "sent");
  commit();
  res.json(view(inv));
});

// ------------------------------------------------------------------ 4. follow-ups
async function followUp(inv, kind, message) {
  const d = db();
  const v = view(inv);
  if (!OPEN.has(inv.status)) throw httpError(400, `This invoice is ${inv.status.toLowerCase()}, nothing to chase.`);
  const msg = message?.message ? message : await ai.writeMessage({ kind, invoice: v, business: d.business, daysLate: v.daysLate });
  const requestId = `tab-${kind}-${inv.id}-${(inv.remindersSent || 0) + 1}`;
  if (!isSimulated(inv)) {
    if (kind === "split_offer" && !inv.allowPartial) {
      const half = Math.max(1, Math.ceil(v.outstanding / 2));
      try {
        await paypal.allowPartialPayment(inv.paypalId, half, inv.currency, `${requestId}-partial`);
        inv.allowPartial = true;
      } catch (e) {
        // Still send the message; the owner can enable partial payments on PayPal by hand.
        console.error("could not enable partial payment", e.message);
        log(`PayPal didn't accept partial payments for ${inv.customerName}'s invoice: ${e.message}`, "error");
      }
    }
    await paypal.remindInvoice(inv.paypalId, { subject: msg.subject, note: msg.message, requestId });
  } else if (kind === "split_offer") {
    inv.allowPartial = true;
  }
  inv.remindersSent = (inv.remindersSent || 0) + 1;
  inv.lastReminderAt = new Date().toISOString();
  const label = { remind: "Friendly reminder", reminder: "Friendly reminder", firm_reminder: "Firm reminder", split_offer: "Offered to split into 2 payments" }[kind] || kind;
  inv.history.push({ at: inv.lastReminderAt, type: "reminder", text: `${label} sent in ${inv.customerLanguage}: “${msg.english}”` });
  log(`${label} to ${inv.customerName}`, "reminder");
  return msg;
}

app.post("/api/invoices/:id/follow-up", async (req, res) => {
  const inv = findInvoice(req.params.id);
  const kind = ["reminder", "firm_reminder", "split_offer"].includes(req.body?.kind) ? req.body.kind : "reminder";
  await followUp(inv, kind, req.body?.message);
  commit();
  res.json(view(inv));
});

app.post("/api/invoices/:id/cancel", async (req, res) => {
  const inv = findInvoice(req.params.id);
  if (!OPEN.has(inv.status)) throw httpError(400, "Only open invoices can be cancelled");
  if (!isSimulated(inv)) await paypal.cancelInvoice(inv.paypalId, { note: "This invoice has been cancelled.", requestId: `tab-cancel-${inv.id}` });
  inv.status = "CANCELLED";
  inv.history.push({ at: new Date().toISOString(), type: "cancel", text: "Cancelled" });
  log(`Cancelled ${inv.customerName}'s invoice`);
  commit();
  res.json(view(inv));
});

// "Got paid in cash": records the payment on the PayPal invoice so the books stay right,
// even when the customer paid outside PayPal. Sample/simulated invoices are updated locally.
app.post("/api/invoices/:id/mark-paid", async (req, res) => {
  const inv = findInvoice(req.params.id);
  if (!OPEN.has(inv.status)) throw httpError(400, "This one is already settled.");
  const v = view(inv);
  const amount = req.body?.amount ? Math.min(Number(req.body.amount), v.outstanding) : v.outstanding;
  if (!(amount > 0)) throw httpError(400, "Nothing left to pay.");
  if (!isSimulated(inv)) {
    await paypal.recordPayment(inv.paypalId, amount, inv.currency, store.today(), `tab-cash-${inv.id}-${inv.paidAmount}`);
    const pp = await paypal.getInvoice(inv.paypalId);
    applyPayPalStatus(inv, pp, "cash");
  } else {
    const paid = +(inv.paidAmount + amount).toFixed(2);
    applyPayPalStatus(inv, { paidAmount: paid, status: paid >= inv.amount ? "PAID" : "PARTIALLY_PAID" }, "cash");
  }
  commit();
  res.json(view(inv));
});

app.post("/api/invoices/:id/refresh", async (req, res) => {
  const inv = findInvoice(req.params.id);
  if (!isSimulated(inv)) {
    const pp = await paypal.getInvoice(inv.paypalId);
    applyPayPalStatus(inv, pp, "PayPal");
    inv.payerUrl = pp.payerUrl || inv.payerUrl;
    commit();
  }
  res.json(view(inv));
});

// ------------------------------------------------------------------ 5. the collections agent
// The plan is cached until something it depends on changes, so the home screen can show it
// every time without spending an AI call per page load.
let planCache = { key: null, plan: null };
function planKey() {
  const d = db();
  return JSON.stringify([store.today(), d.cash, d.bills, d.invoices.filter((i) => OPEN.has(i.status)).map((i) => [i.id, i.paidAmount, i.remindersSent, i.lastReminderAt, i.dueDate])]);
}
app.get("/api/plan", async (req, res) => {
  const key = planKey();
  if (planCache.key !== key || req.query.fresh) planCache = { key, plan: await makePlan() };
  res.json({ ...planCache.plan, forecast: forecast() });
});
app.post("/api/plan", async (_req, res) => {
  planCache = { key: planKey(), plan: await makePlan() };
  res.json({ ...planCache.plan, forecast: forecast() });
});
async function makePlan() {
  const d = db();
  const open = d.invoices.filter((i) => OPEN.has(i.status)).map(view);
  const plan = await ai.planCollections({
    today: store.today(),
    business: d.business,
    cash: d.cash,
    bills: d.bills,
    invoices: open.map((i) => ({
      id: i.id, customer: i.customerName, outstanding: i.outstanding, dueDate: i.dueDate, daysLate: i.daysLate,
      remindersSent: i.remindersSent, lastReminderDaysAgo: i.lastReminderDaysAgo, status: i.status, language: i.customerLanguage,
      paymentHistory: d.invoices.filter((x) => x.customerId === i.customerId && x.id !== i.id).map((x) => ({ status: x.status, dueDate: x.dueDate })),
    })),
  });
  const ids = new Set(open.map((i) => i.id));
  plan.actions = plan.actions.filter((a) => ids.has(a.invoice_id)).map((a) => ({ ...a, customer: open.find((i) => i.id === a.invoice_id).customerName, outstanding: open.find((i) => i.id === a.invoice_id).outstanding }));
  return plan;
}

// Owner approved some or all of the plan: carry it out.
app.post("/api/plan/run", async (req, res) => {
  const actions = Array.isArray(req.body?.actions) ? req.body.actions.slice(0, 20) : [];
  const results = [];
  for (const a of actions) {
    if (a.action === "wait") continue;
    try {
      const inv = findInvoice(a.invoice_id);
      const kind = a.action === "remind" ? "reminder" : a.action;
      if (!["reminder", "firm_reminder", "split_offer"].includes(kind)) throw httpError(400, "Unknown action");
      const msg = await followUp(inv, kind);
      results.push({ invoice_id: a.invoice_id, ok: true, english: msg.english });
    } catch (e) {
      results.push({ invoice_id: a.invoice_id, ok: false, error: e.message });
    }
  }
  log(`Sent ${results.filter((r) => r.ok).length} follow-ups from today's plan`, "agent");
  commit();
  res.json({ results, state: statePayload() });
});

// ------------------------------------------------------------------ 6. PayPal webhooks
app.post("/api/webhooks/paypal", async (req, res) => {
  const event = req.body;
  let verified = false;
  try { verified = await paypal.verifyWebhook(req.headers, event); } catch (e) { console.error("webhook verify failed", e.message); }
  if (!verified) return res.status(400).json({ error: "signature not verified" });
  const resource = event.resource?.invoice || event.resource;
  const paypalId = resource?.id;
  const inv = db().invoices.find((i) => i.paypalId === paypalId);
  if (inv) {
    try {
      const pp = await paypal.getInvoice(paypalId); // re-read the source of truth
      if (applyPayPalStatus(inv, pp, `webhook ${event.event_type}`)) commit();
    } catch (e) { console.error("webhook refresh failed", e.message); }
  }
  res.json({ ok: true });
});

// Poll as a backup (webhooks can't reach localhost).
async function pollOpenInvoices() {
  if (!paypal.paypalEnabled()) return;
  let changed = false;
  for (const inv of db().invoices.filter((i) => OPEN.has(i.status) && !isSimulated(i))) {
    try {
      const pp = await paypal.getInvoice(inv.paypalId);
      if (applyPayPalStatus(inv, pp, "PayPal")) changed = true;
      if (pp.payerUrl && !inv.payerUrl) { inv.payerUrl = pp.payerUrl; changed = true; }
    } catch (e) { console.error("poll failed", inv.id, e.message); }
  }
  if (changed) commit();
}
setInterval(pollOpenInvoices, Number(process.env.POLL_SECONDS || 15) * 1000);

// ------------------------------------------------------------------ errors
app.use("/api", (_req, _res, next) => next(httpError(404, "Not found")));
app.use((err, _req, res, _next) => {
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(err instanceof paypal.PayPalError ? 502 : status).json({ error: err.message || "Something went wrong" });
});

app.listen(PORT, () => {
  store.load();
  console.log(`Tab running on http://localhost:${PORT}`);
  console.log(`  AI: ${ai.aiProvider()?.label || "OFF - rule-based fallback (set GEMINI_API_KEY or ANTHROPIC_API_KEY)"}`);
  console.log(`  PayPal: ${paypal.paypalEnabled() ? (process.env.PAYPAL_ENV === "live" ? "LIVE" : "sandbox") : "OFF - simulated (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)"}`);
});

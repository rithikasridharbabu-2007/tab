// PayPal REST client for Tab (sandbox by default).
// Uses the Invoicing v2 API for the money flow and the Webhooks API for live status.
// When no credentials are configured, Tab runs in "simulated PayPal" mode so the app
// can still be explored; the UI makes that mode visible.
import crypto from "node:crypto";

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export const paypalEnabled = () =>
  Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalError("Could not get PayPal access token", res.status, await res.text());
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

export class PayPalError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Every mutating call carries a PayPal-Request-Id so a retry never creates a
// second invoice or sends a second reminder.
async function call(method, path, { body, requestId, prefer = "return=representation" } = {}) {
  const headers = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: prefer,
  };
  if (method !== "GET") headers["PayPal-Request-Id"] = requestId || crypto.randomUUID();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const detail = json?.details?.map((d) => `${d.field || ""} ${d.issue || ""} ${d.description || ""}`.trim()).join("; ");
    throw new PayPalError(`PayPal ${method} ${path} failed: ${json?.message || res.status}${detail ? ` (${detail})` : ""}`, res.status, json);
  }
  return json;
}

const money = (value, currency) => ({ currency_code: currency, value: Number(value).toFixed(2) });

function splitName(full = "") {
  const parts = full.trim().split(/\s+/);
  return { given_name: parts[0] || "Customer", surname: parts.slice(1).join(" ") || undefined };
}

/** Create a draft invoice. Returns { id, status, number, payerUrl }. */
export async function createInvoice(inv, business) {
  const body = {
    detail: {
      currency_code: inv.currency,
      invoice_date: new Date().toISOString().slice(0, 10),
      payment_term: { due_date: inv.dueDate },
      note: inv.message?.slice(0, 4000) || undefined,
      memo: `Created by Tab from a voice note. Local id ${inv.id}`,
    },
    invoicer: {
      business_name: business.businessName,
      name: splitName(business.ownerName),
    },
    primary_recipients: [
      {
        billing_info: {
          name: splitName(inv.customerName),
          email_address: inv.customerEmail,
        },
      },
    ],
    items: inv.items.map((it) => ({
      name: it.name.slice(0, 200),
      quantity: String(it.quantity),
      unit_amount: money(it.unitPrice, inv.currency),
      unit_of_measure: "QUANTITY",
    })),
    configuration: {
      allow_tip: true,
      partial_payment: inv.allowPartial
        ? { allow_partial_payment: true, minimum_amount_due: money(inv.minimumDue || inv.amount / 2, inv.currency) }
        : { allow_partial_payment: false },
    },
  };
  const created = await call("POST", "/v2/invoicing/invoices", { body, requestId: `tab-create-${inv.id}` });
  // With Prefer: return=representation the full invoice comes back; otherwise only a link.
  const id = created.id || created.href?.split("/").pop();
  return getInvoice(id);
}

export async function sendInvoice(paypalId, { subject, note, requestId }) {
  await call("POST", `/v2/invoicing/invoices/${paypalId}/send`, {
    body: { subject: subject?.slice(0, 4000), note: note?.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true },
    requestId,
  });
  return getInvoice(paypalId);
}

export async function remindInvoice(paypalId, { subject, note, requestId }) {
  await call("POST", `/v2/invoicing/invoices/${paypalId}/remind`, {
    body: { subject: subject?.slice(0, 4000), note: note?.slice(0, 4000), send_to_invoicer: false },
    requestId,
    prefer: "return=minimal",
  });
}

export async function cancelInvoice(paypalId, { note, requestId }) {
  await call("POST", `/v2/invoicing/invoices/${paypalId}/cancel`, {
    body: { note: note?.slice(0, 4000), send_to_invoicer: false, send_to_recipient: true },
    requestId,
    prefer: "return=minimal",
  });
}

/** Turn on partial payments for an already-sent invoice (used for "offer to split"). */
export async function allowPartialPayment(paypalId, minimumDue, currency, requestId) {
  const current = await call("GET", `/v2/invoicing/invoices/${paypalId}`);
  const full = { ...current };
  delete full.links;
  full.configuration = {
    ...(full.configuration || {}),
    partial_payment: { allow_partial_payment: true, minimum_amount_due: money(minimumDue, currency) },
  };
  await call("PUT", `/v2/invoicing/invoices/${paypalId}?send_to_recipient=false&send_to_invoicer=false`, {
    body: full,
    requestId,
  });
  return getInvoice(paypalId);
}

/** Record a payment made outside PayPal (cash, bank transfer) against an invoice. */
export async function recordPayment(paypalId, amount, currency, date, requestId) {
  await call("POST", `/v2/invoicing/invoices/${paypalId}/payments`, {
    body: { method: "CASH", payment_date: date, amount: money(amount, currency), note: "Recorded in Tab" },
    requestId,
    prefer: "return=minimal",
  });
}

export async function getInvoice(paypalId) {
  const inv = await call("GET", `/v2/invoicing/invoices/${paypalId}`);
  return normalize(inv);
}

function normalize(inv) {
  return {
    id: inv.id,
    // DRAFT, SENT, PARTIALLY_PAID, PAID, CANCELLED, ... Payments recorded outside PayPal come back as
    // MARKED_AS_PAID; for the owner that's simply "paid".
    status: inv.status === "MARKED_AS_PAID" ? "PAID" : inv.status,
    number: inv.detail?.invoice_number,
    payerUrl: inv.detail?.metadata?.recipient_view_url || null,
    invoicerUrl: inv.detail?.metadata?.invoicer_view_url || null,
    paidAmount: Number(inv.payments?.paid_amount?.value || 0),
    dueAmount: Number(inv.due_amount?.value ?? inv.amount?.value ?? 0),
  };
}

/** Income actually received in PayPal over the last `days` days (Transaction Search API).
 *  Sandbox data can lag by a few hours, so callers treat a failure as "unknown". */
export async function recentIncome(days = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const q = new URLSearchParams({
    start_date: start.toISOString().replace(/\.\d+Z$/, "Z"),
    end_date: end.toISOString().replace(/\.\d+Z$/, "Z"),
    fields: "transaction_info",
    page_size: "100",
  });
  const json = await call("GET", `/v1/reporting/transactions?${q}`);
  let total = 0;
  for (const t of json.transaction_details || []) {
    const v = Number(t.transaction_info?.transaction_amount?.value || 0);
    if (v > 0) total += v;
  }
  return { total, count: json.transaction_details?.length || 0 };
}

/** Verify a webhook really came from PayPal. */
export async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const json = await call("POST", "/v1/notifications/verify-webhook-signature", {
    body: {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: event,
    },
    prefer: "return=minimal",
  });
  return json?.verification_status === "SUCCESS";
}

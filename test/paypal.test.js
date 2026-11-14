// lib/paypal.js request building. global fetch is replaced with a recorder, so nothing here
// touches the network; the credentials below are dummies.
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_WEBHOOK_ID;
process.env.PAYPAL_CLIENT_ID = "test-client-id";
process.env.PAYPAL_CLIENT_SECRET = "test-client-secret";
const paypal = await import("../lib/paypal.js");

const HOST = "https://api-m.sandbox.paypal.com";
const realFetch = globalThis.fetch;
let calls = [];   // every request made, in order (token requests included)
let routes = [];  // [{ method, match, status, json }] consumed first-match; default is 200 {}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
  calls.push(call);
  if (!call.url.startsWith(HOST + "/")) throw new Error("unexpected host: " + call.url);
  if (call.url === `${HOST}/v1/oauth2/token`) {
    const override = routes.find((r) => r.token);
    if (override) { routes.splice(routes.indexOf(override), 1); return json(override.status, override.json); }
    return json(200, { access_token: "tok-123", expires_in: 3600 });
  }
  const route = routes.find((r) => r.method === call.method && call.url.includes(r.match));
  if (route && !route.sticky) routes.splice(routes.indexOf(route), 1);
  return route ? json(route.status, route.json) : json(200, {});
};
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; routes = []; });

const api = () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));
const bodyOf = (c) => JSON.parse(c.body);
const PP_INVOICE = {
  id: "INV2-AAAA", status: "SENT",
  detail: { invoice_number: "0007", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#AAAA", invoicer_view_url: "https://www.sandbox.paypal.com/invoice/m/AAAA" } },
  payments: { paid_amount: { currency_code: "USD", value: "25.00" } },
  due_amount: { currency_code: "USD", value: "65.00" },
  links: [{ rel: "self", href: "x" }],
};
const localInvoice = {
  id: "inv_abc123", customerName: "Priya Anand Shah", customerEmail: "priya@example.com", currency: "USD", dueDate: "2026-11-20", amount: 91.5,
  message: "Hi Priya!", items: [{ name: "Cupcakes (dozen)", quantity: 3, unitPrice: 30 }, { name: "Delivery", quantity: 1, unitPrice: 1.5 }],
};
const business = { businessName: "Rosa's Kitchen", ownerName: "Rosa Martínez" };

describe("configuration", () => {
  test("paypalEnabled needs both the client id and the secret", () => {
    assert.equal(paypal.paypalEnabled(), true);
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_CLIENT_SECRET;
    assert.equal(paypal.paypalEnabled(), false);
    process.env.PAYPAL_CLIENT_SECRET = secret;
  });
});

describe("authentication", () => {
  test("a failed token request surfaces as a PayPalError and no API call is made", async () => {
    routes.push({ token: true, status: 401, json: { error: "invalid_client" } });
    await assert.rejects(paypal.getInvoice("INV2-AAAA"), (e) => e instanceof paypal.PayPalError && e.status === 401);
    assert.equal(api().length, 0);
  });

  test("gets a client-credentials token with Basic auth, then reuses it", async () => {
    await paypal.getInvoice("INV2-AAAA");
    await paypal.getInvoice("INV2-AAAA");
    const tokenCalls = calls.filter((c) => c.url === `${HOST}/v1/oauth2/token`);
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0].method, "POST");
    assert.equal(tokenCalls[0].body, "grant_type=client_credentials");
    assert.equal(tokenCalls[0].headers.Authorization, "Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"));
    assert.equal(api().length, 2);
    for (const c of api()) assert.equal(c.headers.Authorization, "Bearer tok-123");
  });
});

describe("idempotency: every write carries a PayPal-Request-Id", () => {
  test("reads do not send a PayPal-Request-Id", async () => {
    await paypal.getInvoice("INV2-AAAA");
    assert.equal(api()[0].method, "GET");
    assert.equal(api()[0].url, `${HOST}/v2/invoicing/invoices/INV2-AAAA`);
    assert.equal("PayPal-Request-Id" in api()[0].headers, false);
    assert.equal(api()[0].body, undefined);
  });

  test("createInvoice: id derived from the local invoice id, so a retry reuses it", async () => {
    routes.push({ method: "POST", match: "/v2/invoicing/invoices", status: 201, json: PP_INVOICE, sticky: true });
    routes.push({ method: "GET", match: "/v2/invoicing/invoices/INV2-AAAA", status: 200, json: PP_INVOICE, sticky: true });
    const first = await paypal.createInvoice(localInvoice, business);
    await paypal.createInvoice(localInvoice, business);
    const posts = api().filter((c) => c.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].url, `${HOST}/v2/invoicing/invoices`);
    assert.equal(posts[0].headers["PayPal-Request-Id"], "tab-create-inv_abc123");
    assert.equal(posts[1].headers["PayPal-Request-Id"], "tab-create-inv_abc123");
    assert.equal(posts[0].headers["Content-Type"], "application/json");
    assert.equal(posts[0].headers.Prefer, "return=representation");
    assert.deepEqual(first, { id: "INV2-AAAA", status: "SENT", number: "0007", payerUrl: PP_INVOICE.detail.metadata.recipient_view_url, invoicerUrl: PP_INVOICE.detail.metadata.invoicer_view_url, paidAmount: 25, dueAmount: 65 });
  });

  test("createInvoice: request body", async () => {
    routes.push({ method: "POST", match: "/v2/invoicing/invoices", status: 201, json: PP_INVOICE });
    await paypal.createInvoice(localInvoice, business);
    const body = bodyOf(api()[0]);
    assert.equal(body.detail.currency_code, "USD");
    assert.equal(body.detail.payment_term.due_date, "2026-11-20");
    assert.equal(body.detail.note, "Hi Priya!");
    assert.match(body.detail.invoice_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(body.invoicer, { business_name: "Rosa's Kitchen", name: { given_name: "Rosa", surname: "Martínez" } });
    assert.deepEqual(body.primary_recipients, [{ billing_info: { name: { given_name: "Priya", surname: "Anand Shah" }, email_address: "priya@example.com" } }]);
    assert.deepEqual(body.items, [
      { name: "Cupcakes (dozen)", quantity: "3", unit_amount: { currency_code: "USD", value: "30.00" }, unit_of_measure: "QUANTITY" },
      { name: "Delivery", quantity: "1", unit_amount: { currency_code: "USD", value: "1.50" }, unit_of_measure: "QUANTITY" },
    ]);
    assert.deepEqual(body.configuration.partial_payment, { allow_partial_payment: false });
  });

  test("createInvoice: follows the link when PayPal returns only an href", async () => {
    routes.push({ method: "POST", match: "/v2/invoicing/invoices", status: 201, json: { rel: "self", href: `${HOST}/v2/invoicing/invoices/INV2-BBBB`, method: "GET" } });
    await paypal.createInvoice(localInvoice, business);
    assert.equal(api()[1].method, "GET");
    assert.equal(api()[1].url, `${HOST}/v2/invoicing/invoices/INV2-BBBB`);
  });

  test("sendInvoice", async () => {
    await paypal.sendInvoice("INV2-AAAA", { subject: "Your invoice", note: "Thanks!", requestId: "tab-send-inv_abc123" });
    const [post, get] = api();
    assert.equal(post.method, "POST");
    assert.equal(post.url, `${HOST}/v2/invoicing/invoices/INV2-AAAA/send`);
    assert.equal(post.headers["PayPal-Request-Id"], "tab-send-inv_abc123");
    assert.deepEqual(bodyOf(post), { subject: "Your invoice", note: "Thanks!", send_to_invoicer: false, send_to_recipient: true });
    assert.equal(get.method, "GET");
  });

  test("remindInvoice", async () => {
    await paypal.remindInvoice("INV2-AAAA", { subject: "Reminder", note: "x".repeat(5000), requestId: "tab-reminder-inv_abc123-2" });
    assert.equal(api().length, 1);
    assert.equal(api()[0].url, `${HOST}/v2/invoicing/invoices/INV2-AAAA/remind`);
    assert.equal(api()[0].headers["PayPal-Request-Id"], "tab-reminder-inv_abc123-2");
    assert.equal(bodyOf(api()[0]).note.length, 4000); // PayPal's limit
  });

  test("cancelInvoice", async () => {
    routes.push({ method: "POST", match: "/cancel", status: 204 });
    await paypal.cancelInvoice("INV2-AAAA", { note: "Cancelled", requestId: "tab-cancel-inv_abc123" });
    assert.equal(api()[0].url, `${HOST}/v2/invoicing/invoices/INV2-AAAA/cancel`);
    assert.equal(api()[0].headers["PayPal-Request-Id"], "tab-cancel-inv_abc123");
    assert.equal(bodyOf(api()[0]).note, "Cancelled");
  });

  test("recordPayment (cash)", async () => {
    await paypal.recordPayment("INV2-AAAA", 45.5, "USD", "2026-11-13", "tab-cash-inv_abc123-0");
    assert.equal(api()[0].url, `${HOST}/v2/invoicing/invoices/INV2-AAAA/payments`);
    assert.equal(api()[0].headers["PayPal-Request-Id"], "tab-cash-inv_abc123-0");
    assert.deepEqual(bodyOf(api()[0]), { method: "CASH", payment_date: "2026-11-13", amount: { currency_code: "USD", value: "45.50" }, note: "Recorded in Tab" });
  });

  test("allowPartialPayment: reads, then PUTs the full invoice with the partial-payment setting", async () => {
    routes.push({ method: "GET", match: "/INV2-AAAA", status: 200, json: { ...PP_INVOICE, configuration: { allow_tip: true } }, sticky: true });
    await paypal.allowPartialPayment("INV2-AAAA", 33, "USD", "tab-split_offer-inv_abc123-1-partial");
    const put = api().find((c) => c.method === "PUT");
    assert.ok(put.url.startsWith(`${HOST}/v2/invoicing/invoices/INV2-AAAA?`));
    assert.match(put.url, /send_to_recipient=false/);
    assert.equal(put.headers["PayPal-Request-Id"], "tab-split_offer-inv_abc123-1-partial");
    const body = bodyOf(put);
    assert.equal(body.links, undefined);
    assert.equal(body.id, "INV2-AAAA");
    assert.deepEqual(body.configuration, { allow_tip: true, partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: "USD", value: "33.00" } } });
  });

  test("a write with no explicit id still gets a fresh unique one", async () => {
    await paypal.remindInvoice("INV2-AAAA", { subject: "a", note: "b" });
    await paypal.remindInvoice("INV2-AAAA", { subject: "a", note: "b" });
    const [a, b] = api().map((c) => c.headers["PayPal-Request-Id"]);
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, b);
  });
});

describe("responses", () => {
  test("a payment recorded outside PayPal (MARKED_AS_PAID) reads as PAID", async () => {
    routes.push({ method: "GET", match: "/INV2-AAAA", status: 200, json: { id: "INV2-AAAA", status: "MARKED_AS_PAID", payments: { paid_amount: { value: "90.00" } }, due_amount: { value: "0.00" } } });
    assert.deepEqual(await paypal.getInvoice("INV2-AAAA"), { id: "INV2-AAAA", status: "PAID", number: undefined, payerUrl: null, invoicerUrl: null, paidAmount: 90, dueAmount: 0 });
  });

  test("an unpaid invoice has paidAmount 0", async () => {
    routes.push({ method: "GET", match: "/INV2-AAAA", status: 200, json: { id: "INV2-AAAA", status: "SENT", amount: { value: "90.00" } } });
    const inv = await paypal.getInvoice("INV2-AAAA");
    assert.equal(inv.paidAmount, 0);
    assert.equal(inv.dueAmount, 90);
  });

  test("API errors become a PayPalError with status, message and field details", async () => {
    routes.push({ method: "POST", match: "/send", status: 422, json: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", details: [{ field: "/primary_recipients/0", issue: "INVALID_EMAIL", description: "Bad email." }] } });
    await assert.rejects(paypal.sendInvoice("INV2-AAAA", { subject: "s", note: "n", requestId: "r" }), (e) => {
      assert.ok(e instanceof paypal.PayPalError);
      assert.equal(e.status, 422);
      assert.equal(e.body.name, "UNPROCESSABLE_ENTITY");
      assert.match(e.message, /POST \/v2\/invoicing\/invoices\/INV2-AAAA\/send failed/);
      assert.match(e.message, /INVALID_EMAIL/);
      return true;
    });
    assert.equal(api().length, 1); // did not go on to re-read the invoice
  });

  test("a non-JSON error body does not crash the client", async () => {
    globalThis.fetch = ((inner) => async (url, init) => {
      if (String(url).includes("/v2/")) { globalThis.fetch = inner; return new Response("<html>Bad gateway</html>", { status: 502 }); }
      return inner(url, init);
    })(globalThis.fetch);
    await assert.rejects(paypal.getInvoice("INV2-AAAA"), (e) => e instanceof paypal.PayPalError && e.status === 502);
  });

  test("recentIncome adds up money received and ignores money sent", async () => {
    routes.push({ method: "GET", match: "/v1/reporting/transactions", status: 200, json: { transaction_details: [
      { transaction_info: { transaction_amount: { value: "90.00" } } },
      { transaction_info: { transaction_amount: { value: "-12.40" } } },
      { transaction_info: { transaction_amount: { value: "10.50" } } },
      { transaction_info: {} },
    ] } });
    assert.deepEqual(await paypal.recentIncome(7), { total: 100.5, count: 4 });
    const url = new URL(api()[0].url);
    assert.equal(url.pathname, "/v1/reporting/transactions");
    assert.match(url.searchParams.get("start_date"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(Date.parse(url.searchParams.get("end_date")) - Date.parse(url.searchParams.get("start_date")), 7 * 86400_000);
  });
});

describe("webhook signature verification", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "c2lnbmF0dXJl",
    "paypal-transmission-time": "2026-11-13T10:00:00Z",
  };
  const event = { id: "WH-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-AAAA" } } };
  const VERIFY = "/v1/notifications/verify-webhook-signature";

  test("rejects everything when no webhook id is configured, without calling PayPal", async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    assert.equal(await paypal.verifyWebhook(headers, event), false);
    assert.equal(calls.length, 0);
  });

  describe("with a webhook id", () => {
    beforeEach(() => { process.env.PAYPAL_WEBHOOK_ID = "WH-ID-TEST"; });
    after(() => { delete process.env.PAYPAL_WEBHOOK_ID; });

    test("accepts only when PayPal answers SUCCESS, and sends PayPal the transmission headers and the event", async () => {
      routes.push({ method: "POST", match: VERIFY, status: 200, json: { verification_status: "SUCCESS" } });
      assert.equal(await paypal.verifyWebhook(headers, event), true);
      assert.equal(api().length, 1);
      assert.equal(api()[0].url, HOST + VERIFY);
      assert.deepEqual(bodyOf(api()[0]), {
        auth_algo: "SHA256withRSA", cert_url: headers["paypal-cert-url"], transmission_id: "tx-1", transmission_sig: "c2lnbmF0dXJl",
        transmission_time: "2026-11-13T10:00:00Z", webhook_id: "WH-ID-TEST", webhook_event: event,
      });
    });

    test("rejects a signature PayPal reports as FAILURE", async () => {
      routes.push({ method: "POST", match: VERIFY, status: 200, json: { verification_status: "FAILURE" } });
      assert.equal(await paypal.verifyWebhook({ ...headers, "paypal-transmission-sig": "forged" }, event), false);
    });

    test("rejects when the answer is empty or has no verdict", async () => {
      routes.push({ method: "POST", match: VERIFY, status: 200, json: {} });
      assert.equal(await paypal.verifyWebhook(headers, event), false);
      routes.push({ method: "POST", match: VERIFY, status: 200 });
      assert.equal(await paypal.verifyWebhook(headers, event), false);
      routes.push({ method: "POST", match: VERIFY, status: 200, json: { verification_status: "success-ish" } });
      assert.equal(await paypal.verifyWebhook(headers, event), false);
    });

    test("a request with no signature headers is never accepted", async () => {
      // PayPal answers 400 for a malformed verification request; that must not read as verified.
      routes.push({ method: "POST", match: VERIFY, status: 400, json: { name: "VALIDATION_ERROR", message: "Invalid request - see details" } });
      await assert.rejects(paypal.verifyWebhook({}, event), paypal.PayPalError);
      routes.push({ method: "POST", match: VERIFY, status: 200, json: { verification_status: "FAILURE" } });
      assert.equal(await paypal.verifyWebhook({}, undefined), false);
    });

    test("does not accept when PayPal is down", async () => {
      routes.push({ method: "POST", match: VERIFY, status: 503, json: { message: "Service Unavailable" } });
      await assert.rejects(paypal.verifyWebhook(headers, event), (e) => e instanceof paypal.PayPalError && e.status === 503);
    });
  });
});

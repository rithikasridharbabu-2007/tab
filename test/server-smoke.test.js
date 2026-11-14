// Boots the real server in practice mode (no PayPal, no AI) on a spare local port with a throwaway
// data directory, and walks the main flow over HTTP. Every key is blanked for the child process, so a
// developer's own .env cannot switch PayPal or AI on here (dotenv never overrides a variable that is set).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tab-smoke-test-"));
let child, base, output = "";

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const api = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR, POLL_SECONDS: "3600",
      PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_WEBHOOK_ID: "", PAYPAL_ENV: "sandbox",
      GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", SANDBOX_BUYER_EMAIL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("server exited early:\n" + output);
    try { if ((await fetch(base + "/api/state")).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("server did not start:\n" + output);
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(() => {
  child?.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("server in practice mode", () => {
  test("boots with no keys and says so", async () => {
    const { status, json } = await api("GET", "/api/state");
    assert.equal(status, 200);
    assert.deepEqual(json.modes, { ai: false, aiLabel: null, aiError: null, paypal: false, env: "sandbox", webhooks: false });
    assert.match(output, /AI: OFF/);
    assert.match(output, /PayPal: OFF/);
    assert.equal(json.invoices.length, 4);
    assert.equal(json.forecast.days.length, 15);
    assert.equal(json.forecast.firstShort.bill, "Rent");
  });

  test("serves the app shell", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/i);
  });

  test("note -> draft -> simulated invoice -> paid in cash", async () => {
    const note = await api("POST", "/api/notes", { text: "Priya took three dozen cupcakes, she'll pay Friday." });
    assert.equal(note.status, 200);
    assert.equal(note.json.source, "rules");
    assert.equal(note.json.customerId, "c_priya");
    assert.deepEqual(note.json.items, [{ name: "Cupcakes", quantity: 3, unitPrice: 30 }]);

    const before = (await api("GET", "/api/state")).json;
    const created = await api("POST", "/api/invoices", { draft: note.json });
    assert.equal(created.status, 200);
    const inv = created.json;
    assert.equal(inv.amount, 90);
    assert.equal(inv.status, "SENT");
    assert.match(inv.paypalId, /^SIM-/);
    assert.equal(inv.live, false);
    assert.match(inv.history.at(-1).text, /simulated/);

    const half = await api("POST", `/api/invoices/${inv.id}/mark-paid`, { amount: 40 });
    assert.equal(half.json.status, "PARTIALLY_PAID");
    assert.equal(half.json.outstanding, 50);
    const paid = await api("POST", `/api/invoices/${inv.id}/mark-paid`, {});
    assert.equal(paid.json.status, "PAID");
    assert.equal(paid.json.outstanding, 0);
    const state = (await api("GET", "/api/state")).json;
    assert.equal(state.cash, before.cash + 90);

    const again = await api("POST", `/api/invoices/${inv.id}/mark-paid`, {});
    assert.equal(again.status, 400);
    const chase = await api("POST", `/api/invoices/${inv.id}/follow-up`, { kind: "reminder" });
    assert.equal(chase.status, 400);
  });

  test("rejects incomplete drafts", async () => {
    assert.equal((await api("POST", "/api/notes", { text: "  " })).status, 400);
    assert.equal((await api("POST", "/api/invoices", {})).status, 400);
    const noPrice = await api("POST", "/api/invoices", { draft: { customerName: "Tom", dueDate: "2026-11-20", items: [{ name: "Bread", quantity: 1, unitPrice: 0 }] } });
    assert.equal(noPrice.status, 400);
    assert.match(noPrice.json.error, /price/);
    const badDate = await api("POST", "/api/invoices", { draft: { customerName: "Tom", dueDate: "Friday", items: [{ name: "Bread", quantity: 1, unitPrice: 5 }] } });
    assert.equal(badDate.status, 400);
  });

  test("the follow-up plan uses the rules and running it sends the approved reminders", async () => {
    const plan = (await api("GET", "/api/plan")).json;
    assert.equal(plan.source, "rules");
    assert.deepEqual(plan.actions.map((a) => [a.invoice_id, a.action]), [["inv_marco", "firm_reminder"], ["inv_aisha", "remind"], ["inv_daniela", "remind"]]);
    assert.equal(plan.actions[0].customer, "Marco Rossi");

    const run = await api("POST", "/api/plan/run", { actions: [plan.actions[0], { invoice_id: "inv_aisha", action: "wait" }, { invoice_id: "inv_nope", action: "remind" }] });
    assert.deepEqual(run.json.results.map((r) => [r.invoice_id, r.ok]), [["inv_marco", true], ["inv_nope", false]]);
    const marco = run.json.state.invoices.find((i) => i.id === "inv_marco");
    assert.equal(marco.remindersSent, 2);
    assert.equal(marco.lastReminderDaysAgo, 0);
    // Reminded today, so the next plan leaves Marco be.
    const next = (await api("GET", "/api/plan")).json;
    assert.equal(next.actions.find((a) => a.invoice_id === "inv_marco").action, "wait");
  });

  test("running a plan ignores actions it does not know", async () => {
    const before = (await api("GET", "/api/state")).json.invoices.find((i) => i.id === "inv_aisha");
    const run = await api("POST", "/api/plan/run", { actions: [{ invoice_id: "inv_aisha", action: "threaten" }, { invoice_id: "inv_aisha" }] });
    assert.equal(run.status, 200);
    assert.deepEqual(run.json.results.map((r) => r.ok), [false, false]);
    const aisha = run.json.state.invoices.find((i) => i.id === "inv_aisha");
    assert.equal(aisha.remindersSent, before.remindersSent);
    assert.equal(aisha.history.length, before.history.length);
  });

  test("an unsigned webhook is refused and changes nothing", async () => {
    const before = (await api("GET", "/api/state")).json;
    const hook = await api("POST", "/api/webhooks/paypal", { event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: before.invoices[0].paypalId } } });
    assert.equal(hook.status, 400);
    assert.deepEqual((await api("GET", "/api/state")).json.invoices, before.invoices);
  });

  test("settings validate bills; reset restores the example data", async () => {
    const put = await api("PUT", "/api/settings", { cash: 2000, bills: [{ name: "Rent", amount: 1200, dueDate: "2026-12-01" }, { name: "Bad", amount: -5, dueDate: "2026-12-01" }, { name: "No date", amount: 5, dueDate: "soon" }] });
    assert.equal(put.json.cash, 2000);
    assert.deepEqual(put.json.bills.map((b) => b.name), ["Rent"]);
    assert.equal((await api("PUT", "/api/settings", { cash: -1 })).json.cash, 2000);
    const reset = await api("POST", "/api/reset");
    assert.equal(reset.json.cash, 750);
    assert.equal(reset.json.invoices.length, 4);
  });

  test("unknown API routes and invoices give JSON 404s", async () => {
    assert.equal((await api("GET", "/api/nope")).status, 404);
    const missing = await api("POST", "/api/invoices/inv_missing/cancel");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "Invoice not found");
  });
});

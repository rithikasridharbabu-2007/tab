/* Tab — phone-first front end.
   Home: who owes you, today's plan, new sale (voice -> one-sentence confirm -> send with undo -> WhatsApp).
   Money: 14-day cash outlook and bills. Books: the full ledger in AG Grid. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let state = null;
let showPaid = false;
let grid = null;
let gridFilter = "open";
const lastPaid = new Map(); // invoice id -> paidAmount, to notice payments arriving

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cur = () => state?.business?.currency || "USD";
const fmt = (n, c = cur()) => new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0 }).format(n || 0);
const dateOf = (iso) => new Date(iso + "T12:00:00");
const longDate = (iso) => dateOf(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const shortDate = (iso) => dateOf(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
function dayWord(iso) {
  const days = Math.round((dateOf(iso) - dateOf(state.today)) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) return dateOf(iso).toLocaleDateString("en-US", { weekday: "long" });
  return shortDate(iso);
}
const first = (name) => String(name || "").split(" ")[0];
const initials = (name) => String(name || "?").split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
const isOpen = (r) => ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "DRAFT"].includes(r.status);
const itemsText = (items) => items.map((i) => (i.quantity === 1 ? i.name : `${i.quantity} × ${i.name}`)).join(", ");
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "Something went wrong. Please try again.");
  return json;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
}

async function busy(btn, fn, label) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label ? " " + esc(label) : ""}`;
  try { return await fn(); }
  catch (e) { toast(e.message, "error"); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

function statusOf(r) {
  if (r.status === "PAID") return { text: "Paid", cls: "paid" };
  if (r.status === "CANCELLED") return { text: "Cancelled", cls: "ok" };
  if (r.daysLate > 0) return { text: `${r.daysLate} day${r.daysLate === 1 ? "" : "s"} late`, cls: "late" };
  const part = r.status === "PARTIALLY_PAID" ? `${fmt(r.paidAmount, r.currency)} paid · ` : "";
  if (r.daysUntilDue <= 2) return { text: `${part}Due ${dayWord(r.dueDate)}`, cls: "soon" };
  return { text: `${part}Due ${dayWord(r.dueDate)}`, cls: "ok" };
}

// ------------------------------------------------------------------ views
function route() {
  const view = (location.hash || "#home").slice(1);
  const known = ["home", "money", "books"].includes(view) ? view : "home";
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${known}`));
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === known));
  if (known === "books") ensureGrid();
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);

function render(s) {
  // notice payments that just arrived
  const arrived = [];
  for (const inv of s.invoices) {
    const before = lastPaid.get(inv.id);
    if (before !== undefined && inv.paidAmount > before) arrived.push({ inv, amount: inv.paidAmount - before });
    lastPaid.set(inv.id, inv.paidAmount);
  }
  state = s;
  renderHome();
  renderMoney();
  if (grid) grid.setGridOption("rowData", s.invoices);
  for (const { inv, amount } of arrived) {
    toast(`${first(inv.customerName)} paid ${fmt(amount, inv.currency)}`, "good");
    const li = $(`.person[data-id="${CSS.escape(inv.id)}"]`);
    if (li) { li.classList.remove("flash"); void li.offsetWidth; li.classList.add("flash"); }
  }
  loadToday();
}

// ------------------------------------------------------------------ home
function renderHome() {
  const f = state.forecast;
  const open = state.invoices.filter(isOpen);
  $("#heroLabel").textContent = open.length ? "People owe you" : "All settled";
  $("#heroAmount").textContent = fmt(f.owed);
  $("#heroSub").innerHTML = !open.length
    ? "Nobody owes you anything right now."
    : `${open.length} ${open.length === 1 ? "person" : "people"}${f.overdue ? ` · <b>${fmt(f.overdue)} is late</b>` : " · nothing late"}`;

  const rows = state.invoices
    .filter((r) => isOpen(r) || (showPaid && r.status === "PAID"))
    .sort((a, b) => (isOpen(b) - isOpen(a)) || (b.daysLate - a.daysLate) || a.dueDate.localeCompare(b.dueDate));
  $("#people").innerHTML = rows.length
    ? rows.map((r) => {
        const st = statusOf(r);
        return `<li class="person ${r.status === "PAID" ? "paid" : ""}" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.customerName)}, ${esc(fmt(r.outstanding || r.amount, r.currency))}, ${esc(st.text)}">
          <span class="avatar" aria-hidden="true">${esc(initials(r.customerName))}</span>
          <span class="person-main"><div class="person-name">${esc(r.customerName)}</div><div class="person-what">${esc(itemsText(r.items))}</div></span>
          <span class="person-right"><div class="person-amount">${fmt(r.status === "PAID" ? r.amount : r.outstanding, r.currency)}</div><div class="status ${st.cls}">${esc(st.text)}</div></span>
        </li>`;
      }).join("")
    : `<li class="empty"><strong>You're all square.</strong>When someone owes you, they'll show up here.</li>`;
  $("#showPaid").textContent = showPaid ? "Hide paid" : "Show paid";

  $("#activity").innerHTML = state.activity.length
    ? state.activity.slice(0, 6).map((a) => `<li><span>${esc(a.text.replace(/^[^\p{L}\p{N}]+/u, "").replace(" → ", " to "))}</span><time>${ago(a.at)}</time></li>`).join("")
    : `<li><span>Nothing yet.</span></li>`;
}
$("#people").addEventListener("click", (e) => { const li = e.target.closest(".person"); if (li) openPerson(li.dataset.id); });
$("#people").addEventListener("keydown", (e) => { if (e.key === "Enter") { const li = e.target.closest(".person"); if (li) openPerson(li.dataset.id); } });
$("#showPaid").onclick = () => { showPaid = !showPaid; renderHome(); };

// ------------------------------------------------------------------ today's plan
let todayKey = null;
let todayPlan = null;
const dismissedKey = () => `tab-dismissed-${state.today}`;
function planInputsKey() {
  return JSON.stringify([state.today, state.cash, state.bills, state.invoices.filter(isOpen).map((i) => [i.id, i.paidAmount, i.remindersSent])]);
}
async function loadToday() {
  const key = planInputsKey();
  if (key === todayKey) return;
  todayKey = key;
  const box = $("#today");
  let dismissed = false;
  try { dismissed = localStorage.getItem(dismissedKey()) === "1"; } catch {}
  if (dismissed || !state.invoices.some(isOpen)) { box.classList.add("hidden"); return; }
  box.className = "today";
  box.innerHTML = `<div class="loading"><span class="spinner"></span>Looking at your week…</div>`;
  try {
    const plan = await api("/api/plan");
    if (key !== todayKey) return;
    todayPlan = plan;
    renderToday();
  } catch {
    box.classList.add("hidden");
  }
}
function renderToday() {
  const plan = todayPlan;
  const box = $("#today");
  const todo = plan.actions.filter((a) => a.action !== "wait");
  const short = plan.forecast?.firstShort;
  box.className = `today ${short ? "warn" : ""}`;
  box.innerHTML = `
    <div class="today-kicker">Today</div>
    <div class="today-title">${esc(plan.headline)}</div>
    <p class="today-body">${esc(plan.explanation)}</p>
    <div class="today-actions">
      ${todo.length ? `<button class="btn navy small" id="reviewPlan">Review ${todo.length} follow-up${todo.length === 1 ? "" : "s"}</button>` : ""}
      <button class="btn ghost small" id="dismissPlan">${todo.length ? "Not now" : "Got it"}</button>
    </div>`;
  $("#reviewPlan")?.addEventListener("click", () => openPlan(plan));
  $("#dismissPlan").onclick = () => {
    try { localStorage.setItem(dismissedKey(), "1"); } catch {}
    box.classList.add("hidden");
  };
}

const ACTION_WORDS = { remind: "Friendly nudge", firm_reminder: "Firmer reminder", split_offer: "Offer to split in two", wait: "Leave for now" };
function openPlan(plan) {
  const rows = plan.actions.map((a, n) => `
    <label class="choice ${a.action === "wait" ? "off" : ""}">
      <input type="checkbox" data-n="${n}" ${a.action === "wait" ? "disabled" : "checked"} />
      <span>
        <div class="choice-title">${esc(a.customer)} · ${fmt(a.outstanding)}</div>
        <div class="choice-sub">${ACTION_WORDS[a.action]} — ${esc(a.reason)}</div>
      </span>
    </label>`).join("");
  openSheet("Today's follow-ups", `
    <p class="fine" style="margin:0 0 12px">Each message is written in that person's language, in your voice, and sent with their PayPal invoice. Nothing goes out until you tap send.</p>
    ${rows}`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn navy" id="runPlan">Send</button>`);
  $("#runPlan").onclick = (e) => busy(e.currentTarget, async () => {
    const chosen = $$("#sheetBody input:checked").map((i) => plan.actions[Number(i.dataset.n)]);
    if (!chosen.length) { toast("Pick at least one person"); return; }
    const out = await api("/api/plan/run", { method: "POST", body: { actions: chosen } });
    const ok = out.results.filter((r) => r.ok).length;
    closeSheet();
    toast(`Sent ${ok} message${ok === 1 ? "" : "s"}`, "good");
    out.results.filter((r) => !r.ok).forEach((r) => toast(r.error, "error"));
    try { localStorage.setItem(dismissedKey(), "1"); } catch {}
    $("#today").classList.add("hidden");
  }, "Sending");
}

// ------------------------------------------------------------------ new sale: voice
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;
$("#micBtn").onclick = () => {
  if (!SR) { toast("Voice isn't available in this browser. Type it instead.", "error"); $("#note").focus(); return; }
  if (listening) { rec.stop(); return; }
  rec = new SR();
  rec.lang = $("#lang").value;
  rec.interimResults = true;
  rec.continuous = true;
  const before = $("#note").value.trim();
  rec.onresult = (e) => {
    let text = "";
    for (const r of e.results) text += r[0].transcript;
    $("#note").value = (before ? before + " " : "") + text;
  };
  rec.onstart = () => {
    listening = true;
    $("#micBtn").classList.add("on");
    $("#micLabel").textContent = "Listening… tap when you're done";
    $("#micHint").textContent = "Who, what, how much, and when they'll pay";
  };
  rec.onend = () => {
    listening = false;
    $("#micBtn").classList.remove("on");
    $("#micLabel").textContent = "Tap and say who bought what";
    $("#micHint").textContent = "“Priya took three dozen cupcakes, she'll pay Friday”";
    if ($("#note").value.trim()) startDraft();
  };
  rec.onerror = (e) => { if (!["no-speech", "aborted"].includes(e.error)) toast(e.error === "not-allowed" ? "Allow the microphone to use voice." : `Microphone problem: ${e.error}`, "error"); };
  rec.start();
};
$("#examples").addEventListener("click", (e) => {
  const b = e.target.closest("[data-text]");
  if (!b) return;
  $("#note").value = b.dataset.text;
  if (b.dataset.lang) $("#lang").value = b.dataset.lang;
  $("#note").focus();
});
$("#parseBtn").onclick = () => startDraft();
$("#note").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startDraft(); } });

// ------------------------------------------------------------------ new sale: confirm
let draft = null; // { ...fields, message: {subject, message, english}, showDetails }
async function startDraft() {
  const text = $("#note").value.trim();
  if (!text) { toast("Say or type what they bought first"); return; }
  const btn = $("#parseBtn");
  await busy(btn, async () => {
    const d = await api("/api/notes", { method: "POST", body: { text } });
    draft = { ...d, message: null, showDetails: false };
    $("#capture").classList.add("hidden");
    renderConfirm();
    writeMessage();
  });
}

const draftTotal = () => draft.items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
const needsEmail = () => state.modes.paypal && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.customerEmail || "");

function sentenceHTML() {
  const total = draftTotal();
  return `Invoice <b>${esc(draft.customerName || "someone")}</b> <b>${total ? fmt(total, draft.currency) : "— no price yet"}</b> for ${esc(itemsText(draft.items.filter((i) => i.name)) || "…")}, due <b>${esc(draft.dueDate ? longDate(draft.dueDate) : "—")}</b>.`;
}

function renderConfirm() {
  const box = $("#confirm");
  box.classList.remove("hidden");
  const qs = (draft.questions || []).filter(Boolean);
  const m = draft.message;
  const foreign = draft.customerLanguage && draft.customerLanguage.toLowerCase() !== "english";
  box.innerHTML = `
    <p class="confirm-sentence" id="sentence">${sentenceHTML()}</p>
    <div class="confirm-meta">You said: “${esc(draft.noteText)}”</div>
    ${qs.length ? `<div class="ask">${qs.map(esc).join("<br>")}</div>` : ""}
    ${needsEmail() ? `<div class="ask">What's ${esc(first(draft.customerName))}'s email? PayPal sends the invoice there.<input id="askEmail" type="email" inputmode="email" placeholder="name@example.com" value="${esc(draft.customerEmail || "")}" /></div>` : ""}
    <div class="bubble-label"><span>What ${esc(first(draft.customerName))} will get${foreign ? ` · in ${esc(draft.customerLanguage)}` : ""}</span>${m ? `<button class="link" id="editMsg">Edit</button>` : ""}</div>
    <div class="bubble ${m ? "" : "loading"}" id="bubble">${m ? esc(m.message) : "Writing a note in your voice…"}</div>
    ${m && foreign ? `<div class="translation">In English: ${esc(m.english)}</div>` : ""}
    <div class="details ${draft.showDetails ? "" : "hidden"}" id="details">
      <div class="two">
        <label>Name<input data-f="customerName" value="${esc(draft.customerName)}" /></label>
        <label>Email<input data-f="customerEmail" type="email" value="${esc(draft.customerEmail || "")}" /></label>
      </div>
      <div class="two">
        <label>Write to them in<input data-f="customerLanguage" value="${esc(draft.customerLanguage)}" /></label>
        <label>Due<input data-f="dueDate" type="date" value="${esc(draft.dueDate)}" /></label>
      </div>
      <div>
        <div style="font-size:13px;color:var(--ink-3);margin-bottom:4px">Items (name · qty · price each)</div>
        <div id="itemRows">${draft.items.map((it, n) => `
          <div class="item-row" data-n="${n}">
            <input data-i="name" value="${esc(it.name)}" aria-label="Item" />
            <input data-i="quantity" type="number" inputmode="decimal" min="0" step="any" value="${it.quantity}" aria-label="Quantity" />
            <input data-i="unitPrice" type="number" inputmode="decimal" min="0" step="0.01" value="${it.unitPrice}" aria-label="Price each" />
            <button class="icon-btn" data-rm="${n}" aria-label="Remove item">✕</button>
          </div>`).join("")}</div>
        <div class="row-between" style="margin-top:6px"><button class="link" id="addItem">Add an item</button><button class="link" id="rewrite">Rewrite the note</button></div>
      </div>
    </div>
    <div class="confirm-actions">
      <button class="btn ghost" id="toggleDetails">${draft.showDetails ? "Done" : "Change"}</button>
      <button class="btn pp" id="sendBtn" ${draftTotal() > 0 ? "" : "disabled"}>Send with PayPal</button>
    </div>
    <div style="margin-top:10px"><button class="link" id="discard" style="color:var(--ink-3)">Start over</button></div>`;

  $("#toggleDetails").onclick = () => { draft.showDetails = !draft.showDetails; renderConfirm(); };
  $("#discard").onclick = resetSale;
  $("#editMsg")?.addEventListener("click", () => { const b = $("#bubble"); b.contentEditable = "true"; b.focus(); });
  $("#askEmail")?.addEventListener("input", (e) => { draft.customerEmail = e.target.value.trim(); });
  $("#details").addEventListener("input", (e) => {
    const f = e.target.dataset.f;
    const i = e.target.dataset.i;
    if (f) draft[f] = e.target.value;
    if (i) {
      const n = Number(e.target.closest(".item-row").dataset.n);
      draft.items[n][i] = i === "name" ? e.target.value : Number(e.target.value);
    }
    $("#sentence").innerHTML = sentenceHTML();
    $("#sendBtn").disabled = !(draftTotal() > 0);
  });
  $("#details").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]")?.dataset.rm;
    if (rm !== undefined) { draft.items.splice(Number(rm), 1); renderConfirm(); }
  });
  $("#addItem").onclick = () => { draft.items.push({ name: "", quantity: 1, unitPrice: 0 }); renderConfirm(); };
  $("#rewrite").onclick = () => writeMessage();
  $("#sendBtn").onclick = () => countdownSend();
}

async function writeMessage() {
  if (!(draftTotal() > 0)) { draft.message = null; renderConfirm(); $("#bubble").textContent = "Add a price and Tab will write the note."; return; }
  draft.message = null;
  renderConfirm();
  try {
    const m = await api("/api/messages/preview", { method: "POST", body: { kind: "invoice", draft: payloadDraft() } });
    if (!draft) return;
    draft.message = m;
    renderConfirm();
  } catch {
    if (draft) $("#bubble").textContent = "Couldn't write the note — you can still send the invoice.";
  }
}

function payloadDraft() {
  const { message, showDetails, ...d } = draft;
  return { ...d, items: d.items.filter((i) => i.name && i.quantity > 0) };
}

let sendTimer = null;
function countdownSend() {
  if (needsEmail()) { toast(`Add ${first(draft.customerName)}'s email first`, "error"); $("#askEmail")?.focus(); return; }
  const edited = $("#bubble")?.isContentEditable ? $("#bubble").innerText.trim() : null;
  const message = draft.message ? { ...draft.message, ...(edited && edited !== draft.message.message ? { message: edited, english: edited } : {}) } : null;
  const body = { draft: payloadDraft(), message };
  let n = 5;
  $(".confirm-actions").outerHTML = `<div class="countdown" id="countdown"><span>Sending to ${esc(first(draft.customerName))} in <b id="cd">${n}</b>…</span><button class="link" id="undo">Undo</button></div>`;
  $("#undo").onclick = () => { clearInterval(sendTimer); renderConfirm(); toast("Not sent"); };
  sendTimer = setInterval(async () => {
    n -= 1;
    if (n > 0) { $("#cd").textContent = n; return; }
    clearInterval(sendTimer);
    $("#countdown").innerHTML = `<span><span class="spinner"></span> Sending through PayPal…</span>`;
    try {
      const inv = await api("/api/invoices", { method: "POST", body });
      showSent(inv);
    } catch (e) {
      toast(e.message, "error");
      renderConfirm();
    }
  }, 1000);
}

function showSent(inv) {
  const box = $("#confirm");
  box.innerHTML = `
    <p class="done-title">Sent to ${esc(first(inv.customerName))}.</p>
    <div class="confirm-meta">${inv.live ? `PayPal emailed invoice #${esc(inv.number)} for ${fmt(inv.amount, inv.currency)} with a Pay button.` : `Practice mode: invoice for ${fmt(inv.amount, inv.currency)} saved (PayPal isn't connected).`} Tab will remind you if it isn't paid by ${esc(dayWord(inv.dueDate))}.</div>
    <div class="done-actions">
      <a class="btn wa" href="${esc(whatsappLink(inv, inv.message))}" target="_blank" rel="noopener">Also send on WhatsApp</a>
      <button class="btn ghost" id="another">New sale</button>
    </div>`;
  $("#another").onclick = resetSale;
}

function resetSale() {
  clearInterval(sendTimer);
  draft = null;
  $("#confirm").classList.add("hidden");
  $("#confirm").innerHTML = "";
  $("#capture").classList.remove("hidden");
  $("#note").value = "";
}

function whatsappLink(inv, text) {
  const body = [text || `Hi ${first(inv.customerName)}, here's the invoice for ${fmt(inv.outstanding ?? inv.amount, inv.currency)}.`, inv.payerUrl ? `Pay here: ${inv.payerUrl}` : ""].filter(Boolean).join("\n\n");
  return `https://wa.me/?text=${encodeURIComponent(body)}`;
}

// ------------------------------------------------------------------ one person
function openPerson(id) {
  const r = state.invoices.find((i) => i.id === id);
  if (!r) return;
  const st = statusOf(r);
  const open = isOpen(r);
  const sentVia = r.live ? `PayPal invoice #${esc(r.number)}` : r.sample ? "Example data" : "Practice mode";
  const hist = [...r.history].reverse().map((h) => `<li class="${esc(h.type)}"><time>${new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>${esc(h.text)}</li>`).join("");
  const waText = `Hi ${first(r.customerName)}! Just a reminder about the ${fmt(r.outstanding, r.currency)} for ${itemsText(r.items)}. Thank you! — ${first(state.business.ownerName)}`;
  openSheet(r.customerName, `
    <div class="big-amount">${fmt(open ? r.outstanding : r.amount, r.currency)}</div>
    <div class="status ${st.cls}" style="font-size:14px">${esc(st.text)}</div>
    <dl class="facts">
      <dt>For</dt><dd>${esc(itemsText(r.items))}</dd>
      <dt>Due</dt><dd>${esc(longDate(r.dueDate))}</dd>
      ${r.paidAmount ? `<dt>Paid so far</dt><dd>${fmt(r.paidAmount, r.currency)} of ${fmt(r.amount, r.currency)}</dd>` : ""}
      <dt>Writes in</dt><dd>${esc(r.customerLanguage)}</dd>
      <dt>Sent as</dt><dd>${sentVia}${r.live && r.payerUrl ? ` · <a href="${esc(r.payerUrl)}" target="_blank" rel="noopener">their pay page</a>` : ""}</dd>
    </dl>
    ${open ? `<div class="actions-grid">
      <button class="btn navy" data-a="${r.daysLate > 7 ? "firm_reminder" : "reminder"}">${r.daysLate > 7 ? "Firmer reminder" : "Nudge"}</button>
      <button class="btn ghost" data-a="split_offer">Offer to split</button>
      <a class="btn wa" href="${esc(whatsappLink(r, waText))}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn ghost" data-a="cash">Got paid in cash</button>
    </div>` : ""}
    <ul class="history">${hist}</ul>
    ${open ? `<button class="link" data-a="cancel" style="color:var(--late);margin-top:8px">Cancel this invoice</button>` : ""}`, "");
  $("#sheetBody").onclick = (e) => {
    const el = e.target.closest("[data-a]");
    if (!el) return;
    const a = el.dataset.a;
    if (a === "cash") return markPaid(r, el);
    if (a === "cancel") return cancelInvoice(r, el);
    compose(r, a);
  };
}

async function markPaid(r, btn) {
  if (!confirm(`Mark ${fmt(r.outstanding, r.currency)} from ${first(r.customerName)} as paid in cash?`)) return;
  await busy(btn, async () => {
    await api(`/api/invoices/${r.id}/mark-paid`, { method: "POST", body: {} });
    closeSheet();
  });
}
async function cancelInvoice(r, btn) {
  if (!confirm(`Cancel ${first(r.customerName)}'s invoice?${r.live ? " PayPal will let them know." : ""}`)) return;
  await busy(btn, async () => {
    await api(`/api/invoices/${r.id}/cancel`, { method: "POST" });
    closeSheet();
    toast("Invoice cancelled");
  });
}

const KIND_TITLE = { reminder: "Nudge", firm_reminder: "Firmer reminder", split_offer: "Offer to split" };
async function compose(r, kind) {
  openSheet(`${KIND_TITLE[kind]} · ${first(r.customerName)}`, `<div class="bubble loading">Writing it in ${esc(r.customerLanguage)}, in your voice…</div>`, "");
  let m;
  try { m = await api("/api/messages/preview", { method: "POST", body: { kind, invoiceId: r.id } }); }
  catch (e) { closeSheet(); toast(e.message, "error"); return; }
  const foreign = r.customerLanguage.toLowerCase() !== "english";
  openSheet(`${KIND_TITLE[kind]} · ${first(r.customerName)}`, `
    <div class="bubble-label"><span>${foreign ? `In ${esc(r.customerLanguage)}` : "Message"}</span><span>Tap to edit</span></div>
    <div class="bubble" id="composeMsg" contenteditable="true">${esc(m.message)}</div>
    ${foreign ? `<div class="translation">In English: ${esc(m.english)}</div>` : ""}
    ${kind === "split_offer" ? `<p class="fine" style="margin-top:12px">${esc(first(r.customerName))} will be able to pay part now (at least ${fmt(Math.ceil(r.outstanding / 2), r.currency)}) with the same PayPal link.</p>` : ""}
    <p class="fine" style="margin-top:12px">${r.live ? "Sent with the PayPal invoice and its Pay button." : "Practice mode: nothing is emailed."}${r.lastReminderDaysAgo !== null ? ` Last nudge: ${r.lastReminderDaysAgo === 0 ? "today" : r.lastReminderDaysAgo + " days ago"}.` : ""}</p>`,
    `<a class="btn wa" id="composeWa" target="_blank" rel="noopener">WhatsApp</a><button class="btn navy" id="composeSend">Send</button>`);
  const current = () => $("#composeMsg").innerText.trim();
  const syncWa = () => { $("#composeWa").href = whatsappLink(r, current()); };
  syncWa();
  $("#composeMsg").addEventListener("input", syncWa);
  $("#composeSend").onclick = (e) => busy(e.currentTarget, async () => {
    const text = current();
    await api(`/api/invoices/${r.id}/follow-up`, { method: "POST", body: { kind, message: { subject: m.subject, message: text, english: text === m.message ? m.english : text } } });
    closeSheet();
    toast(`Sent to ${first(r.customerName)}`, "good");
  }, "Sending");
}

// ------------------------------------------------------------------ sheet
function openSheet(title, body, foot) {
  $("#sheetTitle").textContent = title;
  $("#sheetBody").innerHTML = body;
  $("#sheetBody").onclick = null;
  $("#sheetFoot").innerHTML = foot || "";
  $("#sheet").classList.remove("hidden");
  $$("[data-close]", $("#sheet")).forEach((b) => (b.onclick = closeSheet));
}
function closeSheet() { $("#sheet").classList.add("hidden"); }
$("#sheetClose").onclick = closeSheet;
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

// ------------------------------------------------------------------ money
function renderMoney() {
  const f = state.forecast;
  if (f.firstShort) {
    $("#moneyHeadline").textContent = `You'll be ${fmt(f.firstShort.amount)} short${f.firstShort.bill ? ` for ${f.firstShort.bill}` : ""} on ${dayWord(f.firstShort.date)}.`;
    $("#moneySub").textContent = f.overdue ? `${fmt(f.overdue)} that people owe you is already late. Getting it in ${f.overdue >= f.firstShort.amount ? "would cover it" : "would help"}.` : "Nothing is late yet — it's just timing.";
  } else {
    $("#moneyHeadline").textContent = "You're covered for the next two weeks.";
    $("#moneySub").textContent = `Lowest point: ${fmt(f.lowest.amount)} on ${longDate(f.lowest.date)}.`;
  }
  if (document.activeElement !== $("#cashInput")) $("#cashInput").value = state.cash;
  renderChart(f.days);
  if (!$("#billList").contains(document.activeElement)) {
    $("#billList").innerHTML = state.bills.length
      ? state.bills.map((b) => `
        <div class="bill" data-id="${esc(b.id)}">
          <input value="${esc(b.name)}" data-k="name" aria-label="Bill" />
          <input value="${b.amount}" type="number" inputmode="decimal" min="0" data-k="amount" aria-label="Amount" />
          <input value="${b.dueDate}" type="date" data-k="dueDate" aria-label="Due date" />
          <button class="icon-btn" data-del="${esc(b.id)}" aria-label="Remove bill">✕</button>
        </div>`).join("")
      : `<p class="fine">Add rent, suppliers, phone — anything with a due date.</p>`;
  }
  const inc = state.income;
  $("#income").textContent = inc && !inc.error && inc.count ? `Money in through PayPal, last 7 days: ${fmt(inc.total)}.` : "";
}

function renderChart(days) {
  const W = 640, H = 170, padX = 8, padT = 24, padB = 22;
  const vals = days.map((d) => d.balance);
  const min = Math.min(0, ...vals), max = Math.max(...vals, 1);
  const x = (i) => padX + (i * (W - padX * 2)) / (days.length - 1);
  const y = (v) => padT + (1 - (v - min) / (max - min || 1)) * (H - padT - padB);
  // step line: the balance changes on the day money moves
  let d = `M${x(0)},${y(days[0].balance)}`;
  for (let i = 1; i < days.length; i++) d += ` H${x(i)} V${y(days[i].balance)}`;
  const zero = y(0);
  const neg = vals.some((v) => v < 0);
  const bills = days.map((dd, i) => dd.bills.length ? `<line x1="${x(i)}" x2="${x(i)}" y1="${padT - 6}" y2="${H - padB}" stroke="#b4442f" stroke-width="1.5" stroke-dasharray="2 3"/><text x="${x(i)}" y="${padT - 10}" font-size="11" text-anchor="${i > days.length - 3 ? "end" : "middle"}" fill="#b4442f">${esc(dd.bills.join(", "))}</text>` : "").join("");
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${neg ? `<rect x="${padX}" y="${zero}" width="${W - padX * 2}" height="${Math.max(0, H - padB - zero)}" fill="#f8e7e2" opacity=".6"/>` : ""}
    <line x1="${padX}" x2="${W - padX}" y1="${zero}" y2="${zero}" stroke="#d8d2c7" stroke-width="1"/>
    <text x="${W - padX}" y="${zero - 5}" font-size="11" fill="#8a857c" text-anchor="end">$0</text>
    ${bills}
    <path d="${d}" fill="none" stroke="#1f3b5c" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <text x="${padX}" y="${H - 4}" font-size="11" fill="#8a857c">Today</text>
    <text x="${W - padX}" y="${H - 4}" font-size="11" fill="#8a857c" text-anchor="end">${esc(shortDate(days[days.length - 1].date))}</text>
  </svg>`;
}

let saveTimer = null;
function saveSoon(body) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { try { render(await api("/api/settings", { method: "PUT", body })); } catch (e) { toast(e.message, "error"); } }, 500);
}
$("#cashInput").addEventListener("input", (e) => saveSoon({ cash: Number(e.target.value) || 0 }));
const readBills = () => $$("#billList .bill").map((el) => ({ id: el.dataset.id, name: $('[data-k="name"]', el).value, amount: Number($('[data-k="amount"]', el).value), dueDate: $('[data-k="dueDate"]', el).value }));
$("#billList").addEventListener("change", () => saveSoon({ bills: readBills() }));
$("#billList").addEventListener("click", (e) => { const id = e.target.closest("[data-del]")?.dataset.del; if (id) saveSoon({ bills: readBills().filter((b) => b.id !== id) }); });
$("#addBill").onclick = async () => {
  const due = new Date(Date.now() + 7 * 86400000).toLocaleDateString("en-CA");
  try { render(await api("/api/settings", { method: "PUT", body: { bills: [...readBills(), { name: "New bill", amount: 100, dueDate: due }] } })); } catch (e) { toast(e.message, "error"); }
};

// ------------------------------------------------------------------ books (AG Grid)
function pillFor(r) {
  if (r.status === "PAID") return `<span class="pill paid">Paid</span>`;
  if (r.status === "CANCELLED") return `<span class="pill muted">Cancelled</span>`;
  if (r.daysLate > 0) return `<span class="pill late">${r.daysLate}d late</span>`;
  if (r.status === "PARTIALLY_PAID") return `<span class="pill part">Part paid</span>`;
  if (r.daysUntilDue <= 2) return `<span class="pill soon">Due soon</span>`;
  return `<span class="pill open">Open</span>`;
}
function ensureGrid() {
  if (grid) { grid.setGridOption("rowData", state?.invoices || []); return; }
  grid = agGrid.createGrid($("#grid"), {
    rowData: state?.invoices || [],
    getRowId: (p) => p.data.id,
    domLayout: "autoHeight",
    rowHeight: 48,
    animateRows: true,
    defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true },
    columnDefs: [
      { headerName: "Customer", field: "customerName", minWidth: 150, flex: 1.1 },
      { headerName: "For", minWidth: 180, flex: 1.6, valueGetter: (p) => itemsText(p.data.items), tooltipValueGetter: (p) => p.value },
      { headerName: "Total", field: "amount", width: 100, type: "rightAligned", valueFormatter: (p) => fmt(p.value, p.data.currency) },
      { headerName: "Still owed", field: "outstanding", width: 115, type: "rightAligned", valueFormatter: (p) => (p.value ? fmt(p.value, p.data.currency) : "—") },
      { headerName: "Due", field: "dueDate", width: 110, valueFormatter: (p) => shortDate(p.value), sort: "asc" },
      { headerName: "Status", colId: "status", width: 120, valueGetter: (p) => p.data.daysLate, cellRenderer: (p) => pillFor(p.data) },
      { headerName: "Nudges", field: "remindersSent", width: 95, type: "rightAligned", valueFormatter: (p) => p.value || "—" },
      { headerName: "Language", field: "customerLanguage", width: 110 },
      { headerName: "PayPal #", field: "number", width: 105, valueFormatter: (p) => (p.data.live ? p.value : p.data.sample ? "example" : "practice") },
    ],
    isExternalFilterPresent: () => gridFilter !== "all",
    doesExternalFilterPass: (n) => (gridFilter === "open" ? isOpen(n.data) : isOpen(n.data) && n.data.daysLate > 0),
    rowClassRules: { "row-paid": (p) => p.data?.status === "PAID" },
    onRowClicked: (e) => openPerson(e.data.id),
    tooltipShowDelay: 400,
    overlayNoRowsTemplate: `<span style="color:#8a857c">Nothing here.</span>`,
  });
}
$("#filterSeg").addEventListener("click", (e) => {
  const f = e.target.dataset.filter;
  if (!f) return;
  gridFilter = f;
  $$("#filterSeg button").forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
  grid?.onFilterChanged();
});
$("#search").addEventListener("input", (e) => grid?.setGridOption("quickFilterText", e.target.value));
$("#exportBtn").onclick = () => grid?.exportDataAsCsv({ fileName: `tab-books-${state.today}.csv` });

// ------------------------------------------------------------------ settings
$("#settingsBtn").onclick = () => {
  const b = state.business;
  const m = state.modes;
  openSheet("Settings", `
    <div class="settings-list">
      <label>Business name<input id="sName" value="${esc(b.businessName)}" /></label>
      <label>Your name<input id="sOwner" value="${esc(b.ownerName)}" /></label>
      <label>What you sell<textarea id="sDesc" rows="2">${esc(b.description)}</textarea></label>
      <label>How you usually text customers (Tab writes like this)<textarea id="sTone" rows="3">${esc(b.toneSample)}</textarea></label>
    </div>
    <h2 class="section-title">Connections</h2>
    <div class="status-line"><span>Payments</span><span>${m.paypal ? `PayPal${m.env === "live" ? "" : " (sandbox)"}` : "Not connected — practice mode"}</span></div>
    <div class="status-line"><span>Payment updates</span><span>${m.webhooks ? "Instant (webhooks)" : "Checked every 15 seconds"}</span></div>
    <div class="status-line"><span>Writing help</span><span>${m.ai ? esc(m.aiLabel) + (m.aiError ? " — busy, using basic mode" : "") : "Basic mode"}</span></div>
    <p class="fine" style="margin-top:14px"><button class="link" id="resetDemo">Reset example data</button></p>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn navy" id="sSave">Save</button>`);
  $("#sSave").onclick = (e) => busy(e.currentTarget, async () => {
    render(await api("/api/settings", { method: "PUT", body: { business: { businessName: $("#sName").value, ownerName: $("#sOwner").value, description: $("#sDesc").value, toneSample: $("#sTone").value } } }));
    closeSheet();
    toast("Saved");
  });
  $("#resetDemo").onclick = async () => {
    if (!confirm("Reset to the example data? Invoices you created here are removed from Tab (not from PayPal).")) return;
    lastPaid.clear();
    try { localStorage.removeItem(dismissedKey()); } catch {}
    todayKey = null;
    render(await api("/api/reset", { method: "POST" }));
    closeSheet();
    toast("Example data restored");
  };
};

// ------------------------------------------------------------------ boot
route();
api("/api/state").then(render).catch((e) => toast(e.message, "error"));
const events = new EventSource("/api/events");
events.onmessage = (e) => render(JSON.parse(e.data));
setInterval(() => state && renderHome(), 60_000);

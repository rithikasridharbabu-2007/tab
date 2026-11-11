# Tab

**Tab turns a voice note into a PayPal invoice, then politely chases the people who owe you, in their language and your voice, before you run short on rent.**



## For judges: try it in 3 minutes

No sign-up needed. Open **https://tab-cd8v.onrender.com** (best in Chrome; voice works in Chrome and Edge).

1. **Make a sale.** Tap **Example** (or the microphone and say something like *"Priya took three dozen cupcakes, she'll pay Friday"*), then **Next**. Try **Ejemplo** for a Spanish note. Tab shows a one-sentence invoice and the message the customer will get, in their language.
2. **Send it.** Tap **Send with PayPal**. After a 5-second undo window, a real **PayPal sandbox invoice** is created and sent.
3. **Get paid** (pick one):
   - **As the customer:** open the person → **their pay page**, log in with the PayPal **sandbox buyer** account given in the Devpost testing instructions, and pay. Within about 15 seconds the row turns green in Tab.
   - **Without logging in:** open the person → **Got paid in cash**. Tab records the payment on the PayPal invoice.
4. **Let Tab plan follow-ups.** On Home, the **Today** card says whether you'll be short for a bill. Tap **Review follow-ups** → **Send**.
5. **See the books.** Open **Books** for the AG Grid ledger (filters, search, CSV export).

The demo starts with example customers (marked "example"); invoices you create are real sandbox invoices. **Settings → Reset example data** restores the starting state. The free server sleeps when idle, so the first load can take about 30 seconds.

## The problem

Millions of people run one-person businesses: home bakers, tutors, babysitters, cleaners, hair braiders, handymen. Many are immigrants working in a second language. Their business runs on trust and informal credit like "she'll pay Friday."

Three things go wrong:

1. **Nobody writes it down.** Invoicing software is built for accountants, not for someone with flour on their hands.
2. **Asking for money is awkward,** especially from neighbours and in a second language. So they don't ask, and the money never comes.
3. **The bills arrive anyway.** Rent is due Thursday whether Marco has paid for his cakes or not.

## What Tab does

| Step | What happens | Built with |
|---|---|---|
| **1. Say it** | Owner taps the mic: *"Priya took three dozen cupcakes, she'll pay Friday."* Any language. | Browser speech recognition |
| **2. Tab understands** | The AI extracts the customer, items, quantities, price (from the customer's usual order if not said) and resolves "Friday" to a date. It asks instead of guessing when the price is unclear. | Gemini `gemini-3.6-flash` (or Claude), structured outputs |
| **3. Real invoice** | Tab creates and sends a **PayPal invoice** with a friendly note written in the *customer's* language, in the owner's tone. | PayPal Invoicing v2: create + send |
| **4. Money check** | Tab projects the next 14 days of cash: bills going out, invoices coming in. *"You're $230 short for Rent on Thursday."* | Forecast + PayPal Transaction Search |
| **5. Who should I chase?** | The collections agent looks at the bills, who's late, who usually pays late but always pays, and who was nudged yesterday. It proposes a plan: gentle nudge, firm reminder, offer to split, or wait. | AI planning, structured outputs |
| **6. Owner approves, Tab acts** | One click sends each follow-up through PayPal. "Split" turns on partial payments on the invoice so the customer can pay half now. | PayPal Invoicing: remind, update (partial payment) |
| **7. Money lands** | When the customer pays on PayPal, the row turns green, cash goes up and the forecast updates live. | PayPal webhooks (signature-verified) + polling fallback, Server-Sent Events |

Everything lives in one **AG Grid** ledger, "Who owes me": sort by lateness, filter open or late, search, open the full history of every invoice, and act from the row.

**The AI never sends money messages on its own.** It drafts and plans; the owner approves.

### Built for a phone, for people who aren't accountants

- **Home** shows one number ("People owe you $546"), today's plan as a card ("You're $385 short for Rent on Friday. Review 3 follow-ups"), a big record button, and the list of people who owe you.
- **One-sentence confirm.** After a voice note Tab shows *"Invoice Priya $90 for 3 × Cupcakes, due Friday"* and a preview of exactly what Priya will receive, in her language. Details are one tap away, not a form.
- **5-second undo** after tapping Send, before anything reaches PayPal.
- **WhatsApp.** Every invoice and reminder can also go out on WhatsApp with the PayPal pay link, because that's where these customers actually talk. No extra setup: it uses a `wa.me` share link.
- **Got paid in cash** records the payment on the PayPal invoice, so the books match reality.
- **Money** shows the 14-day cash outlook and bills. **Books** is the full AG Grid ledger with filters, search and CSV export.
- Installable as a home-screen app (web app manifest).

## PayPal integration

| Feature | Endpoint |
|---|---|
| Create invoice (items, due date, tip, partial-payment config, note in customer's language) | `POST /v2/invoicing/invoices` |
| Send invoice to the customer | `POST /v2/invoicing/invoices/{id}/send` |
| Friendly / firm reminders | `POST /v2/invoicing/invoices/{id}/remind` |
| Offer to split: enable partial payment with a minimum | `PUT /v2/invoicing/invoices/{id}` |
| "Got paid in cash": record an outside payment so the books stay right | `POST /v2/invoicing/invoices/{id}/payments` |
| Cancel | `POST /v2/invoicing/invoices/{id}/cancel` |
| Read status, amount paid, customer's pay link | `GET /v2/invoicing/invoices/{id}` |
| Recent income for the cash forecast | `GET /v1/reporting/transactions` |
| Live payment updates | Webhooks `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.UPDATED`, `INVOICING.INVOICE.CANCELLED`, verified with `POST /v1/notifications/verify-webhook-signature` |

Every POST/PUT sends a deterministic `PayPal-Request-Id`, so a retry never creates a duplicate invoice or a second reminder.

## AI (Gemini or Claude)

All AI calls are in [`lib/ai.js`](lib/ai.js). Every call uses **structured outputs**: one Zod schema per task, sent to the model as a JSON schema and validated again on the way back.

- **Google Gemini** (`gemini-3.6-flash`, free tier) through `@google/genai` (`models.generateContent` with a JSON response schema), with an automatic switch to `gemini-3.5-flash-lite` if the first model is busy. Used when `GEMINI_API_KEY` is set. Change the model with `GEMINI_MODEL`.
- **Claude** (`claude-opus-5-5`) through the Anthropic SDK with server-side refusal fallbacks, used when only `ANTHROPIC_API_KEY` is set.

1. **`understandNote`:** messy speech in any language → a structured invoice (customer match against known customers, items, quantities, prices, due date, language, and open questions).
2. **`writeMessage`:** invoice notes, reminders, firm reminders and split offers, in the customer's language and copied from the owner's tone sample, with an English translation so the owner can check it.
3. **`planCollections`:** reads bills, cash and every open invoice (with payment history and nudge history) and returns a prioritised plan with a plain-English reason for each action.

With no key, rule-based fallbacks run and the UI shows "AI: offline (rules)". If an AI call fails at runtime (free-tier quota, outage), that one step falls back to the rules too and the header says "unavailable, using rules", so a live demo never breaks.

## Run it locally

Requirements: Node 20+.

```bash
git clone <this repo> && cd tab
npm install
cp .env.example .env     # fill in the keys below
npm start                # http://localhost:3000
```

### Keys

1. **PayPal sandbox:** go to [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → Sandbox → create an app. Copy the Client ID and Secret into `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
2. **Sandbox buyer:** go to Testing Tools → Sandbox Accounts and copy the **Personal** account's email into `SANDBOX_BUYER_EMAIL`. Invoices go there, and you pay them by logging in with that account.
3. **AI (free):** at [aistudio.google.com](https://aistudio.google.com) click **Get API key → Create API key** and put it in `GEMINI_API_KEY`. (Or, paid: a Claude key from [console.anthropic.com](https://console.anthropic.com) in `ANTHROPIC_API_KEY`.)

With no keys at all, Tab still runs: PayPal is simulated (a "Simulate pay" button appears) and AI uses rules. The header shows which mode you're in.

### Try the full loop (about 2 minutes)

1. Tap **Priya · cupcakes** (or the mic) → **Make invoice**. Check the draft → **Send with PayPal**.
2. In the ledger, click **Pay link ↗** on Priya's row, log in with the sandbox personal account and pay.
3. Within about 15 seconds the row turns green, cash goes up and the money check updates.
4. Click **Who should I chase?** → review the plan → **Send approved**.

### Webhooks (optional, needs a public URL)

Deploy (below), then in your PayPal app add a webhook at `https://<your-app>/api/webhooks/paypal` for the `INVOICING.INVOICE.*` events and put its id in `PAYPAL_WEBHOOK_ID`. Without it, Tab polls PayPal every 15 seconds (webhooks can't reach localhost).

## Deploy on Render

The repo includes [`render.yaml`](render.yaml). In Render, go to New → Blueprint, pick this repo and fill in the environment variables. Data is stored in a JSON file (`data/db.json`); on Render's free plan it resets on redeploy, which is fine for a demo.

## Project layout

```
server.js        Express API, forecast, webhooks, polling, live updates (SSE)
lib/paypal.js    PayPal REST client (Invoicing v2, Transaction Search, webhook verification)
lib/ai.js        Gemini/Claude: note → invoice, messages, collections plan (+ rule-based fallbacks)
lib/store.js     JSON-file store + demo data (a home bakery)
public/          Single-page UI: AG Grid ledger, voice capture, money check
```

## Honest limits

- Runs on the **PayPal sandbox** (test money).
- Single owner, no login. A real version needs accounts and a database.
- Speech recognition uses the browser's built-in engine (best in Chrome or Edge); typing always works.
- On Gemini's free tier, Google may use requests to improve its products, so use demo data only. Free-tier rate limits apply.
- PayPal sends the invoice and reminder emails. Tab writes the note inside them in the customer's language, but PayPal's surrounding email template uses PayPal's own language settings.
- Sandbox Transaction Search data can lag by a few hours; the forecast does not depend on it.
- Sample customers in the demo data are marked "sample" and never touch PayPal.

## License

MIT

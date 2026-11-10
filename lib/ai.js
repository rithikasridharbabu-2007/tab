// The AI side of Tab, using structured (schema-checked JSON) outputs.
//   1. understandNote  - a messy voice note in any language -> a structured invoice
//   2. writeMessage    - invoice / reminder / split-offer text in the customer's language and the owner's tone
//   3. planCollections - looks at bills and who owes what, and proposes who to chase first
// Provider: Google Gemini if GEMINI_API_KEY is set (free tier), else Claude if ANTHROPIC_API_KEY is set.
// With no key, or if the AI call fails (quota, outage), simple rule-based fallbacks run and the UI says so.
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const CLAUDE_MODEL = "claude-opus-5-5";
const geminiModel = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";

export function aiProvider() {
  if (process.env.GEMINI_API_KEY) return { name: "gemini", label: `Gemini (${geminiModel()})` };
  if (process.env.ANTHROPIC_API_KEY) return { name: "claude", label: `Claude (${CLAUDE_MODEL})` };
  return null;
}
export const aiEnabled = () => Boolean(aiProvider());

let claudeClient = null;
let geminiClient = null;

async function structured(schema, system, user, effort = "low") {
  return aiProvider()?.name === "gemini"
    ? structuredGemini(schema, system, user)
    : structuredClaude(schema, system, user, effort);
}

// Gemini: generateContent with a JSON-schema response, validated again with Zod.
// Free-tier models are sometimes overloaded (503) or rate-limited (429), so each call
// has a timeout and moves on to the next free model in the list.
const GEMINI_BACKUPS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];
async function structuredGemini(schema, system, user) {
  geminiClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const models = [...new Set([geminiModel(), ...GEMINI_BACKUPS])];
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  let lastErr;
  for (const model of models) {
    try {
      const res = await geminiClient.models.generateContent({
        model,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          abortSignal: AbortSignal.timeout(30_000),
        },
      });
      let json;
      try { json = JSON.parse(res.text || ""); } catch { throw new Error("The AI returned an unreadable answer."); }
      return schema.parse(json);
    } catch (e) {
      lastErr = e;
      const retryable = [429, 500, 503, 504].includes(e?.status) || e?.name === "AbortError" || e?.name === "TimeoutError";
      if (!retryable) throw e;
      console.warn(`Gemini ${model} unavailable (${e?.status || e?.name}), trying next model`);
    }
  }
  throw lastErr;
}

// Claude: server-side fallback - if a request is ever declined by a safety classifier,
// the API retries it on a fallback model inside the same call.
async function structuredClaude(schema, system, user, effort) {
  claudeClient ??= new Anthropic();
  const res = await claudeClient.beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal") throw new Error("The AI declined this request.");
  if (!res.parsed_output) throw new Error("The AI returned an unreadable answer.");
  return res.parsed_output;
}

// If the AI call fails (no credit, free-tier quota, outage), keep the app working with the rules.
export let lastAIError = null;
async function tryAI(run, fallback) {
  try {
    const out = await run();
    lastAIError = null;
    return out;
  } catch (e) {
    lastAIError = { at: new Date().toISOString(), message: String(e?.message || e).slice(0, 300) };
    console.error("AI call failed, using rule-based fallback:", lastAIError.message);
    return { ...fallback(), aiError: "AI was unavailable, so Tab used its simple rules for this one." };
  }
}

// ---------------------------------------------------------------- 1. voice note -> invoice
const NoteSchema = z.object({
  customer_name: z.string().describe("Customer's name as spoken, best guess at spelling"),
  matched_customer_id: z.string().nullable().describe("id from the known customers list if this is clearly the same person, else null"),
  customer_email: z.string().nullable().describe("Only if stated or known from the customer list"),
  customer_language: z.string().describe("Language to write to this customer in, e.g. 'English', 'Spanish'. Use the known customer's language if matched; otherwise the language of the note."),
  items: z.array(z.object({
    name: z.string().describe("Short item description in English"),
    quantity: z.number(),
    unit_price: z.number().describe("Price per unit. If only a total was said, quantity 1 and the total."),
  })),
  currency: z.string().describe("ISO currency code, default to the business currency"),
  due_date: z.string().describe("YYYY-MM-DD. Resolve phrases like 'Friday' or 'end of month' relative to today. If none given, 7 days from today."),
  note_language: z.string().describe("Language the owner spoke in"),
  summary: z.string().describe("One short English sentence restating what you understood"),
  questions: z.array(z.string()).describe("Anything genuinely ambiguous the owner should confirm (e.g. price not stated). Empty if clear."),
});

export async function understandNote({ text, today, business, customers }) {
  if (!aiEnabled()) return fallbackNote({ text, today, business, customers });
  const system = `You turn a small-business owner's quick spoken note into an invoice.
The owner runs "${business.businessName}" (${business.description}). Business currency: ${business.currency}.
Notes can be in any language and are often casual ("she'll pay Friday", "same as last time").
Never invent a price: if no price is said and the customer list has no usual price, set unit_price to 0 and ask in "questions".`;
  const user = `Today is ${today} (${new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" })}).
Known customers (JSON): ${JSON.stringify(customers.map(({ id, name, email, language, usual }) => ({ id, name, email, language, usual })))}

Owner's note:
"""${text}"""`;
  const out = await tryAI(() => structured(NoteSchema, system, user, "medium"), () => fallbackNote({ text, today, business, customers }));
  if (out.source === "rules") return out;
  return { ...out, source: "ai" };
}

// ---------------------------------------------------------------- 2. messages in the customer's language
const MessageSchema = z.object({
  subject: z.string().describe("Short email subject in the customer's language"),
  message: z.string().describe("The message in the customer's language, 2-5 sentences, sounds like the owner wrote it"),
  english: z.string().describe("English translation so the owner can check it"),
});

const KIND_GUIDE = {
  invoice: "A friendly note to go with a new invoice. Thank them, say what it's for and when it's due.",
  reminder: "A polite payment reminder. Never guilt-trip or threaten. Assume good faith; make paying easy.",
  firm_reminder: "A clear, still-kind reminder for a payment that is well overdue. Mention the date it was due. No threats.",
  split_offer: "Offer to split the bill into two smaller payments to make it easier. Warm, no judgement. Say they can pay part now through the same PayPal link.",
};

export async function writeMessage({ kind, invoice, business, daysLate }) {
  if (!aiEnabled()) return fallbackMessage({ kind, invoice, business, daysLate });
  const system = `You write short payment messages on behalf of ${business.ownerName}, owner of "${business.businessName}".
Match the owner's voice. Examples of how they write: """${business.toneSample}"""
Write in ${invoice.customerLanguage}. Plain text, no placeholders, no links (PayPal adds the pay button), sign off as ${business.ownerName.split(" ")[0]}.`;
  const user = `Kind of message: ${kind} - ${KIND_GUIDE[kind]}
Customer: ${invoice.customerName}
Items: ${invoice.items.map((i) => `${i.quantity} x ${i.name}`).join(", ")}
Amount: ${invoice.amount.toFixed(2)} ${invoice.currency}${invoice.paidAmount ? ` (already paid ${invoice.paidAmount.toFixed(2)})` : ""}
Due date: ${invoice.dueDate}${daysLate > 0 ? ` (${daysLate} days late)` : ""}
Reminders already sent: ${invoice.remindersSent || 0}`;
  return tryAI(async () => ({ ...(await structured(MessageSchema, system, user, "low")), source: "ai" }), () => fallbackMessage({ kind, invoice, business, daysLate }));
}

// ---------------------------------------------------------------- 3. collections plan
const PlanSchema = z.object({
  headline: z.string().describe("One sentence the owner sees first, e.g. 'You're $410 short for rent on Thursday.'"),
  shortfall: z.number().describe("Biggest projected gap before the next bill is covered, 0 if none"),
  explanation: z.string().describe("One or two short, plain sentences (under 30 words total) on why these follow-ups. Speak to the owner as 'you'. No dates in YYYY-MM-DD form."),
  actions: z.array(z.object({
    invoice_id: z.string(),
    action: z.enum(["remind", "firm_reminder", "split_offer", "wait"]),
    reason: z.string().describe("Short, specific reason the owner will understand"),
  })).describe("Ordered most important first. Only invoices that are SENT, PARTIALLY_PAID or overdue."),
});

export async function planCollections({ today, business, cash, bills, invoices }) {
  if (!aiEnabled()) return fallbackPlan({ today, cash, bills, invoices });
  const system = `You are the collections assistant for "${business.businessName}", a one-person business.
Your job: make sure the owner can pay their upcoming bills, while keeping good relationships with customers.
Rules of thumb: chase what matters for the next bill first; customers who usually pay late but always pay need a gentle reminder, not a firm one;
offer to split only for larger amounts or customers who seem stretched; don't remind someone who was reminded in the last 2 days ("wait").
Never recommend anything harsh. Use the owner's currency (${business.currency}).`;
  // Give the model weekday names so it never has to work them out from dates.
  const weekday = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const user = `Today: ${weekday(today)} ${today}
Cash available now: ${cash}
Upcoming bills: ${JSON.stringify(bills.map((b) => ({ ...b, dueDay: weekday(b.dueDate) })))}
Open invoices: ${JSON.stringify(invoices.map((i) => ({ ...i, dueDay: weekday(i.dueDate) })))}
When you mention a day, use the dueDay given.`;
  return tryAI(async () => ({ ...(await structured(PlanSchema, system, user, "medium")), source: "ai" }), () => fallbackPlan({ today, cash, bills, invoices }));
}

// ================================================================ rule-based fallbacks (no API key)
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12 };

function fallbackNote({ text, today, business, customers }) {
  const lower = text.toLowerCase();
  const match = customers.find((c) => lower.includes(c.name.split(" ")[0].toLowerCase()));
  const amount = Number((text.match(/[$€£]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:dollars|bucks|euros|pounds)/i) || []).slice(1).find(Boolean) || 0);
  const qtyWord = lower.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:dozen\s+)?/);
  const qty = qtyWord ? Number(qtyWord[1]) || WORDS[qtyWord[1]] || 1 : 1;
  const due = new Date(today + "T12:00:00");
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayIdx = days.findIndex((d) => lower.includes(d));
  if (dayIdx >= 0) due.setDate(due.getDate() + (((dayIdx - due.getDay() + 7) % 7) || 7));
  else due.setDate(due.getDate() + 7);
  // No price said? Use the customer's usual price ("$30 a dozen") if we know it.
  let unit = amount, q = 1;
  if (!amount && match?.usual) {
    const usual = Number((match.usual.match(/\$\s?(\d+(?:\.\d+)?)/) || [])[1] || 0);
    if (usual) { unit = usual; q = qty; }
  }
  const name = match?.name || (text.match(/\b([A-Z][a-z]+)\b/) || [])[1] || "Customer";
  return {
    customer_name: name,
    matched_customer_id: match?.id || null,
    customer_email: match?.email || null,
    customer_language: match?.language || "English",
    items: [{ name: match?.usual && !amount ? match.usual.split(",")[0] : text.length > 60 ? text.slice(0, 57) + "..." : text, quantity: q, unit_price: unit }],
    currency: business.currency,
    due_date: due.toISOString().slice(0, 10),
    note_language: "English",
    summary: `Invoice ${name} ${unit ? (unit * q).toFixed(2) + " " + business.currency : "(amount unknown)"}.`,
    questions: unit ? (amount ? [] : ["Used this customer's usual price — please check it."]) : ["What's the price? (AI is offline, so I couldn't work it out.)"],
    source: "rules",
  };
}

function fallbackMessage({ kind, invoice, business, daysLate }) {
  const first = invoice.customerName.split(" ")[0];
  const sign = business.ownerName.split(" ")[0];
  const amt = `${invoice.amount.toFixed(2)} ${invoice.currency}`;
  const text = {
    invoice: `Hi ${first}! Thanks so much for your order. Here's the invoice for ${amt}, due ${invoice.dueDate}. — ${sign}`,
    reminder: `Hi ${first}, just a friendly reminder about the ${amt} invoice due ${invoice.dueDate}. Thank you! — ${sign}`,
    firm_reminder: `Hi ${first}, the ${amt} invoice was due on ${invoice.dueDate} (${daysLate} days ago). Could you take care of it this week? Thanks — ${sign}`,
    split_offer: `Hi ${first}, if it's easier, you're welcome to pay the ${amt} in two parts — just pay part now with the same link. — ${sign}`,
  }[kind];
  return { subject: `${business.businessName}: invoice for ${amt}`, message: text, english: text, source: "rules" };
}

function fallbackPlan({ today, cash, bills, invoices }) {
  const nextBill = [...bills].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const owed = invoices.reduce((s, i) => s + i.outstanding, 0);
  const shortfall = nextBill ? Math.max(0, nextBill.amount - cash) : 0;
  const actions = [...invoices]
    .sort((a, b) => b.daysLate - a.daysLate || b.outstanding - a.outstanding)
    .map((i) => ({
      invoice_id: i.id,
      action: i.lastReminderDaysAgo !== null && i.lastReminderDaysAgo < 2 ? "wait" : i.daysLate > 7 ? "firm_reminder" : i.outstanding > 150 && i.daysLate > 0 ? "split_offer" : "remind",
      reason: i.daysLate > 0 ? `${i.daysLate} days late, ${i.outstanding.toFixed(2)} outstanding` : `Due ${i.dueDate}`,
    }));
  return {
    headline: shortfall > 0 ? `You're $${shortfall.toFixed(0)} short for ${nextBill.name} on ${new Date(nextBill.dueDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" })}.` : "You're covered for your next bill.",
    shortfall,
    explanation: `You have $${cash} now and people owe you $${owed.toFixed(0)}. Start with whoever is latest.`,
    actions,
    source: "rules",
  };
}

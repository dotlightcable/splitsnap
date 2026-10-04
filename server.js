/**
 * SplitSnap — your money agent.
 * PayPal AI Hackathon 2026 entry (work in progress).
 *
 * Chat-first: one agent that splits bills, sends PayPal requests,
 * chases late payers, and tracks who paid.
 *
 * Modes:
 *   MOCK (default, no creds): full flow runs with simulated PayPal invoices.
 *   LIVE (set PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET): real sandbox invoices
 *        via @paypal/agent-toolkit.
 */
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LIVE = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const MEMO = 'SplitSnap bill';

// ---------- receipt parsing (heuristic v1; AI vision plugs in here) ----------
function parseReceiptLines(text) {
  // Accepts lines like "Margherita pizza 18.50" or "2x Coke 3.00"
  const items = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:(\d+)\s*[xX]\s*)?(.+?)\s+(\d+(?:\.\d{1,2})?)$/);
    if (!m) continue;
    const qty = parseInt(m[1] || '1', 10);
    items.push({ name: m[2].trim(), qty, unitPrice: parseFloat(m[3]) });
  }
  return items;
}

// ---------- split math (shares always sum to the exact total) ----------
function splitEven(items, people) {
  const total = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const totalCents = Math.round(total * 100);
  const n = Math.max(people.length, 1);
  const base = Math.floor(totalCents / n);
  let rem = totalCents - base * n;
  const shares = people.map((email) => {
    const cents = base + (rem-- > 0 ? 1 : 0);
    return { email, amount: cents / 100 };
  });
  return { total: totalCents / 100, shares };
}

// Uneven shares: claimed items go to their person, unclaimed items split evenly.
function computeShares() {
  const claimed = {};
  bill.people.forEach((p) => { claimed[p] = 0; });
  let unclaimedCents = 0;
  for (const it of bill.items) {
    const c = Math.round(it.qty * it.unitPrice * 100);
    if (it.claimedBy && claimed[it.claimedBy] !== undefined) claimed[it.claimedBy] += c;
    else unclaimedCents += c;
  }
  const n = Math.max(bill.people.length, 1);
  const base = Math.floor(unclaimedCents / n);
  let rem = unclaimedCents - base * n;
  const shares = bill.people.map((email) => {
    const cents = (claimed[email] || 0) + base + (rem-- > 0 ? 1 : 0);
    return { email, amount: cents / 100 };
  });
  const total = Math.round(shares.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  return { total, shares };
}

// ---------- PayPal layer (mock <-> live) ----------
let toolkit = null;
async function getToolkit() {
  if (!LIVE) return null;
  if (!toolkit) {
    const { PayPalAgentToolkit } = require('@paypal/agent-toolkit/ai-sdk');
    toolkit = new PayPalAgentToolkit({
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET,
      configuration: { actions: { invoices: { create: true, send: true, get: true, generateQRC: true, sendReminder: true } }, context: { sandbox: true } },
    });
  }
  return toolkit;
}

function pickTool(tools, name) {
  if (!tools) return null;
  if (Array.isArray(tools)) return tools.find((t) => t && t.name === name) || null;
  return tools[name] || null;
}

function unpackResult(out) {
  let o = out;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { throw new Error('PayPal returned an unreadable response'); }
  }
  if (o && o.error) throw new Error(o.error.message || 'PayPal error');
  if (o && (o.ok === false || (typeof o.status === 'number' && o.status >= 400))) {
    throw new Error(o.message || 'PayPal refused the request (permissions?)');
  }
  return o || {};
}

async function requestMoney({ email, amount, memo }) {
  if (!LIVE) {
    const fakeId = 'MOCK-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    return { id: fakeId, status: 'SENT (mock)', payLink: `https://www.sandbox.paypal.com/invoice/p#${fakeId}` };
  }
  const tk = await getToolkit();
  const tools = tk.getTools ? tk.getTools() : {};
  const create = pickTool(tools, 'create_invoice');
  if (!create) throw new Error('create_invoice tool not available');
  const created = unpackResult(await create.execute({
    currency_code: 'USD',
    primary_recipients: [{ billing_info: { email_address: email } }],
    items: [{ name: memo || MEMO, quantity: '1', unit_amount: { currency_code: 'USD', value: amount.toFixed(2) } }],
  }));
  const invoiceId = created.id || created.invoice_id || (created.href && created.href.split('/').pop());
  if (!invoiceId) throw new Error('PayPal did not return an invoice id');
  const send = pickTool(tools, 'send_invoice');
  if (send) {
    try { unpackResult(await send.execute({ invoice_id: invoiceId, send_to_recipient: true })); }
    catch (e) { /* draft exists; surfacing id is enough */ }
  }
  // Real tappable pay link for the recipient.
  let payLink = `https://www.sandbox.paypal.com/invoice/payerView/details/${invoiceId}`;
  const get = pickTool(tools, 'get_invoice');
  if (get) {
    try {
      const det = unpackResult(await get.execute({ invoice_id: invoiceId }));
      const href = (det?.links || []).find((l) => l.rel === 'recipient_view' || l.rel === 'payer_view');
      payLink = det?.detail?.metadata?.recipient_view_url || (href && href.href) || payLink;
    } catch (e) { /* keep fallback link */ }
  }
  return { id: invoiceId, status: LIVE ? 'SENT (sandbox)' : 'SENT (mock)', payLink };
}

// ---------- agent state (single-demo-user) ----------
const bill = { items: [], people: [], requests: [] };
// request: { email, amount, id, payLink, status, paid, reminders }

function snapshot() {
  const outstanding = bill.requests.filter((r) => !r.paid);
  const collected = bill.requests.filter((r) => r.paid).reduce((s, r) => s + r.amount, 0);
  const owed = outstanding.reduce((s, r) => s + r.amount, 0);
  return {
    total: Math.round(bill.requests.reduce((s, r) => s + r.amount, 0) * 100) / 100,
    collected: Math.round(collected * 100) / 100,
    owed: Math.round(owed * 100) / 100,
    mode: LIVE ? 'live-sandbox' : 'mock',
    requests: bill.requests.map((r) => ({ ...r })),
  };
}

async function refreshStatuses() {
  // Ask PayPal for the truth: mark requests paid if their invoice is settled.
  if (!LIVE || !bill.requests.some((r) => !r.paid)) return [];
  const tk = await getToolkit();
  const tools = tk.getTools ? tk.getTools() : {};
  const get = pickTool(tools, 'get_invoice');
  if (!get) return [];
  const newlyPaid = [];
  for (const r of bill.requests) {
    if (r.paid || !r.id || String(r.id).startsWith('MOCK')) continue;
    try {
      const det = unpackResult(await get.execute({ invoice_id: r.id }));
      const st = String(det.status || '').toUpperCase();
      if ((st === 'PAID' || st === 'MARKED_AS_PAID') && !r.paid) {
        r.paid = true;
        newlyPaid.push(r);
      }
    } catch (e) { /* leave as-is on lookup failure */ }
  }
  return newlyPaid;
}

function extractEmails(text) {
  const m = String(text).match(/[\w.+-]+@[\w-]+\.[\w.]+/g);
  return m ? [...new Set(m.map((e) => e.toLowerCase()))] : [];
}

function extractAmount(text) {
  const m = String(text).match(/\$?\s?(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

function findRequest(fragment) {
  const f = fragment.trim().toLowerCase();
  return bill.requests.find((r) => r.email.toLowerCase().includes(f) || r.email.split('@')[0].toLowerCase() === f);
}

function findPerson(fragment) {
  const f = String(fragment || '').trim().toLowerCase().replace(/^@/, '');
  if (!f) return null;
  return bill.people.find((p) => {
    const pl = p.toLowerCase();
    return pl === f || pl.split('@')[0] === f || pl.split('@')[0].includes(f);
  }) || null;
}

function findItems(fragment) {
  const f = String(fragment || '').trim().toLowerCase();
  if (!f) return [];
  return bill.items.filter((it) => it.name.toLowerCase().includes(f));
}

function shortName(email) {
  return email.split('@')[0];
}

function nudgeText(req) {
  const lvl = req.reminders;
  const link = req.payLink;
  if (lvl <= 1) return `Hey ${shortName(req.email)}! 🙏 friendly nudge — your $${req.amount} share (${MEMO}) is waiting here: ${link}`;
  if (lvl === 2) return `${shortName(req.email)}, second call 📣 — $${req.amount} still open on ${MEMO}. Two taps and you're free: ${link}`;
  return `${shortName(req.email)} — final call 🔔 $${req.amount} for ${MEMO}. Pay here before I start charging interest in memes: ${link}`;
}

async function doSplit() {
  const { shares } = computeShares();
  const made = [];
  for (const s of shares) {
    try {
      made.push({ ...s, ...(await requestMoney({ email: s.email, amount: s.amount, memo: MEMO })), paid: false, reminders: 0 });
    } catch (e) {
      if (/permission|scope|authoriz|access/i.test(e.message)) {
        throw new Error('PayPal refused — this app needs the Invoicing permission (dashboard → Apps & Credentials → the app → enable it).');
      }
      throw e;
    }
  }
  bill.requests = made;
  return snapshot();
}

// ---------- agent brain ----------
async function handleAgent(raw) {
  const text = String(raw || '').trim();
  const low = text.toLowerCase();
  if (!text) return { reply: 'Say the word — e.g. “Split $64 between ana@x.com and ben@x.com”.' };
  // Command words must live OUTSIDE emails ("chase-a@x.com" is a person, not an order).
  const lowNoEmails = low.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ').trim();

  if (/^(reset|start over|clear|new bill)/.test(low)) {
    bill.items = []; bill.people = []; bill.requests = [];
    return { reply: 'Fresh slate 🧹 What are we splitting?' };
  }

  if (/^(help|what can you do|how does this work)/.test(low) || low === 'hi' || low === 'hey') {
    return { reply: 'I split bills and chase the money. Try:\n• “Split $64 between ana@x.com and ben@x.com”\n• paste receipt lines like “Pizza 18.50”\n• “ana had the pizza” for uneven splits\n• “Remind ben” when someone ghosts\n• “Who hasn\'t paid?” for the damage report' };
  }

  // status: who owes / hasn't paid / did anyone pay (refresh from PayPal first)
  if (/(who|hasn.?t|haven.?t|owe|owes|status|left|damage|summary|anyone pay|check payments|paid yet)/.test(lowNoEmails)) {
    if (!bill.requests.length) return { reply: 'No bill on the table yet. Give me a receipt or a total.' };
    const fresh = await refreshStatuses();
    const left = bill.requests.filter((r) => !r.paid);
    if (!left.length) {
      const who = fresh.length ? `${fresh.map((r) => shortName(r.email)).join(', ')} just paid — ` : '';
      return { reply: `${who}All settled — zero debt, zero drama 🎉`, bill: snapshot() };
    }
    const news = fresh.length ? ` (just spotted 👀: ${fresh.map((r) => shortName(r.email)).join(', ')} paid!)` : '';
    const lines = left.map((r) => `• ${r.email}: $${r.amount}`).join('\n');
    return { reply: `Checked PayPal just now${news}\nStill owed $${snapshot().owed}:\n${lines}`, bill: snapshot() };
  }

  // mark paid: "ben paid" / "ana has paid" / "mark ana as paid" (anchored — no "hasn't" misfires)
  let m = low.match(/^(?:mark\s+)?([\w.+-]+?)(?:\s+has)?(?:\s+as)?\s+paid\s*[?.!]*$/);
  if (m) {
    const req = findRequest(m[1]);
    if (!req) return { reply: `Hmm, I don't have anyone matching “${m[1]}” on this bill.` };
    req.paid = true;
    const left = bill.requests.filter((r) => !r.paid);
    return {
      reply: left.length
        ? `Nice — ${shortName(req.email)} is settled ✅ ${left.length} still owe.`
        : `Everyone's paid. Beautiful. 🎉`,
      bill: snapshot(),
    };
  }

  // remind / chase / nudge (command word must be outside any email)
  if (/(remind|chase|nudge|bug|ping)/.test(lowNoEmails)) {
    if (!bill.requests.length) return { reply: 'Nothing to chase yet — split a bill first.' };
    let targets = bill.requests.filter((r) => !r.paid);
    const named = low.replace(/(remind|chase|nudge|bug|ping|everyone|all|them|please)/g, '').trim();
    if (named && !/^(everyone|all|them)?$/.test(named)) {
      const one = findRequest(named);
      if (!one) return { reply: `Can't find “${named}” on this bill.` };
      targets = one.paid ? [] : [one];
    }
    if (!targets.length) return { reply: 'Nobody left to chase — all settled 🎉' };
    targets.forEach((r) => { r.reminders += 1; });
    // Real PayPal reminder email on top of our nudge text.
    let emailed = 0;
    if (LIVE) {
      try {
        const tk = await getToolkit();
        const rtools = tk.getTools ? tk.getTools() : {};
        const remindTool = pickTool(rtools, 'send_invoice_reminder');
        if (remindTool) {
          for (const t of targets) {
            if (!t.id || String(t.id).startsWith('MOCK')) continue;
            try { unpackResult(await remindTool.execute({ invoice_id: t.id })); emailed += 1; }
            catch (e) { /* one failure shouldn't block the rest */ }
          }
        }
      } catch (e) { /* fall back to text nudge only */ }
    }
    const nudge = targets.map(nudgeText).join('\n');
    const who = targets.map((r) => shortName(r.email)).join(', ');
    const via = emailed ? ' PayPal emailed them too ✉️' : '';
    return { reply: `On it — nudging ${who} 😤${via}`, nudge, bill: snapshot() };
  }

  const emails = extractEmails(text);
  const amount = extractAmount(text);

  // one-shot: "split $64 between a@x and b@y"
  if (/(split|between|\bways\b)/.test(lowNoEmails) && (emails.length || amount)) {
    if (amount) bill.items = [{ name: 'Group dinner', qty: 1, unitPrice: amount }];
    if (emails.length) bill.people = emails;
    if (!bill.items.length) return { reply: 'Got it — but how much is the bill? e.g. “Split $64 between …”' };
    if (!bill.people.length) {
      const t = Math.round(bill.items.reduce((s, i) => s + i.qty * i.unitPrice, 0) * 100) / 100;
      return { reply: `$${t} on the table — who's splitting? Drop their emails.` };
    }
    const snap = await doSplit();
    return {
      reply: `Done — split $${snap.total} ${snap.requests.length} ways, PayPal requests sent 💸`,
      bill: snap,
    };
  }

  // bare emails → set the crew
  if (emails.length && !parseReceiptLines(text).length) {
    const fresh = emails.filter((e) => !bill.people.includes(e));
    bill.people.push(...fresh);
    if (!bill.items.length) return { reply: `Crew locked: ${bill.people.join(', ')}. Now — how much? Paste receipt lines or a total like “$64”.` };
    if (!bill.requests.length) return { reply: `Crew: ${bill.people.join(', ')} ✅ Say “split it” and I'll fire the requests.` };
    return { reply: 'Bill already sent — say “reset” to start a fresh one.' };
  }

  // receipt lines → add items
  const items = parseReceiptLines(text);
  if (items.length) {
    bill.items.push(...items);
    const total = Math.round(bill.items.reduce((s, i) => s + i.qty * i.unitPrice, 0) * 100) / 100;
    if (!bill.people.length) return { reply: `Logged ${items.length} item${items.length > 1 ? 's' : ''} — $${total} so far. Who's in? Send their emails.` };
    if (!bill.requests.length) return { reply: `$${total} on the table 🧾 Say “split it” and money moves.` };
    return { reply: 'Bill already sent — say “reset” to start a fresh one.' };
  }

  // claims: "ana had the pizza and coke" / "pizza is ana's" / "give pizza to ana"
  const hadM = low.match(/^([\w.@+-]+)\s+had\s+(.+)$/);
  const isM = low.match(/^(.+?)\s+is\s+([\w.@+-]+)'s$/);
  const giveM = low.match(/^give\s+(.+?)\s+to\s+([\w.@+-]+)$/);
  const claimM = hadM ? { person: hadM[1], items: hadM[2] }
    : isM ? { person: isM[2], items: isM[1] }
    : giveM ? { person: giveM[2], items: giveM[1] } : null;
  if (claimM && claimM.person && claimM.items) {
    const person = findPerson(claimM.person);
    if (!person) return { reply: `Who's “${claimM.person}”? I only know: ${bill.people.join(', ') || 'nobody yet — send emails first'}.` };
    const frags = String(claimM.items).split(/\s+and\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
    const missed = [];
    let tagged = 0;
    for (const f of frags) {
      const hits = findItems(f);
      if (!hits.length) { missed.push(f); continue; }
      hits.forEach((it) => { it.claimedBy = person; });
      tagged += hits.length;
    }
    if (!tagged) return { reply: `Couldn't find “${frags.join(', ')}” on the bill. Items I see: ${bill.items.map((i) => i.name).join(', ') || 'none yet'}.` };
    const { shares } = computeShares();
    const preview = shares.map((s) => `${shortName(s.email)} $${s.amount}`).join(' · ');
    const miss = missed.length ? ` (didn't catch: ${missed.join(', ')})` : '';
    return { reply: `Noted — ${shortName(person)} takes it 🍽️\nRunning shares: ${preview}${miss}\nSay “split it” when ready.` };
  }

  // add: "add $8 tip" / "add Garlic bread 6.50"
  const addM = low.match(/^add\s+(.+)$/);
  if (addM) {
    const rest = addM[1].trim();
    const tipM = rest.match(/^\$?(\d+(?:\.\d{1,2})?)\s*(tip|service|delivery|fee)?$/);
    const extra = tipM
      ? [{ name: tipM[2] ? tipM[2][0].toUpperCase() + tipM[2].slice(1) : 'Extra', qty: 1, unitPrice: parseFloat(tipM[1]) }]
      : parseReceiptLines(rest);
    if (!extra.length) return { reply: 'Add what? e.g. “add $8 tip” or “add Garlic bread 6.50”.' };
    bill.items.push(...extra.map((i) => ({ ...i, claimedBy: null })));
    const total = Math.round(bill.items.reduce((s, i) => s + i.qty * i.unitPrice, 0) * 100) / 100;
    return { reply: `Added ${extra.map((i) => `${i.name} $${(i.qty * i.unitPrice).toFixed(2)}`).join(', ')} — bill's now $${total}.` };
  }

  // bare amount → set total
  if (amount && !emails.length) {
    bill.items = [{ name: 'Group bill', qty: 1, unitPrice: amount }];
    if (!bill.people.length) return { reply: `$${amount} — and who's splitting it?` };
    if (!bill.requests.length) return { reply: `$${amount} across ${bill.people.length} people. Say “split it”.` };
    return { reply: 'Bill already sent — say “reset” to start a fresh one.' };
  }

  // split command
  if (/(split|send|go|fire|do it)/.test(lowNoEmails)) {
    if (!bill.items.length) return { reply: 'I need the damage first — paste receipt lines or give me a total.' };
    if (!bill.people.length) return { reply: 'And the crew? Drop their emails.' };
    const snap = await doSplit();
    return { reply: `Requests away — $${snap.total} split ${snap.requests.length} ways 💸`, bill: snap };
  }

  return { reply: 'Didn\'t quite catch that 🤔 — try “Split $64 between ana@x.com and ben@x.com”, or “help”.' };
}

// ---------- routes ----------
app.get('/api/status', (req, res) => {
  res.json({ mode: LIVE ? 'live-sandbox' : 'mock', currency: 'USD' });
});

app.post('/api/parse-receipt', (req, res) => {
  res.json({ items: parseReceiptLines(req.body.text) });
});

app.post('/api/split', async (req, res) => {
  try {
    const { items = [], people = [], memo } = req.body;
    if (!items.length || !people.length) {
      return res.status(400).json({ error: 'Need at least one item and one person.' });
    }
    const { total, shares } = splitEven(items, people);
    const requests = [];
    for (const s of shares) {
      const r = await requestMoney({ email: s.email, amount: s.amount, memo: memo || MEMO });
      requests.push({ ...s, ...r });
    }
    res.json({ total, currency: 'USD', mode: LIVE ? 'live-sandbox' : 'mock', requests });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/agent', async (req, res) => {
  try {
    res.json(await handleAgent(req.body.message));
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (/paypal|permission|invoice/i.test(msg)) return res.json({ reply: '⚠️ ' + msg });
    res.json({ reply: 'Brain fart on my end — say that once more? 🙃' });
  }
});

app.post('/api/demo-reset', (req, res) => {
  bill.items = []; bill.people = []; bill.requests = [];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => console.log(`SplitSnap on 127.0.0.1:${PORT} [${LIVE ? 'LIVE sandbox' : 'MOCK'}]`));

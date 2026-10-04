# SplitSnap — your money agent

Snap a receipt, split it with AI, collect via PayPal. Built for the
**PayPal AI Hackathon 2026**.

Talk to Snap in plain chat:

- `Split $64 between ana@x.com and ben@x.com`
- paste receipt lines like `Margherita pizza 18.50`
- `ana had the pizza` for uneven splits
- `add $8 tip`
- `Remind ben` when someone ghosts (PayPal emails them too)
- `Who hasn't paid?` — checks PayPal live and spots new payments

Plus: 🎤 voice input, 📷 receipt camera scan, 🔊 spoken replies.

## Run it

```sh
npm install
# mock mode (no keys): full flow with simulated invoices
node server.js
# live PayPal sandbox:
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node server.js
```

Needs a PayPal REST app with the **Invoicing** feature enabled.
Copy `.env.example` to `.env` if you prefer env files — never commit real keys.

## Stack

Node + Express, PayPal Invoicing API via `@paypal/agent-toolkit`,
on-device receipt OCR (Tesseract.js), Web Speech API for voice.

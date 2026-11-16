# einvoice-kit

[![CI](https://github.com/daen8584-spec/einvoice-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/daen8584-spec/einvoice-kit/actions/workflows/ci.yml)

Turns Shopify orders into invoices that meet Spanish rules, including Verifactu, and comes with a free invoice checker.

**Try the checker:** [daen8584-spec.github.io/einvoice-kit](https://daen8584-spec.github.io/einvoice-kit/)

Shopify doesn't issue invoices that are valid in Spain on its own, and from 2027 (the date has moved more than once) every invoice there also has to carry a Verifactu fingerprint and QR code. This is the core of a Shopify app that does that automatically. It's built so other countries can be added as separate modules.

## What's in it

- **Invoices from Shopify orders.** Discounts, shipping, several VAT rates, and the customer's tax ID from a checkout field. The total always matches what the customer paid, to the cent.
- **Credit notes from refunds,** pointing at the original invoice and refunding items at the price actually paid after discounts.
- **Invoice numbers with no gaps,** one number per order even when Shopify sends the same webhook twice.
- **Spanish tax ID validation** for DNI, NIE and company NIFs.
- **Verifactu:** invoice type (F1, F2, R1, R5), the chained SHA-256 fingerprint, and the AEAT verification link for the QR code.
- **Plain-language checks** in Spanish and English: missing details, the €400 and €3,000 limits for simplified invoices, VAT-free lines without a reason, credit notes without a reference.
- **A PDF invoice** with the QR code, in Spanish or English.

## How I know the Verifactu part is right

The fingerprint is tested against the three worked examples in AEAT's technical specification: a first invoice, a second one chained to it, and a cancellation. All three hashes match exactly. That test also caught a real bug early on: the hash depended on the order the fields happened to be written in, so the field order is now fixed in code.

## How I know the money is right

Tax mistakes cost real money, so on top of the unit tests there's a simulated store ([`test/sim`](test/sim)). It creates random orders the way Shopify does: several VAT rates, prices with and without VAT, discount codes, free gifts, free shipping, partial and repeated refunds, mistyped tax IDs, orders around midnight, daylight saving changes and New Year. Every notification is sent one to three times, late and out of order, many at the same moment.

The store works out what each customer paid and what each refund should give back with its own arithmetic (big integers, its own time zone rules, its own copy of the AEAT hash rule), then audits every document the app issued:

- the invoice equals what the customer paid, to the cent, VAT included
- partial refunds add up to exactly what was paid, and never more
- one document per order or refund, however many times Shopify sends it
- invoice numbers run 1, 2, 3... with no gaps, and dates never go backwards
- dates follow Spanish time, and the sale date is kept when it differs
- every Verifactu record follows the AEAT rule and points at the one before; editing, removing or swapping any record is caught at that exact record
- anything that fails a check (a mistyped tax ID, a simplified invoice over €3,000) is held, never issued, and goes out once the order is fixed in Shopify

The current version has been through 450,000 simulated orders and about 8.8 million checks with no failures. The simulation found five real problems along the way, all fixed: refunds in parts could be a cent short, stores with prices before VAT could be a cent off, an empty credit note used up a number, invoices with errors were still issued, and a valid partial refund was held by an over-strict VAT check.

### Tested on a real Shopify store

A simulation can only be as right as its idea of how Shopify behaves, so the code is also checked against real orders and refunds from a Shopify development store ([`test/live.test.ts`](test/live.test.ts)): Spanish VAT at 21%, prices including VAT, line and order discounts stacked on the same item, an order over €3,000 without a tax ID, and one item refunded one unit at a time.

Every invoice matched Shopify's total and VAT to the cent, and the €3,799.80 order was held. The refunds found something the simulation couldn't: when a refund lands on half a cent, Shopify rounds the first refund down, and my own split rounded it up, so one credit note came out a cent higher than what the customer got back. Credit notes now use the exact amount and VAT Shopify reports for each refunded item, and the test checks every one against Shopify's figures.

To make sure the simulation isn't just passing, [`scripts/mutations.py`](scripts/mutations.py) breaks the app on purpose in twelve different ways (wrong rounding, UTC dates, wrong hash order, duplicate handling removed...) and checks the simulation or the real-store test catches each one. They catch all twelve. CI runs both on every change.

```bash
npm run simulate -- 100000      # 100,000 orders, about 3 minutes (add --sqlite to use the database)
npm run mutations               # the twelve deliberate bugs
```

No amount of testing makes software perfect. What this gives is a lot of evidence, a clear list of what's checked, and a design that stops rather than issues anything it isn't sure about.

## Decisions worth knowing about

- **Money is whole cents and rates are basis points.** No floating point touches an amount.
- **Tax is worked out per rate, not per line.** With prices that include VAT, the tax is taken out of each rate's total, so the invoice never disagrees with what was charged. A test checks this on 500 random invoices.
- **Invoice dates use Spanish time.** An order at 00:30 in Madrid is dated that day, not the day before in UTC. The Canary Islands are an hour behind, and that's covered too.
- **Invoices are dated when they're issued,** with the sale date kept separately. Shopify can deliver a later order first, and Spanish numbering has to follow the dates.
- **Anything with an error is held, not issued.** No number is used and nothing reaches Verifactu until it's fixed.
- **Shopify's numbers win.** Invoices use the VAT Shopify charged on each line, and credit notes use the amount and VAT Shopify refunded. My own calculations are only a fallback.
- **Shipping refunds are flagged, not guessed.** Shopify reports them as order adjustments. Until I've checked their exact format on a live store, the credit note gets a warning asking the owner to look at it.

## Running it

Requires Node 20 or later.

```bash
npm install
npm test          # 83 tests, including the store simulation, real Shopify orders and the app end to end
npm run dev       # the checker at http://localhost:5173
```

To try it on an Android phone, there's a [Termux script](scripts/try-on-termux.sh).

## The Shopify app

[`server/`](server) is the app itself: a small Fastify server with a SQLite database.

- **Webhooks are saved before they're processed.** Shopify waits five seconds for an answer, so each delivery is checked against its HMAC signature, saved, answered, and processed afterwards. A restart loses nothing, the delivery ID makes repeats harmless, and anything that fails is retried with growing delays.
- **The order always comes from the API.** A webhook only says which order changed; the app then reads the order through Admin GraphQL, the same path the real-store test uses.
- **Each invoice is one database transaction.** Its number, its Verifactu record and its contents are saved together or not at all, and the store refuses a number out of order or a broken chain link.
- **Authentication without redirects.** The admin page sends App Bridge ID tokens; the server checks them and swaps them for expiring offline tokens, which it keeps encrypted and refreshes before they lapse.
- **The admin page** shows issued invoices with their PDFs, anything on hold and why, and the shop's invoicing details. Orders that arrive before those details are entered are held and go out as soon as they're saved.

[`test/server.test.ts`](test/server.test.ts) runs the whole app against a stand-in for Shopify that serves the real test-store orders: forged and repeated webhooks, bad ID tokens, token refresh, Shopify being down, uninstalling, and every invoice and credit note checked against Shopify's figures.

```bash
npm run build:server
SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32) npm start
```

### Running it from a phone

No server needed for testing: [`scripts/run-on-phone.sh`](scripts/run-on-phone.sh) runs the app on an Android phone with Termux. A free Cloudflare quick tunnel gives the phone a public address, and Shopify CLI points the app and its webhooks at that address each time it starts. The first run also connects the app to a Shopify account. The app only works while the script is running; Shopify retries anything it couldn't deliver in the meantime.

## Status

Done and tested: the invoicing core, the free checker, and the app server with its admin page.

Still to do before the App Store:

- Hosting for real stores (testing runs from a phone, see above)
- Sending records to the AEAT. Until then the PDF has no Verifactu QR code, since the QR tells customers the invoice can be checked with the tax office
- Approval from Shopify to read customer names and addresses (protected customer data)
- Deciding, with legal advice, how long to keep invoices after a shop uninstalls: Spanish law requires keeping them for years, while Shopify asks apps to delete shop data
- Moving the admin page to Polaris web components
- Testing an order with shipping on a real store

This isn't tax advice. Check the current rules with the AEAT or an adviser.

## License

MIT

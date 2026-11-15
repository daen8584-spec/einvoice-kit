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

## Decisions worth knowing about

- **Money is whole cents and rates are basis points.** No floating point touches an amount.
- **Tax is worked out per rate, not per line.** With prices that include VAT, the tax is taken out of each rate's total, so the invoice never disagrees with what was charged. A test checks this on 500 random invoices.
- **Invoice dates use Spanish time.** An order at 00:30 in Madrid is dated that day, not the day before in UTC. The Canary Islands are an hour behind, and that's covered too.
- **Shipping refunds are flagged, not guessed.** Shopify reports them as order adjustments. Until I've checked their exact format on a live store, the credit note gets a warning asking the owner to look at it.

## Running it

Requires Node 20 or later.

```bash
npm install
npm test          # 45 tests
npm run dev       # the checker at http://localhost:5173
```

To try it on an Android phone, there's a [Termux script](scripts/try-on-termux.sh).

## Status

The core and the checker are done and tested. Next: the Shopify app itself (installing it on a store and receiving orders), then sending records to the AEAT's test environment, which needs a Spanish digital certificate.

This isn't tax advice. Check the current rules with the AEAT or an adviser.

## License

MIT

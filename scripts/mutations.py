"""
Breaks the app on purpose, one way at a time, and checks the simulation notices.
A simulation that still passes with a bug in place would be giving false comfort.
Each bug is run against the simulated store, then the real Shopify test-store data,
the database tests and the app's notification tests.

Run:  python3 scripts/mutations.py
"""
import pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MUTATIONS = [
    ("Round tax per rate instead of using the tax Shopify charged",
     "src/invoice.ts", "if (allCharged) return", "if (false) return"),
    ("Split refunds with plain rounding instead of a running total",
     "src/shopify/to-invoice.ts",
     "return Math.round((total * (from + count)) / quantity) - Math.round((total * from) / quantity);",
     "return Math.round((total * count) / quantity);"),
    ("Forget that a notification was already handled",
     "src/app.ts", "const again = this.store.document(key) ?? this.store.skippedRefund(key);", "const again = undefined;"),
    ("Share the result of an order already being handled, dropping a later correction",
     "src/app.ts",
     "    const job = this.queue.then(async () => {\n      const again = this.store.document(key) ?? this.store.skippedRefund(key);\n      if (again) return again;\n      const outcome = await make(key);\n      if (\"skipped\" in outcome) this.store.saveSkipped(outcome);\n      else if (\"held\" in outcome) this.store.saveHeld(outcome);\n      return outcome;\n    });\n    this.queue = job.catch(() => undefined);\n    return job;",
     "    const shared: Map<string, Promise<Outcome>> = ((this as any).shared ??= new Map());\n    const running = shared.get(key);\n    if (running) return running;\n    const job = this.queue.then(async () => {\n      const again = this.store.document(key) ?? this.store.skippedRefund(key);\n      if (again) return again;\n      const outcome = await make(key);\n      if (\"skipped\" in outcome) this.store.saveSkipped(outcome);\n      else if (\"held\" in outcome) this.store.saveHeld(outcome);\n      return outcome;\n    });\n    this.queue = job.catch(() => undefined);\n    shared.set(key, job);\n    void job.finally(() => shared.delete(key)).catch(() => undefined);\n    return job;"),
    ("Date invoices in UTC instead of Spanish time",
     "src/shopify/to-invoice.ts", 'new Intl.DateTimeFormat("en-GB", { timeZone, year', 'new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", year'),
    ("Handle notifications at the same time instead of one by one",
     "src/app.ts", "const job = this.queue.then(async () => {", "const job = Promise.resolve().then(async () => {"),
    ("Hash the Verifactu fields in the wrong order",
     "src/es/verifactu.ts", '"CuotaTotal", "ImporteTotal",', '"ImporteTotal", "CuotaTotal",'),
    ("Ignore discounts on refunded items",
     "src/shopify/to-invoice.ts", "const paid = full.unitPrice * item.quantity - (full.discount ?? 0);", "const paid = full.unitPrice * item.quantity;"),
    ("Issue credit notes for refunds with nothing left to credit",
     "src/app.ts", "if (draft.invoice.lines.length === 0)", "if (false)"),
    ("Issue invoices even when a check finds an error",
     "src/app.ts", 'const errorsIn = (issues: Issue[]) => issues.filter((i) => i.level === "error");', "const errorsIn = (_issues: Issue[]): Issue[] => [];"),
    ("Ignore the refund amounts Shopify reports and split them ourselves",
     "src/shopify/to-invoice.ts", "const exact = r.subtotal !== undefined", "const exact = false && r.subtotal !== undefined"),
    ("Never release the refunds that waited for a held invoice when it's fixed",
     "src/app.ts", 'if (!("held" in outcome)) await this.releaseWaitingRefunds(order.id, outcome);', ''),
    ("Keep half of an invoice in the database when issuing fails halfway",
     "src/sqlite-store.ts", 'this.db.exec("rollback");\n      throw error;\n    }\n  }\n\n  saveSkipped', 'this.db.exec("commit");\n      throw error;\n    }\n  }\n\n  saveSkipped'),
]

missed = 0
for name, file, old, new in MUTATIONS:
    path = ROOT / file
    original = path.read_text(encoding="utf8")
    if original.count(old) != 1:
        print(f"SETUP ERROR  {name}: text not found once in {file}")
        missed += 1
        continue
    path.write_text(original.replace(old, new), encoding="utf8")
    try:
        # The simulated store, then the real orders and refunds from the Shopify test store.
        r = subprocess.run(["npx", "vite-node", "scripts/simulate.ts", "3000", "2026"], cwd=ROOT, capture_output=True, text=True, timeout=600)
        if r.returncode == 0:
            live = subprocess.run(["npx", "vitest", "run", "test/live.test.ts", "test/store.test.ts", "test/app.test.ts"], cwd=ROOT, capture_output=True, text=True, timeout=900)
            if live.returncode != 0:
                failed = [l.strip() for l in live.stdout.splitlines() if "×" in l or "FAIL" in l]
                r = subprocess.CompletedProcess(r.args, 1, stdout="1 FAILED:\n- tests: " + (failed[0] if failed else "live test failed"), stderr="")
    finally:
        path.write_text(original, encoding="utf8")
    if r.returncode == 0:
        print(f"MISSED       {name}")
        missed += 1
    else:
        first = next((l.strip() for l in r.stdout.splitlines() if l.strip().startswith("- ")), r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "")
        count = next((l.split()[0] for l in r.stdout.splitlines() if l.endswith("FAILED:")), "?")
        print(f"CAUGHT       {name}  ({count} failures, e.g. {first[:110]})")

print(f"\n{len(MUTATIONS) - missed} of {len(MUTATIONS)} deliberate bugs caught")
sys.exit(1 if missed else 0)

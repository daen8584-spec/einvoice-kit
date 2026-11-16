/**
 * Long simulation run:  npm run simulate -- 100000 [seed] [--sqlite]
 * Prints what was tested and every rule that broke. With --sqlite, every
 * document goes through the SQLite database the app uses.
 */
import { openDatabase, SqliteStore } from "../src/sqlite-store.js";
import { runSimulation } from "../test/sim/run.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const sqlite = process.argv.includes("--sqlite");
const orders = Number(args[0] ?? 20000);
const seed = Number(args[1] ?? Date.now() % 100000);
const r = await runSimulation(orders, seed, sqlite ? new SqliteStore(openDatabase(":memory:"), "sim.myshopify.com") : undefined);
if (sqlite) console.log("Storage: SQLite");
console.log(`Seed ${seed}: ${r.orders} orders, ${r.refunds} refunds, ${r.deliveries} notifications (duplicates included)`);
console.log(`Issued ${r.documents} invoices and credit notes, with ${r.records} Verifactu records, in ${r.seconds.toFixed(1)} s`);
console.log(`Ran ${r.checks} checks`);
for (const [k, v] of Object.entries(r.facts).sort()) console.log(`  ${k}: ${v}`);
if (r.failures.length) {
  console.log(`\n${r.failures.length} FAILED:`);
  for (const f of r.failures.filter(Boolean)) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nEverything matched.");

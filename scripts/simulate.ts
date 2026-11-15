/**
 * Long simulation run:  npm run simulate -- 100000 [seed]
 * Prints what was tested and every rule that broke.
 */
import { runSimulation } from "../test/sim/run.js";

const orders = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? Date.now() % 100000);
const r = await runSimulation(orders, seed);
console.log(`Seed ${seed}: ${r.orders} orders, ${r.refunds} refunds, ${r.deliveries} notifications (duplicates included)`);
console.log(`Issued ${r.documents} documents and ${r.records} Verifactu records in ${r.seconds.toFixed(1)} s`);
console.log(`Ran ${r.checks} checks`);
for (const [k, v] of Object.entries(r.facts).sort()) console.log(`  ${k}: ${v}`);
if (r.failures.length) {
  console.log(`\n${r.failures.length} FAILED:`);
  for (const f of r.failures.filter(Boolean)) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nEverything matched.");

/**
 * The page store owners see inside the Shopify admin. Plain HTML so it can be
 * tested anywhere; App Bridge signs every fetch to the app's API with an ID token.
 */
export function renderAppPage(apiKey: string): string {
  const key = apiKey.replace(/[^a-zA-Z0-9_-]/g, "");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${key}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Facturas</title>
<style>
:root { --bg:#f1f1f1; --card:#fff; --fg:#303030; --muted:#616161; --line:#e3e3e3; --accent:#303030; --ok:#0c5132; --okbg:#cdfee1; --warn:#5e4200; --warnbg:#ffef9d; --err:#8e0b21; --errbg:#fedad9; color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 20px 16px 48px; display:flex; flex-direction:column; gap:16px; }
header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
h1 { font-size:20px; margin:0; } h2 { font-size:14px; margin:0 0 10px; }
.card { background:var(--card); border-radius:12px; padding:16px; box-shadow: 0 1px 0 rgba(26,26,26,.07), 0 0 0 1px rgba(26,26,26,.06); }
.banner { border-radius:10px; padding:10px 12px; }
.banner.ok { background:var(--okbg); color:var(--ok); } .banner.warn { background:var(--warnbg); color:var(--warn); } .banner.err { background:var(--errbg); color:var(--err); }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:10px 14px; }
label { display:flex; flex-direction:column; gap:4px; font-weight:500; }
label span.hint { font-weight:400; color:var(--muted); }
input, select { font:inherit; padding:7px 10px; border:1px solid #8a8a8a; border-radius:8px; background:#fdfdfd; color:var(--fg); }
input[aria-invalid="true"] { border-color: var(--err); }
button { font:inherit; font-weight:600; border-radius:8px; padding:7px 12px; border:0; cursor:pointer; background:var(--accent); color:#fff; }
button.plain { background:transparent; color:var(--fg); border:1px solid var(--line); font-weight:500; }
button:focus-visible, input:focus-visible { outline:2px solid #005bd3; outline-offset:1px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px,1fr)); gap:10px; }
.stat b { display:block; font-size:20px; }
.muted { color:var(--muted); }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-variant-numeric: tabular-nums; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:500; } td.num { text-align:right; }
ul.issues { margin:6px 0 0; padding-left:18px; }
.held { padding:10px 0; border-bottom:1px solid var(--line); } .held:last-child { border-bottom:0; }
[hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <header>
    <h1 data-t="title">Facturas</h1>
    <div class="row">
      <select id="lang" aria-label="Idioma / Language"><option value="es">Español</option><option value="en">English</option></select>
    </div>
  </header>
  <div id="status" class="banner warn" data-t="loading">Cargando…</div>
  <div id="access" class="banner err" hidden></div>
  <div id="copy-error" class="banner warn" hidden></div>

  <section class="card stats" aria-label="Resumen">
    <div class="stat"><span class="muted" data-t="issued">Emitidas</span><b id="n-issued">–</b></div>
    <div class="stat"><span class="muted" data-t="heldCount">Retenidas</span><b id="n-held">–</b></div>
    <div class="stat"><span class="muted" data-t="chain">Cadena Verifactu</span><b id="chain">–</b></div>
    <div class="stat"><span class="muted" data-t="copiesStat">Copias en tus pedidos</span><b id="copies">–</b></div>
    <div class="stat"><button class="plain" id="retry-all" data-t="retryAll">Reintentar ahora</button></div>
  </section>

  <section class="card" id="held-card" hidden>
    <div class="row" style="justify-content:space-between"><h2 data-t="heldTitle">Retenidas: necesitan un cambio</h2><button class="plain" id="retry" data-t="retry">Reintentar</button></div>
    <p class="muted" data-t="heldHelp">No se ha emitido nada para estos pedidos. Corrígelos en Shopify o completa tus datos y se emitirán solos.</p>
    <div id="held"></div>
  </section>

  <section class="card">
    <h2 data-t="settingsTitle">Tus datos de facturación</h2>
    <form id="settings" class="grid" novalidate>
      <label><span data-t="name">Razón social o nombre</span><input id="f-name" name="name" required autocomplete="organization"></label>
      <label><span>NIF</span><input id="f-taxId" name="taxId" required spellcheck="false"></label>
      <label><span data-t="line1">Dirección</span><input id="f-line1" name="line1" autocomplete="address-line1"></label>
      <label><span data-t="city">Ciudad</span><input id="f-city" name="city"></label>
      <label><span data-t="postalCode">Código postal</span><input id="f-postalCode" name="postalCode" inputmode="numeric"></label>
      <label><span data-t="timeZone">Zona horaria</span><select id="f-timeZone" name="timeZone"><option value="Europe/Madrid">Península y Baleares</option><option value="Atlantic/Canary">Canarias</option></select></label>
      <label style="grid-column:1/-1"><span data-t="exemption">Motivo para productos sin IVA</span><input id="f-exemptionText" name="exemptionText"><span class="hint" data-t="exemptionHint">Solo si vendes algo exento, por ejemplo «Exento, art. 20 LIVA».</span></label>
      <label id="terms-row" class="check" style="grid-column:1/-1; flex-direction:row; align-items:flex-start; gap:8px" hidden>
        <input type="checkbox" id="f-acceptTerms" style="margin-top:4px">
        <span id="terms-text">Acepto los términos de uso y el acuerdo de encargo del tratamiento.</span>
      </label>
      <div class="row" style="grid-column:1/-1"><button type="submit" data-t="save">Guardar</button><span id="saved" class="muted" role="status"></span></div>
    </form>
  </section>

  <section class="card">
    <div class="row" style="justify-content:space-between"><h2 data-t="docsTitle">Facturas emitidas</h2><button class="plain" id="export" data-t="export">Descargar todo (ZIP)</button></div>
    <p class="muted" data-t="keepCopies">Cada factura se copia en su pedido de Shopify (campo «Facturas (einvoice-kit)»), que es tuyo y se queda aunque desinstales la app. Aun así, descarga copias de vez en cuando: la ley te obliga a conservarlas.</p>
    <p id="empty" class="muted" data-t="empty" hidden>Todavía no hay facturas. Aparecerán aquí cuando se pague un pedido.</p>
    <div class="tablewrap"><table id="docs" hidden>
      <thead><tr><th data-t="number">Número</th><th data-t="date">Fecha</th><th data-t="order">Pedido</th><th data-t="customer">Cliente</th><th class="num" data-t="total">Total</th><th></th></tr></thead>
      <tbody></tbody>
    </table></div>
  </section>
  <footer class="muted" id="legal" style="font-size:12px"></footer>
</main>
<script>
const T = {
  es: { title:"Facturas", loading:"Cargando…", issued:"Emitidas", heldCount:"Retenidas", chain:"Cadena Verifactu", heldTitle:"Retenidas: necesitan un cambio", retry:"Reintentar",
    heldHelp:"No se ha emitido nada para estos pedidos. Corrígelos en Shopify o completa tus datos y se emitirán solos.", settingsTitle:"Tus datos de facturación", name:"Razón social o nombre",
    line1:"Dirección", city:"Ciudad", postalCode:"Código postal", timeZone:"Zona horaria", exemption:"Motivo para productos sin IVA", exemptionHint:"Solo si vendes algo exento, por ejemplo «Exento, art. 20 LIVA».",
    save:"Guardar", docsTitle:"Facturas emitidas", empty:"Todavía no hay facturas. Aparecerán aquí cuando se pague un pedido.", number:"Número", date:"Fecha", order:"Pedido", customer:"Cliente", total:"Total",
    pdf:"PDF", ok:"Correcta", broken:"Revisar", needSettings:"Completa tus datos de facturación para empezar a emitir facturas.", allGood:"Todo en orden. Las facturas se emiten solas al pagarse cada pedido.",
    someHeld:"Hay pedidos retenidos que necesitan un cambio.", failed:"Algunos avisos de Shopify no se han podido procesar. Lo reintentamos automáticamente.", saved:"Guardado", badTaxId:"Este NIF no es válido.", required:"Obligatorio.",
    error:"No se ha podido cargar. Vuelve a intentarlo.", credit:"Rectificativa",
    access:"Shopify no deja a la app leer estos datos del cliente: {f}. En el Partner Dashboard, abre la app → Solicitudes de acceso a la API → Datos de clientes protegidos, marca esos campos con un motivo, guarda y pulsa Reintentar.",
    retryAll:"Reintentar ahora", retrying:"Reintentando…", export:"Descargar todo (ZIP)", exporting:"Preparando…",
    copiesStat:"Copias en tus pedidos", copyError:"Todavía no se han podido guardar algunas copias en tus pedidos de Shopify. Se reintenta solo; si sigue, pulsa Reintentar ahora. Motivo: {e}",
    terms:"Acepto los {t} y el {d}.", termsLink:"términos de uso", dpaLink:"acuerdo de encargo del tratamiento", needTerms:"Para empezar, acepta los términos.", privacy:"Política de privacidad", termsFooter:"Términos de uso",
    keepCopies:"Cada factura se copia en su pedido de Shopify (campo «Facturas (einvoice-kit)»), que es tuyo y se queda aunque desinstales la app. Aun así, descarga copias de vez en cuando: la ley te obliga a conservarlas.", blocked:"Hay pedidos que todavía no se han podido facturar. Mira el aviso de abajo.", pending:"Procesando pedidos recientes…", fields:{ name:"nombre", address1:"dirección", zip:"código postal", city:"ciudad", company:"empresa", firstName:"nombre", lastName:"apellidos", phone:"teléfono", email:"correo" } },
  en: { title:"Invoices", loading:"Loading…", issued:"Issued", heldCount:"On hold", chain:"Verifactu chain", heldTitle:"On hold: need a change", retry:"Try again",
    heldHelp:"Nothing has been issued for these orders. Fix them in Shopify or complete your details, and they'll go out on their own.", settingsTitle:"Your invoicing details", name:"Company or full name",
    line1:"Address", city:"City", postalCode:"Postal code", timeZone:"Time zone", exemption:"Reason for products without VAT", exemptionHint:"Only if you sell something exempt, for example \\"Exento, art. 20 LIVA\\".",
    save:"Save", docsTitle:"Issued invoices", empty:"No invoices yet. They'll appear here when an order is paid.", number:"Number", date:"Date", order:"Order", customer:"Customer", total:"Total",
    pdf:"PDF", ok:"Intact", broken:"Check", needSettings:"Complete your invoicing details to start issuing invoices.", allGood:"All in order. Invoices go out on their own when each order is paid.",
    someHeld:"Some orders are on hold and need a change.", failed:"Some Shopify notifications couldn't be processed yet. They're retried automatically.", saved:"Saved", badTaxId:"This tax ID isn't valid.", required:"Required.",
    error:"Couldn't load. Try again.", credit:"Credit note",
    access:"Shopify isn't letting the app read these customer details: {f}. In the Partner Dashboard, open the app → API access requests → Protected customer data, tick those fields with a reason, save, and press Try again.",
    retryAll:"Try again now", retrying:"Trying again…", export:"Download everything (ZIP)", exporting:"Preparing…",
    copiesStat:"Copies in your orders", copyError:"Some copies couldn't be saved to your Shopify orders yet. It's retried automatically; if it persists, press Try again now. Reason: {e}",
    terms:"I accept the {t} and the {d}.", termsLink:"terms of use", dpaLink:"data processing agreement", needTerms:"To start, accept the terms.", privacy:"Privacy policy", termsFooter:"Terms of use",
    keepCopies:"Each invoice is copied into its Shopify order (the \"Facturas (einvoice-kit)\" field), which is yours and stays even if you uninstall the app. Still, download copies now and then: the law requires you to keep them.", blocked:"Some orders couldn't be invoiced yet. See the notice below.", pending:"Processing recent orders…", fields:{ name:"name", address1:"address", zip:"postal code", city:"city", company:"company", firstName:"first name", lastName:"last name", phone:"phone", email:"email" } },
};
let lang = "es";
try { if (localStorage.getItem("lang") === "en") lang = "en"; } catch {}
const $ = (id) => document.getElementById(id);
const t = (k) => T[lang][k] ?? k;
const fields = ["name","taxId","line1","city","postalCode","timeZone","exemptionText"];
let data = null;

function money(cents, currency) {
  return new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB", { style:"currency", currency: currency || "EUR" }).format(cents / 100);
}
function applyLang() {
  document.documentElement.lang = lang; $("lang").value = lang;
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  if (data) render();
}
function render() {
  const d = data;
  $("n-issued").textContent = d.issued;
  $("n-held").textContent = d.held.length;
  $("chain").textContent = d.chain.ok ? t("ok") : t("broken");
  const s = $("status");
  if (!d.settings) { s.className = "banner warn"; s.textContent = t("needSettings"); }
  else if (!d.chain.ok) { s.className = "banner err"; s.textContent = t("broken"); }
  else if ((d.missingAccess || []).length) { s.className = "banner err"; s.textContent = t("blocked"); }
  else if (d.held.length) { s.className = "banner warn"; s.textContent = t("someHeld"); }
  else if (d.failedEvents) { s.className = "banner warn"; s.textContent = t("failed"); }
  else if (d.pendingEvents) { s.className = "banner warn"; s.textContent = t("pending"); }
  else { s.className = "banner ok"; s.textContent = t("allGood"); }

  const c = d.copies || { saved: 0, total: 0, error: null };
  $("copies").textContent = c.saved + " / " + c.total;
  $("copy-error").hidden = !c.error || c.saved === c.total;
  if (c.error) $("copy-error").textContent = t("copyError").replace("{e}", c.error.startsWith("access:") ? "permiso de Shopify" : c.error);
  const missing = d.missingAccess || [];
  $("access").hidden = missing.length === 0;
  if (missing.length) $("access").textContent = t("access").replace("{f}", missing.map((f) => T[lang].fields[f] || f).join(", "));
  $("held-card").hidden = d.held.length === 0;
  const base = d.terms.url, es = lang === "es";
  const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text; return a; };
  $("terms-row").hidden = d.terms.accepted;
  const parts = t("terms").split(/(\{t\}|\{d\})/);
  $("terms-text").replaceChildren(...parts.map((p) => p === "{t}" ? link(base + (es ? "terminos.html" : "terms.html"), t("termsLink")) : p === "{d}" ? link(base + (es ? "terminos.html#encargo" : "terms.html#dpa"), t("dpaLink")) : document.createTextNode(p)));
  $("legal").replaceChildren(link(base + (es ? "privacidad.html" : "privacy.html"), t("privacy")), document.createTextNode(" · "), link(base + (es ? "terminos.html" : "terms.html"), t("termsFooter")));
  $("held").replaceChildren(...d.held.map((h) => {
    const div = document.createElement("div"); div.className = "held";
    const b = document.createElement("b"); b.textContent = h.reference || h.key;
    const ul = document.createElement("ul"); ul.className = "issues";
    for (const msg of h.issues) { const li = document.createElement("li"); li.textContent = msg; ul.append(li); }
    div.append(b, ul); return div;
  }));

  const tbody = $("docs").querySelector("tbody");
  $("docs").hidden = d.documents.length === 0; $("empty").hidden = d.documents.length > 0;
  tbody.replaceChildren(...d.documents.map((doc) => {
    const tr = document.createElement("tr");
    const cells = [doc.number + (doc.kind === "credit-note" ? " · " + t("credit") : ""), doc.issueDate.split("-").reverse().join("/"), doc.reference, doc.buyer || "—", money(doc.total, doc.currency)];
    cells.forEach((text, i) => { const td = document.createElement("td"); td.textContent = text; if (i === 4) td.className = "num"; tr.append(td); });
    const td = document.createElement("td"); const btn = document.createElement("button"); btn.className = "plain"; btn.textContent = t("pdf");
    btn.addEventListener("click", () => downloadPdf(doc)); td.append(btn); tr.append(td);
    return tr;
  }));
}
function fillSettings(s) {
  if (!s) return;
  const v = { name: s.seller.name, taxId: s.seller.taxId, line1: s.seller.address?.line1, city: s.seller.address?.city, postalCode: s.seller.address?.postalCode, timeZone: s.timeZone, exemptionText: s.exemptionText };
  for (const f of fields) if (v[f] !== undefined) $("f-" + f).value = v[f];
}
async function load() {
  try {
    const res = await fetch("/api/overview?lang=" + lang);
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
    if (!document.activeElement || document.activeElement.tagName !== "INPUT") fillSettings(data.settings);
    render();
  } catch { const s = $("status"); s.className = "banner err"; s.textContent = t("error"); }
}
async function downloadPdf(doc) {
  const res = await fetch("/api/documents/" + encodeURIComponent(doc.key) + "/pdf?lang=" + lang);
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: doc.number + ".pdf" });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  for (const f of fields) $("f-" + f).removeAttribute("aria-invalid");
  $("saved").textContent = "";
  const body = Object.fromEntries(fields.map((f) => [f, $("f-" + f).value]));
  body.acceptTerms = $("f-acceptTerms").checked;
  const res = await fetch("/api/settings", { method:"PUT", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
  if (res.status === 422) {
    const { errors } = await res.json();
    for (const f of Object.keys(errors)) $("f-" + f).setAttribute("aria-invalid", "true");
    $("saved").textContent = errors.taxId ? t("badTaxId") : errors.acceptTerms ? t("needTerms") : t("required");
    return;
  }
  if (res.ok) { $("saved").textContent = t("saved"); setTimeout(load, 1500); }
});
async function retryAll(btn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = t("retrying");
  try { await fetch("/api/retry", { method:"POST" }); } finally { btn.disabled = false; btn.textContent = label; load(); }
}
$("retry").addEventListener("click", (e) => retryAll(e.currentTarget));
$("export").addEventListener("click", async (e) => {
  const btn = e.currentTarget; btn.disabled = true; const label = btn.textContent; btn.textContent = t("exporting");
  try {
    const res = await fetch("/api/export");
    if (!res.ok) return;
    const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "facturas.zip";
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  } finally { btn.disabled = false; btn.textContent = label; }
});
$("retry-all").addEventListener("click", (e) => retryAll(e.currentTarget));
$("lang").addEventListener("change", () => { lang = $("lang").value; try { localStorage.setItem("lang", lang); } catch {} applyLang(); load(); });
applyLang();
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

// node tests/router.test.mjs /tmp/satodata/network.json
import fs from "node:fs";
import { prepare, search, fmtTime, fmtDur } from "../web/js/router.js";
import { estimate } from "../web/js/fares.js";
import { noSchoolReason } from "../web/js/calendar.js";

const net = prepare(JSON.parse(fs.readFileSync(process.argv[2] || "/tmp/satodata/network.json", "utf8")));
let fails = 0;
const ok = (c, m) => { console.log((c ? "OK  " : "FAIL") + " " + m); if (!c) fails++; };
const name = (s) => (typeof s === "number" ? net.stops[s][0] : s);
function show(res) {
  for (const j of res.journeys.slice(0, 3)) {
    console.log(`  ${fmtTime(j.leave)} → ${fmtTime(j.arrive)} (${fmtDur(j.duration)}), ${j.transfers} corresp.`);
    for (const l of j.legs) {
      if (l.kind === "walk") console.log(`     marche ${l.min} min ${l.m ?? "?"} m ${name(l.from)} → ${name(l.to)}`);
      else { const r = net.routes[l.route]; console.log(`     ${r.s} ${fmtTime(l.dep)} ${name(l.from)} → ${fmtTime(l.arr)} ${name(l.to)}${l.resa ? " [réservation]" : ""}`); }
    }
  }
}
const satolas = { lat: 45.6938, lon: 5.1307 };
const partDieu = { lat: 45.7606, lon: 4.8597 };
const grenoble = { lat: 45.1913, lon: 5.7146 };
const lundi = "2026-11-23";

let r = search(net, { o: satolas, d: partDieu, date: lundi, time: 6 * 60, arriveBy: false });
console.log("Satolas → Part-Dieu, lundi 6h00"); show(r);
ok(r.journeys.length > 0, "au moins une solution Satolas → Part-Dieu");
ok(r.journeys.every((j, i, a) => i === 0 || a[i - 1].arrive <= j.arrive), "tri par arrivée la plus tôt");
ok(r.journeys[0].legs.some((l) => l.kind === "ride" && l.resa), "le TAD Péri E est signalé « réservation »");

r = search(net, { o: satolas, d: grenoble, date: lundi, time: 9 * 60, arriveBy: true });
console.log("Satolas → Grenoble, arriver avant 9h00"); show(r);
ok(r.journeys.length > 0 && r.journeys.every((j) => j.arrive <= 540), "arrivée avant 9h00 respectée");

r = search(net, { o: { lat: 45.7180, lon: 5.1030 }, d: grenoble, date: lundi, time: 8 * 60 + 30, sort: "duration" });
console.log("Colombier → Grenoble, 8h30, tri durée"); show(r);
ok(r.journeys.every((j, i, a) => i === 0 || a[i - 1].duration <= j.duration), "tri par durée");

const dim = search(net, { o: satolas, d: partDieu, date: "2026-11-22", time: 7 * 60 });
ok(!dim.journeys.some((j) => j.legs.some((l) => l.kind === "ride" && net.routes[l.route].s === "PÉRI E")), "pas de TAD le dimanche");

const schoolIdx = net.routes.findIndex((x) => x.sc);
ok(schoolIdx >= 0, "ligne scolaire détectée (" + (net.routes[schoolIdx] || {}).s + ")");
ok(noSchoolReason("2026-12-21") !== null, "21/12/2026 : vacances de Noël zone A");
ok(noSchoolReason("2026-11-23") === null, "23/11/2026 : jour de classe");
ok(noSchoolReason("2027-05-07") !== null, "pont de l'Ascension 2027");

const j = search(net, { o: satolas, d: partDieu, date: lundi, time: 6 * 60 }).journeys[0];
const f = estimate(net, j, "adulte", lundi);
console.log("  coût adulte :", f.total, JSON.stringify(f.lines));
ok(f.occ > 0 && f.week >= f.occ && f.month >= f.week, "coûts occasionnel ≤ semaine ≤ mois");
console.log("  semaine", f.week, "mois", f.month, f.lines.map(l=>l.month.n).join(" | "));
ok(estimate(net, j, "bebe", lundi).total <= f.total, "tarif < 4 ans ≤ adulte");
process.exit(fails ? 1 : 0);

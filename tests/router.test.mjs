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
      if (l.kind !== "ride") console.log(`     ${l.kind === "car" ? "voiture" : "marche"} ${l.min} min ${l.m ?? "?"} m ${name(l.from)} → ${name(l.to)}`);
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
ok(r.journeys.some((j) => j.legs.some((l) => l.kind === "ride" && l.resa)), "le TAD Péri est signalé « réservation »");

r = search(net, { o: satolas, d: grenoble, date: lundi, time: 9 * 60, arriveBy: true });
console.log("Satolas → Grenoble, arriver avant 9h00"); show(r);
ok(r.journeys.length > 0 && r.journeys.every((j) => j.arrive <= 540), "arrivée avant 9h00 respectée");

r = search(net, { o: { lat: 45.7180, lon: 5.1030 }, d: grenoble, date: lundi, time: 8 * 60 + 30, sort: "duration" });
console.log("Colombier → Grenoble, 8h30, tri durée"); show(r);
ok(r.journeys.every((j, i, a) => i === 0 || a[i - 1].duration <= j.duration), "tri par durée");

const dim = search(net, { o: satolas, d: partDieu, date: "2026-11-22", time: 7 * 60 });
ok(!dim.journeys.some((j) => j.legs.some((l) => l.kind === "ride" && net.routes[l.route].tad)), "pas de TAD le dimanche");

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
// marche max 20 min par étape
const isolated = { lat: 45.665, lon: 5.20 }; // ~6 km de tout arrêt fictif
r = search(net, { o: isolated, d: partDieu, date: lundi, time: 6 * 60 });
ok(r.journeys.length === 0 && r.originStops === 0, "pas de solution à pied si le premier arrêt est à plus de 20 min");
const allWalk = (res, max) => res.journeys.every((j) => j.legs.every((l) => l.kind !== "walk" || l.min <= max));
r = search(net, { o: satolas, d: partDieu, date: lundi, time: 6 * 60, maxWalk: 20 });
ok(allWalk(r, 20), "aucune étape à pied > 20 min");
r = search(net, { o: satolas, d: partDieu, date: lundi, time: 6 * 60, maxWalk: 5 });
ok(allWalk(r, 5), "marche max 5 min respectée");
// voiture
r = search(net, { o: isolated, d: partDieu, date: lundi, time: 6 * 60, car: "start" });
console.log("Point isolé → Part-Dieu, voiture au départ"); show(r);
ok(r.journeys.some((j) => j.carOnly), "solution tout en voiture proposée");
ok(r.journeys.some((j) => !j.carOnly && j.legs[0].kind === "car" && j.legs.some((l) => l.kind === "ride")), "solution voiture + transports en commun");
const jc = r.journeys.find((j) => !j.carOnly);
const fc = estimate(net, jc, "adulte", lundi);
console.log("  coût voiture+TC :", fc.occ, fc.lines.map((l) => l.label).join(" | "));
ok(fc.lines.some((l) => l.label.startsWith("Voiture")), "coût voiture compté");
r = search(net, { o: satolas, d: partDieu, date: lundi, time: 6 * 60, car: "none" });
ok(!r.journeys.some((j) => j.legs.some((l) => l.kind === "car")), "sans voiture : aucune étape en voiture");
// correspondance métro D + métro A (Grange Blanche -> 10 cours de Verdun Rambaud)
const gb = { lat: 45.7428, lon: 4.8792 }, rambaud = { lat: 45.7496, lon: 4.8262 };
r = search(net, { o: gb, d: rambaud, date: lundi, time: 9 * 60, maxWalk: 20 });
console.log("Grange Blanche → cours de Verdun Rambaud"); show(r);
ok(r.journeys.length && r.journeys[0].legs.filter((l) => l.kind === "ride").map((l) => net.routes[l.route].s).join("+") === "D+A", "métro D puis métro A");
ok(allWalk(r, 20), "pas de longue marche dans Lyon");
process.exit(fails ? 1 : 0);

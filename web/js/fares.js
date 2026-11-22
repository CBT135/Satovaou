// Estimation du coût d'un trajet : occasionnel, semaine (5 allers-retours), mois (22 allers-retours).
// Tarifs relevés en novembre 2026 (TCL au 1er sept. 2026, Cars Région Isère grille 2025, Rhônexpress, Ruban).
// Les abonnements TER illico sont estimés à partir de leur seuil de rentabilité publié. Tout est indicatif.
import { distM } from "./router.js";

export const PROFILES = {
  adulte: { label: "Adulte (26–64 ans)", age: 30 },
  jeune: { label: "Jeune 18–25 ans", age: 20 },
  ado: { label: "Ado 11–17 ans", age: 15 },
  enfant: { label: "Enfant 4–10 ans", age: 8 },
  bebe: { label: "Moins de 4 ans", age: 2 },
  eleve: { label: "Élève avec abonnement scolaire", age: 14, scolaire: true },
};

export const TRIPS_WEEK = 10;   // 5 allers-retours
export const TRIPS_MONTH = 44;  // 22 jours ouvrés × aller-retour
export const CAR_EUR_KM = 0.15; // carburant + usure, estimation

const eur = (x) => Math.round(x * 100) / 100;

/** Prix par réseau : {occ: prix d'un trajet, week: {p, n}|null, month: {p, n}|null, note} */
function networkFare(key, legs, ctx) {
  const { age, dateIso } = ctx;
  const km = legs.reduce((s, l) => s + l.km, 0);
  switch (key) {
    case "tcl": {
      if (age < 4) return { occ: 0, week: { p: 0, n: "gratuit" }, month: { p: 0, n: "gratuit" }, note: "gratuit < 4 ans" };
      if (age <= 10) return { occ: 0, week: { p: 0, n: "abonnement gratuit 4–10 ans" }, month: { p: 0, n: "abonnement gratuit 4–10 ans" }, note: "gratuit 4–10 ans (carte TCL)" };
      // un ticket valable 1 h correspondances comprises
      let tickets = 0, last = -Infinity;
      for (const l of legs) if (l.dep - last > 60) { tickets++; last = l.dep; }
      const young = age <= 25;
      return {
        occ: 2.1 * tickets, note: `${tickets} ticket(s) 1 h zones 1+2`,
        week: { p: 23.8 * tickets, n: tickets > 1 ? `${tickets} Pass 7 jours` : "Pass 7 jours" }, carnet: (young ? 1.74 : 2.05) / 2.1,
        month: young ? { p: 26, n: "abonnement mensuel 11–25 ans" } : { p: 75.9, n: "abonnement mensuel 26–64 ans" },
      };
    }
    case "ruban": {
      let tickets = 0, last = -Infinity;
      for (const l of legs) if (l.dep - last > 60) { tickets++; last = l.dep; }
      return {
        occ: 1.3 * tickets, note: "ticket appli 1 h (1,50 € à bord)", carnet: 1.0 / 1.3,
        week: null, month: age < 26 ? { p: 11.5, n: "abonnement mensuel réduit (à vérifier)" } : { p: 30, n: "abonnement mensuel" },
      };
    }
    case "rhonexpress": {
      const occ = age < 12 ? 0 : age <= 25 ? 10.7 : 16.3;
      return { occ, note: age < 12 ? "gratuit < 12 ans" : age <= 25 ? "tarif 12–25 ans" : "achat web (17,40 € en borne)", week: null, month: null };
    }
    case "cars_region": {
      const zones = km <= 12 ? 1 : km <= 25 ? 2 : km <= 40 ? 3 : km <= 55 ? 4 : km <= 70 ? 5 : 6;
      if (age < 5) return { occ: 0, week: { p: 0, n: "gratuit" }, month: { p: 0, n: "gratuit" }, note: "gratuit < 5 ans accompagné" };
      const eco = age < 26;
      const occ = eco ? 3.2 + 1.2 * (zones - 1) : 4.1 + 1.6 * (zones - 1);
      // PASS mensuel ≈ 13,3 × ticket (ex. 2 zones : 75,70 € plein, 53 € Éco)
      return {
        occ, note: `${eco ? "tarif Éco < 26 ans, " : ""}~${zones} zone(s)`,
        week: null, month: { p: occ * 13.3, n: `PASS mensuel ${zones} zone(s) (estimation)` },
      };
    }
    case "sncf": {
      const tgv = legs.some((l) => l.tgv);
      if (age < 4) return { occ: 0, week: { p: 0, n: "gratuit" }, month: { p: 0, n: "gratuit" }, note: "gratuit sur les genoux" };
      if (tgv) {
        const p = Math.max(20, km * 0.2) * (age < 12 ? 0.5 : 1);
        return { occ: p, note: "TGV, prix variable (dès ~20 €)", week: null, month: null };
      }
      const sat = new Date(dateIso + "T12:00:00").getDay() === 6;
      let p = Math.max(1.8, km * 1.15 * 0.13);
      if (age < 12) p = sat ? 0 : p / 2;
      const young = age < 26;
      // illico HEBDO rentable dès 4 trajets, illico MENSUEL dès 5 allers-retours ; versions JEUNES ~ −25 %
      return {
        occ: p, note: age < 12 && sat ? "gratuit < 12 ans le samedi" : age < 12 ? "tarif enfant" : young ? "TER (−50 % avec illico LIBERTÉ JEUNES)" : "TER, estimation au km",
        week: { p: p * 4 * (young ? 0.75 : 1), n: young ? "illico HEBDO JEUNES (estimation)" : "illico HEBDO (estimation)" },
        month: { p: p * 10 * (young ? 0.75 : 1), n: young ? "illico MENSUEL JEUNES (estimation)" : "illico MENSUEL (estimation)" },
      };
    }
    case "autocar": {
      const p = Math.max(5, km * 0.13);
      return { occ: p, note: "prix variable selon la date de réservation", week: null, month: null };
    }
    default:
      return { occ: 0, note: "tarif inconnu", week: null, month: null };
  }
}

function best(occ, trips, pass, carnetFactor) {
  const unit = carnetFactor ? occ * carnetFactor : occ;
  const tickets = { p: unit * trips, n: `${trips} trajets ${carnetFactor ? "en carnet de 10" : "à l'unité"}` };
  if (occ === 0) return { p: 0, n: "gratuit" };
  if (pass && pass.p <= tickets.p) return pass;
  return tickets;
}

/** journey.legs -> {occ, week, month, lines:[{label, occ, week:{p,n}, month:{p,n}, note}]} */
export function estimate(net, journey, profileKey, dateIso) {
  const prof = PROFILES[profileKey] || PROFILES.adulte;
  const ctx = { age: prof.age, dateIso };
  const groups = new Map();
  const lines = [];
  let carKm = 0;
  for (const l of journey.legs) {
    if (l.kind === "car") { carKm += (l.m || 0) / 1000; continue; }
    if (l.kind !== "ride") continue;
    const r = net.routes[l.route], feed = net.feeds[r.f] || {};
    const a = net.stops[l.from], b = net.stops[l.to];
    const km = distM(a[1], a[2], b[1], b[2]) / 1000;
    if (r.sc && prof.scolaire) {
      lines.push({ label: `${feed.label} ${r.s || r.l}`, occ: 0, week: { p: 0, n: "abonnement scolaire" }, month: { p: 0, n: "abonnement scolaire" }, note: "abonnement scolaire" });
      continue;
    }
    const key = feed.fare || "autre";
    if (!groups.has(key)) groups.set(key, { label: feed.label, names: [], legs: [] });
    const g = groups.get(key);
    g.names.push(r.s || r.l);
    g.legs.push({ km, dep: l.dep, tgv: /tgv|ouigo|inoui|lyria/i.test(`${r.s} ${r.l} ${r.a}`) || r.t === 101 || r.t === 102 });
  }
  for (const [key, g] of groups) {
    const f = networkFare(key, g.legs, ctx);
    const week = best(f.occ, TRIPS_WEEK, f.week, f.carnet);
    const month = best(f.occ, TRIPS_MONTH, f.month, f.carnet);
    lines.push({ label: `${g.label} ${[...new Set(g.names)].join(", ")}`, occ: eur(f.occ), week: { p: eur(week.p), n: week.n }, month: { p: eur(month.p), n: month.n }, note: f.note });
  }
  if (carKm > 0) {
    const p = carKm * CAR_EUR_KM;
    lines.push({ label: `Voiture (${carKm.toFixed(1).replace(".", ",")} km)`, occ: eur(p),
      week: { p: eur(p * TRIPS_WEEK), n: `${TRIPS_WEEK} trajets` }, month: { p: eur(p * TRIPS_MONTH), n: `${TRIPS_MONTH} trajets` },
      note: "carburant + usure ~0,15 €/km, stationnement non compté (parcs relais TCL gratuits avec un titre TCL)" });
  }
  const sum = (k) => eur(lines.reduce((s, x) => s + (k === "occ" ? x.occ : x[k].p), 0));
  return { occ: sum("occ"), week: sum("week"), month: sum("month"), total: sum("occ"), lines, approx: true };
}

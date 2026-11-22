// Calendrier scolaire zone A (académies de Lyon et Grenoble) et jours fériés.
// Intervalles [début, reprise[ : le jour de reprise a classe.

// Liste intégrée (secours si les données générées n'en contiennent pas).
// Source : calendrier 2026-2027 fixé par l'arrêté du 22 octobre 2025.
export const ZONE_A_FALLBACK = [
  ["2026-07-04", "2026-09-01", "Vacances d'été 2026"],
  ["2026-10-17", "2026-11-02", "Vacances de la Toussaint"],
  ["2026-12-19", "2027-01-04", "Vacances de Noël"],
  ["2027-02-13", "2027-03-01", "Vacances d'hiver"],
  ["2027-04-10", "2027-04-26", "Vacances de printemps"],
  ["2027-05-07", "2027-05-08", "Pont de l'Ascension"],
  ["2027-07-03", "2027-09-02", "Vacances d'été 2027"],
];

export function isoDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), j = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${j}`;
}

export function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

export function publicHoliday(dateStr) {
  const d = parseIso(dateStr), y = d.getFullYear();
  const fixed = { "01-01": "Jour de l'an", "05-01": "Fête du Travail", "05-08": "Victoire 1945", "07-14": "Fête nationale",
    "08-15": "Assomption", "11-01": "Toussaint", "11-11": "Armistice", "12-25": "Noël" };
  const md = dateStr.slice(5);
  if (fixed[md]) return fixed[md];
  const e = easter(y), add = (n) => isoDate(new Date(e.getFullYear(), e.getMonth(), e.getDate() + n));
  const mobile = { [add(1)]: "Lundi de Pâques", [add(39)]: "Ascension", [add(50)]: "Lundi de Pentecôte" };
  return mobile[dateStr] || null;
}

/** Renvoie le libellé des vacances zone A si la date en fait partie, sinon null. */
export function zoneAHoliday(dateStr, list) {
  const src = list && list.length ? list.concat(ZONE_A_FALLBACK.filter((f) => !list.some((l) => l[0] === f[0]))) : ZONE_A_FALLBACK;
  for (const [s, e, label] of src) if (dateStr >= s && dateStr < e) return label;
  return null;
}

/** Pas de transport scolaire : vacances zone A, jour férié, dimanche. */
export function noSchoolReason(dateStr, list) {
  const h = zoneAHoliday(dateStr, list);
  if (h) return `${h} (zone A) : pas de transport scolaire`;
  const f = publicHoliday(dateStr);
  if (f) return `${f} (jour férié) : pas de transport scolaire`;
  if (parseIso(dateStr).getDay() === 0) return "Dimanche : pas de transport scolaire";
  return null;
}

import { prepare, search, accessStops, distM, fmtTime, fmtDur } from "./router.js";
import { estimate, PROFILES } from "./fares.js";
import { noSchoolReason, isoDate } from "./calendar.js";

/* global L */
const $ = (s) => document.querySelector(s);
const FEED_COLORS = {
  tag: "#3376b8",
  ruban: "#e5007d", tcl: "#e2001a", tcl_scolaire: "#f39200", rhonexpress: "#c8102e", cre: "#00843d",
  cri38: "#2e8b57", sncf: "#0c4da2", flixbus: "#5cb800", blablacar: "#00a3e0",
};
const PRESETS = {
  satolas: { lat: 45.6938, lon: 5.1307, label: "Satolas-et-Bonce (mairie)" },
  aeroport: { lat: 45.7215, lon: 5.0811, label: "Aéroport Lyon Saint-Exupéry" },
  partdieu: { lat: 45.7606, lon: 4.8597, label: "Lyon Part-Dieu" },
  grenoble: { lat: 45.1913, lon: 5.7146, label: "Grenoble (gare)" },
};
const GEO = "https://data.geopf.fr/geocodage";

const state = {
  net: null, from: null, to: null, picking: null, youth: false, results: [], selected: -1,
  feedOn: {}, markers: {}, hoverLayer: null, selLayer: null, stopsLayer: null,
};

/* ------------------------------------------------------------------ carte */
const wmts = (layer, fmt) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${fmt}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;
const attribution = '© <a href="https://geoservices.ign.fr" target="_blank" rel="noopener">IGN – Géoplateforme</a>';
const planIGN = L.tileLayer(wmts("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png"), { maxZoom: 19, attribution });
const photo = L.tileLayer(wmts("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg"), { maxZoom: 19, attribution });
const map = L.map("map", { zoomControl: true, preferCanvas: true, tap: true }).setView([45.69, 5.13], 11);
planIGN.addTo(map);
const canvas = L.canvas({ padding: 0.3 });
state.stopsLayer = L.layerGroup().addTo(map);
L.control.layers({ "Plan IGN": planIGN, "Photo aérienne (satellite)": photo }, { "Arrêts": state.stopsLayer }, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

function pinIcon(letter, color) {
  return L.divIcon({
    className: "", iconSize: [28, 28], iconAnchor: [14, 28],
    html: `<svg width="28" height="28" viewBox="0 0 28 28"><path d="M14 27s9-9.2 9-15A9 9 0 0 0 5 12c0 5.8 9 15 9 15z" fill="${color}" stroke="#fff" stroke-width="2"/><text x="14" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="system-ui">${letter}</text></svg>`,
  });
}

function setPoint(which, p, opts = {}) {
  state[which] = p;
  const input = $(`#${which}`);
  input.value = p ? p.label : "";
  if (state.markers[which]) { map.removeLayer(state.markers[which]); state.markers[which] = null; }
  if (p) {
    const m = L.marker([p.lat, p.lon], { draggable: true, icon: pinIcon(which === "from" ? "A" : "B", which === "from" ? "#1e7a3e" : "#b3261e"), zIndexOffset: 1000 })
      .addTo(map);
    m.on("dragend", async () => {
      const ll = m.getLatLng();
      setPoint(which, { lat: ll.lat, lon: ll.lng, label: await reverseLabel(ll.lat, ll.lng) }, { keepView: true });
      autoSearch();
    });
    state.markers[which] = m;
    if (!opts.keepView) {
      if (state.from && state.to) map.fitBounds(L.latLngBounds([[state.from.lat, state.from.lon], [state.to.lat, state.to.lon]]).pad(0.25));
      else map.panTo([p.lat, p.lon]);
    }
  }
  saveHash();
}

async function reverseLabel(lat, lon) {
  if (state.net) {
    const near = accessStops(state.net, lat, lon).filter((x) => x[2] < 60).sort((a, b) => a[2] - b[2]);
    if (near.length) return `Arrêt ${state.net.stops[near[0][0]][0]}`;
  }
  try {
    const r = await fetch(`${GEO}/reverse?lon=${lon}&lat=${lat}&limit=1`);
    const j = await r.json();
    if (j.features && j.features.length) return j.features[0].properties.label;
  } catch (e) { /* hors ligne */ }
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function setPicking(which) {
  state.picking = which;
  document.querySelectorAll(".pick").forEach((b) => b.classList.toggle("active", b.dataset.target === which));
  const hint = $("#pick-hint");
  hint.hidden = !which;
  if (which) hint.textContent = `Touchez la carte pour placer ${which === "from" ? "le départ (A)" : "l'arrivée (B)"}`;
  map.getContainer().style.cursor = which ? "crosshair" : "";
}

map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  let which = state.picking || (!state.from ? "from" : !state.to ? "to" : null);
  if (!which) {
    const div = document.createElement("div");
    div.className = "ctx-menu";
    div.innerHTML = `<button data-w="from">🟢 Partir d'ici</button><button data-w="to">🔴 Arriver ici</button>`;
    const pop = L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
    div.addEventListener("click", async (ev) => {
      const w = ev.target.dataset.w;
      if (!w) return;
      map.closePopup(pop);
      setPoint(w, { lat, lon: lng, label: await reverseLabel(lat, lng) });
      autoSearch();
    });
    return;
  }
  setPicking(null);
  setPoint(which, { lat, lon: lng, label: "…" }, { keepView: true });
  setPoint(which, { lat, lon: lng, label: await reverseLabel(lat, lng) }, { keepView: true });
  autoSearch();
});

/* ------------------------------------------------------------------ arrêts */
function feedKey(ri) { return state.net.feeds[state.net.routes[ri].f]?.key || ""; }
function routeColor(ri) {
  const r = state.net.routes[ri];
  if (r.c && !/^(ffffff|fff)$/i.test(r.c)) return `#${r.c}`;
  return FEED_COLORS[feedKey(ri)] || "#555";
}
function textColor(ri) {
  const r = state.net.routes[ri];
  if (r.tc) return `#${r.tc}`;
  const c = routeColor(ri).slice(1);
  const [R, G, B] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return R * 0.299 + G * 0.587 + B * 0.114 > 160 ? "#111" : "#fff";
}
/** Nom affiché d'une ligne : « TER C26 », « TGV » pour les trains SNCF, sinon le numéro de ligne. */
function lineLabel(ri) {
  const r = state.net.routes[ri], f = state.net.feeds[r.f] || {};
  const base = r.s || r.l || "?";
  if (f.key === "sncf") {
    if (/tgv|ouigo|inoui|lyria/i.test(`${r.s} ${r.l} ${r.a}`) || r.t === 101 || r.t === 102) return "TGV";
    return /^ter\b/i.test(base) ? base : `TER ${base}`;
  }
  return base;
}
function badge(ri) {
  const r = state.net.routes[ri];
  const label = lineLabel(ri);
  return `<span class="badge" style="background:${routeColor(ri)};color:${textColor(ri)}" title="${esc(r.l)}">${esc(label)}</span>`;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const isRx = (r) => /rh[oô]nexpress/i.test(`${r.a} ${r.s} ${r.l}`);
function routeEnabled(ri, date) {
  const r = state.net.routes[ri];
  // Rhônexpress : piloté par sa case, quel que soit le jeu de données qui le contient (TCL ou Rhônexpress)
  if (isRx(r)) {
    if (state.rxFeed < 0) return !!state.feedOn[r.f];
    if (r.f === state.rxFeed && state.rxElsewhere) return false; // horaires de principe inutiles : le vrai horaire est chargé
    return !!state.feedOn[state.rxFeed];
  }
  if (!state.feedOn[r.f]) return false;
  if (r.sc) return state.youth && !noSchoolReason(date, state.net.holidays);
  return true;
}

function drawStops() {
  state.stopsLayer.clearLayers();
  if (!state.net || !$("#show-stops").checked) return;
  const date = $("#date").value;
  const net = state.net;
  net.stops.forEach((s, i) => {
    const routes = net._stopRoutes[i];
    if (!routes.length) return;
    const shown = routes.filter((ri) => state.feedOn[net.routes[ri].f] && (!net.routes[ri].sc || state.youth));
    if (!shown.length) return;
    const allSchool = shown.every((ri) => net.routes[ri].sc);
    const off = !shown.some((ri) => routeEnabled(ri, date));
    const m = L.circleMarker([s[1], s[2]], {
      renderer: canvas, radius: 4.5, weight: 1.5, color: "#fff",
      fillColor: allSchool ? "#f39200" : routeColor(shown[0]), fillOpacity: off ? 0.35 : 0.95,
    });
    m.bindPopup(() => {
      const div = document.createElement("div");
      div.className = "stop-pop";
      div.innerHTML = `<b>${esc(s[0])}</b>${shown.map(badge).join(" ")}
        ${allSchool ? '<div class="small">Arrêt scolaire (élèves inscrits)</div>' : ""}
        <div class="ctx-menu" style="margin-top:6px"><button data-w="from">🟢 Partir de cet arrêt</button><button data-w="to">🔴 Arriver à cet arrêt</button></div>`;
      div.addEventListener("click", (ev) => {
        const w = ev.target.dataset.w;
        if (!w) return;
        map.closePopup();
        setPoint(w, { lat: s[1], lon: s[2], label: `Arrêt ${s[0]}` });
        autoSearch();
      });
      return div;
    });
    m.addTo(state.stopsLayer);
  });
}

/* ------------------------------------------------------------------ recherche d'adresse */
function setupSuggest(which) {
  const input = $(`#${which}`), list = $(`#${which}-suggest`);
  let timer = null, items = [], active = -1;
  const choose = (it) => { list.innerHTML = ""; items = []; setPoint(which, it); autoSearch(); };
  const render = () => {
    list.innerHTML = items.map((it, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">${esc(it.label)}<span class="small">${it.kind ? " · " + it.kind : ""}</span></li>`).join("");
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const res = [];
      if (state.net) {
        const qn = q.toLowerCase();
        const seen = new Set();
        state.net.stops.forEach((s) => {
          if (res.length < 4 && s[0].toLowerCase().includes(qn) && !seen.has(s[0])) {
            seen.add(s[0]);
            res.push({ lat: s[1], lon: s[2], label: `Arrêt ${s[0]}`, kind: "arrêt" });
          }
        });
      }
      try {
        const r = await fetch(`${GEO}/search?q=${encodeURIComponent(q)}&limit=6&lat=45.69&lon=5.13`);
        const j = await r.json();
        for (const f of j.features || []) res.push({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.label, kind: f.properties.type === "municipality" ? "commune" : "" });
      } catch (e) { /* hors ligne */ }
      items = res; active = -1; render();
    }, 280);
  });
  input.addEventListener("keydown", (e) => {
    if (!items.length) return;
    if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[Math.max(0, active)]); }
    else if (e.key === "Escape") { list.innerHTML = ""; }
  });
  list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(items[+li.dataset.i]); });
  input.addEventListener("blur", () => setTimeout(() => { list.innerHTML = ""; }, 200));
}

/* ------------------------------------------------------------------ itinéraires */
function stopName(x) {
  if (x === "origin") return state.from?.label || "départ";
  if (x === "dest") return state.to?.label || "arrivée";
  return state.net.stops[x][0];
}
function pointLL(x) {
  if (x === "origin") return [state.from.lat, state.from.lon];
  if (x === "dest") return [state.to.lat, state.to.lon];
  const s = state.net.stops[x];
  return [s[1], s[2]];
}

/* Itinéraire routier IGN (Géoplateforme) pour les étapes en voiture, mis en cache */
const carRoutes = new Map();
function carRoute(a, b) {
  const key = `${a[0].toFixed(5)},${a[1].toFixed(5)}|${b[0].toFixed(5)},${b[1].toFixed(5)}`;
  if (!carRoutes.has(key)) {
    const url = `https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=car&optimization=fastest` +
      `&start=${a[1]},${a[0]}&end=${b[1]},${b[0]}&geometryFormat=geojson&distanceUnit=kilometer&timeUnit=minute&getSteps=false`;
    carRoutes.set(key, fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => ({ coords: d.geometry.coordinates.map(([lo, la]) => [la, lo]), km: d.distance, min: d.duration }))
      .catch(() => { carRoutes.delete(key); return null; }));
  }
  return carRoutes.get(key);
}

function journeyLayer(j, strong) {
  const g = L.featureGroup();
  for (const l of j.legs) {
    if (l.kind === "walk") {
      L.polyline([pointLL(l.from), pointLL(l.to)], { color: "#333", weight: strong ? 4 : 3, dashArray: "4 7", opacity: 0.85 }).addTo(g);
    } else if (l.kind === "car") {
      const a = pointLL(l.from), b = pointLL(l.to);
      const tmp = L.polyline([a, b], { color: "#555", weight: 2, dashArray: "2 8", opacity: 0.6 }).addTo(g);
      carRoute(a, b).then((res) => {
        if (!res) return;
        g.removeLayer(tmp);
        L.polyline(res.coords, { color: "#fff", weight: strong ? 9 : 7, opacity: 0.9 }).addTo(g);
        L.polyline(res.coords, { color: "#3a3a3a", weight: strong ? 5 : 4, opacity: 0.95 }).addTo(g);
      });
    } else {
      const p = state.net.patterns[state.net.trips[l.trip][0]];
      const pts = p.st.slice(l.fromPos, l.toPos + 1).map((s) => [state.net.stops[s][1], state.net.stops[s][2]]);
      const color = routeColor(l.route);
      L.polyline(pts, { color: "#fff", weight: strong ? 9 : 7, opacity: 0.9 }).addTo(g);
      L.polyline(pts, { color, weight: strong ? 6 : 4, opacity: 1 }).addTo(g);
      pts.forEach((pt, k) => L.circleMarker(pt, { radius: k === 0 || k === pts.length - 1 ? 5 : 2.5, color, weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(g));
    }
  }
  return g;
}

function showHover(i) {
  if (state.hoverLayer) { map.removeLayer(state.hoverLayer); state.hoverLayer = null; }
  if (i < 0 || i === state.selected) return;
  state.hoverLayer = journeyLayer(state.results[i], false).addTo(map);
}
function select(i) {
  state.selected = i;
  if (state.selLayer) { map.removeLayer(state.selLayer); state.selLayer = null; }
  if (state.hoverLayer) { map.removeLayer(state.hoverLayer); state.hoverLayer = null; }
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("selected", +c.dataset.i === i));
  if (i >= 0) {
    const j = state.results[i];
    state.selLayer = journeyLayer(j, true).addTo(map);
    map.fitBounds(state.selLayer.getBounds().pad(0.15), { maxZoom: 15 });
    const card = document.querySelector(`.card[data-i="${i}"]`);
    j.legs.forEach((l, k) => {
      if (l.kind !== "car") return;
      carRoute(pointLL(l.from), pointLL(l.to)).then((res) => {
        const el = card && card.querySelector(`[data-car="${k}"] .ign`);
        if (!el) return;
        if (!res) { el.textContent = "Itinéraire IGN indisponible (tracé à vol d'oiseau)."; return; }
        const drive = Math.round(res.min);
        const planned = l.min - (l.to !== "dest" ? 5 : 0); // hors stationnement
        const late = drive - planned;
        el.innerHTML = `Itinéraire IGN : ${res.km.toFixed(1).replace(".", ",")} km, ${drive} min de conduite hors trafic` +
          (late > 3 && l.to !== "dest" ? ` <b class="warnline">⚠ ${late} min de plus que prévu : partez plus tôt pour ne pas rater la correspondance</b>` : "");
        if (state.selLayer) map.fitBounds(state.selLayer.getBounds().pad(0.15), { maxZoom: 15 });
      });
    });
  }
}

function cardHtml(j, i, date) {
  const net = state.net;
  const rides = j.legs.filter((l) => l.kind === "ride");
  const walks = j.legs.filter((l) => l.kind === "walk" && !((l.m ?? 999) < 30 && (l.from === "origin" || l.to === "dest")));
  const walkTotal = walks.reduce((s, l) => s + l.min, 0);
  const carTotal = j.legs.filter((l) => l.kind === "car").reduce((s, l) => s + l.min, 0);
  const walkM = walks.reduce((s, l) => s + (l.m || 0), 0);
  const chain = j.legs.map((l) => (l.kind === "ride" ? badge(l.route) : l.kind === "car" ? `<span class="walkchip carchip">🚗 ${l.min}′</span>` : l.min >= 2 ? `<span class="walkchip">🚶${l.min}′</span>` : "")).filter(Boolean).join(" › ");
  const profile = $("#profile").value;
  const e2 = (x) => `${x.toFixed(2).replace(".", ",")} €`;
  const fare = rides.length || carTotal ? estimate(net, j, profile, date) : { occ: 0, week: 0, month: 0, lines: [] };
  const flags = new Set();
  if (carTotal) flags.add(`<span class="flag">🚗 Durée voiture estimée hors trafic${j.carOnly ? "" : " (+5 min pour se garer)"}</span>`);
  for (const l of rides) {
    const r = net.routes[l.route], feed = net.feeds[r.f] || {};
    if (r.tad || l.resa) flags.add(`<span class="flag">📞 Réservation obligatoire (${esc(r.s || r.l)})</span>`);
    if (r.sc) flags.add(`<span class="flag school">🎒 Ligne scolaire ${esc(r.s)} : élèves inscrits</span>`);
    if (feed.key === "flixbus" && ["ado", "enfant", "bebe", "eleve"].includes(profile)) flags.add(`<span class="flag">FlixBus : moins de 16 ans accompagné obligatoirement</span>`);
    else if (feed.warning) flags.add(`<span class="flag">${esc(feed.warning)}</span>`);
  }
  let legs = "", prevArr = null;
  for (const l of j.legs) {
    if (prevArr !== null && l.dep - prevArr >= 2 && l.kind === "ride") legs += `<li><span class="sub">⏳ Attente ${fmtDur(l.dep - prevArr)}</span></li>`;
    if (l.kind === "car") {
      legs += `<li class="carleg" data-car="${j.legs.indexOf(l)}"><span class="t">🚗 Voiture ${l.min} min</span> <span class="sub">(${(l.m / 1000).toFixed(1).replace(".", ",")} km${l.to !== "dest" ? ", stationnement compris" : ""})</span><br><span class="sub">${esc(stopName(l.from))} → ${esc(stopName(l.to))}</span><br><span class="sub ign">Itinéraire IGN en cours…</span></li>`;
      prevArr = l.arr;
      continue;
    }
    if (l.kind === "walk") {
      const m = l.m ?? Math.round(distM(...pointLL(l.from), ...pointLL(l.to)));
      if (m < 30 && (l.from === "origin" || l.to === "dest")) { prevArr = l.arr; continue; }
      const label = l.from !== "origin" && l.to !== "dest" ? "Correspondance à pied" : "Marche";
      legs += `<li><span class="t">🚶 ${label} ${l.min} min</span> <span class="sub">(${m} m)</span><br><span class="sub">${esc(stopName(l.from))} → ${esc(stopName(l.to))}</span></li>`;
    } else {
      const nstops = l.toPos - l.fromPos;
      legs += `<li class="ride" style="--legc:${routeColor(l.route)}">${badge(l.route)} <span class="sub">${esc(net.feeds[net.routes[l.route].f]?.label || "")}${l.headsign ? " · direction " + esc(stopName(net.patterns[net.trips[l.trip][0]].st.at(-1))) : ""}</span><br>
        <span class="t">${fmtTime(l.dep)}</span> ${esc(stopName(l.from))}<br>
        <span class="t">${fmtTime(l.arr)}</span> ${esc(stopName(l.to))} <span class="sub">(${fmtDur(l.arr - l.dep)}, ${nstops} arrêt${nstops > 1 ? "s" : ""})</span></li>`;
    }
    prevArr = l.arr;
  }
  const fareTxt = fare.lines.length
    ? `<table class="fares"><thead><tr><th>Réseau</th><th>Trajet</th><th>Semaine<br><span>5 A/R</span></th><th>Mois<br><span>22 A/R</span></th></tr></thead><tbody>${fare.lines.map((x) =>
      `<tr><td>${esc(x.label)}<br><span>${esc(x.note)}</span></td><td>${e2(x.occ)}</td><td>${e2(x.week.p)}<br><span>${esc(x.week.n)}</span></td><td>${e2(x.month.p)}<br><span>${esc(x.month.n)}</span></td></tr>`).join("")}
      </tbody><tfoot><tr><td>Total</td><td>${e2(fare.occ)}</td><td>${e2(fare.week)}</td><td>${e2(fare.month)}</td></tr></tfoot></table>`
    : "Gratuit (à pied)";
  return `<li class="card" data-i="${i}" tabindex="0">
    <div class="top"><span class="times">${fmtTime(j.leave)} → ${fmtTime(j.arrive)}</span><span class="dur">${fmtDur(j.duration)}</span></div>
    <div class="chain">${chain || '<span class="walkchip">🚶 À pied</span>'}</div>
    <div class="meta"><span>${rides.length ? (j.transfers ? `${j.transfers} correspondance${j.transfers > 1 ? "s" : ""}` : "Direct") : j.carOnly ? "Tout en voiture" : "Marche seule"}${walkTotal ? ` · marche ${walkTotal} min (${(walkM / 1000).toFixed(1).replace(".", ",")} km)` : ""}${carTotal ? ` · voiture ${carTotal} min` : ""}</span>
      <span class="cost" title="Trajet / semaine (5 A/R) / mois (22 A/R)">≈ ${e2(fare.occ)} · sem. ${e2(fare.week)} · mois ${e2(fare.month)}</span></div>
    ${flags.size ? `<div class="flags">${[...flags].join("")}</div>` : ""}
    <ol class="legs">${legs}</ol>
    <div class="fare">Coût estimé (${esc(PROFILES[profile].label)}), meilleur choix entre tickets et abonnements :${fareTxt}</div>
  </li>`;
}

function updateSchoolNote() {
  const date = $("#date").value;
  const reason = state.net ? noSchoolReason(date, state.net.holidays) : noSchoolReason(date);
  const note = $("#school-note");
  if (state.youth && reason) { note.hidden = false; note.textContent = `${reason}. Les lignes scolaires sont exclues ce jour-là.`; }
  else if (state.youth) { note.hidden = false; note.textContent = "Lignes scolaires incluses : réservées aux élèves inscrits au transport scolaire (abonnement Scolaire+ / Ruban / TCL)."; }
  else note.hidden = true;
}

/** Bouton jeunes désactivé : signale les lignes scolaires qui desserviraient le trajet. */
function schoolHint(date, time, res) {
  const box = $("#school-hint");
  box.hidden = true;
  if (state.youth || noSchoolReason(date, state.net.holidays)) return;
  setTimeout(() => {
    const alt = search(state.net, {
      o: state.from, d: state.to, date, time, arriveBy: $("#mode").value === "arrive", sort: $("#sort").value,
      car: $("#car").value, maxWalk: +$("#maxwalk").value,
      cacheKey: `${date}|true|${Object.entries(state.feedOn).filter(([, v]) => v).map(([k]) => k).join(",")}`,
      routeOk: (ri) => { const r = state.net.routes[ri]; return r.sc ? routeEnabled(ri, date) || state.feedOn[r.f] : routeEnabled(ri, date); },
    });
    const names = new Set();
    for (const j of alt.journeys) for (const l of j.legs) if (l.kind === "ride" && state.net.routes[l.route].sc) names.add(lineLabel(l.route));
    if (!names.size) return;
    box.hidden = false;
    box.innerHTML = `🎒 Des lignes scolaires desservent ce trajet (${[...names].slice(0, 6).map(esc).join(", ")}). ` +
      `<button type="button" id="hint-youth">Afficher avec « Réservé aux jeunes »</button>`;
    $("#hint-youth").addEventListener("click", () => $("#youth").click());
  }, 30);
}

let searchTimer = null;
function autoSearch() { clearTimeout(searchTimer); if (state.from && state.to && state.net) searchTimer = setTimeout(runSearch, 150); }

function runSearch() {
  const status = $("#status"), list = $("#results");
  status.classList.remove("error");
  if (!state.net) { status.textContent = "Horaires non chargés."; return; }
  if (!state.from || !state.to) { status.textContent = "Choisissez un départ et une arrivée (clic sur la carte ou adresse)."; return; }
  const date = $("#date").value, [hh, mm] = $("#time").value.split(":").map(Number);
  const time = hh * 60 + mm;
  const { center, radius_km } = state.net;
  const far = [state.from, state.to].some((p) => distM(p.lat, p.lon, center[0], center[1]) > radius_km * 1000);
  status.textContent = "Recherche en cours…";
  list.innerHTML = "";
  setTimeout(() => {
    const t0 = performance.now();
    const res = search(state.net, {
      o: state.from, d: state.to, date, time, arriveBy: $("#mode").value === "arrive", sort: $("#sort").value,
      car: $("#car").value, maxWalk: +$("#maxwalk").value,
      cacheKey: `${date}|${state.youth}|${Object.entries(state.feedOn).filter(([, v]) => v).map(([k]) => k).join(",")}`,
      routeOk: (ri) => routeEnabled(ri, date),
    });
    state.results = res.journeys;
    state.selected = -1;
    if (state.selLayer) { map.removeLayer(state.selLayer); state.selLayer = null; }
    const ms = Math.round(performance.now() - t0);
    if (!res.journeys.length) {
      status.classList.add("error");
      const mw = $("#maxwalk").value;
      status.textContent = !res.originStops ? `Aucun arrêt à moins de ${mw} min de marche du départ : essayez l'option « Voiture au départ ».`
        : !res.destStops ? `Aucun arrêt à moins de ${mw} min de marche de l'arrivée : essayez l'option « Voiture à l'arrivée ».`
        : "Aucune solution trouvée dans les 4 heures. Essayez un autre horaire, un autre jour ou l'option voiture.";
    } else {
      status.textContent = `${res.journeys.length} solution${res.journeys.length > 1 ? "s" : ""}, triées par ${$("#sort").value === "duration" ? "durée" : "heure d'arrivée"} (${ms} ms).`;
    }
    if (far) status.textContent += " ⚠ Point situé à plus de 100 km de Satolas : desserte incomplète.";
    list.innerHTML = res.journeys.map((j, i) => cardHtml(j, i, date)).join("");
    if (res.journeys.length) select(0);
    saveHash();
    schoolHint(date, time, res);
  }, 20);
}

$("#results").addEventListener("mouseover", (e) => { const c = e.target.closest(".card"); if (c) { document.querySelectorAll(".card.hover").forEach((x) => x.classList.remove("hover")); c.classList.add("hover"); showHover(+c.dataset.i); } });
$("#results").addEventListener("mouseleave", () => { document.querySelectorAll(".card.hover").forEach((x) => x.classList.remove("hover")); showHover(-1); });
$("#results").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) select(+c.dataset.i === state.selected && e.target.closest(".legs") ? state.selected : +c.dataset.i); });
$("#results").addEventListener("keydown", (e) => { const c = e.target.closest(".card"); if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(+c.dataset.i); } });

/* ------------------------------------------------------------------ formulaire */
function initForm() {
  const prof = $("#profile");
  prof.innerHTML = Object.entries(PROFILES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  const now = new Date(Date.now() + 5 * 60000);
  $("#date").value = isoDate(now);
  $("#time").value = `${String(now.getHours()).padStart(2, "0")}:${String(Math.floor(now.getMinutes() / 5) * 5).padStart(2, "0")}`;
  setupSuggest("from");
  setupSuggest("to");
  document.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => setPicking(state.picking === b.dataset.target ? null : b.dataset.target)));
  $("#swap").addEventListener("click", () => {
    const a = state.from, b = state.to;
    setPoint("from", b, { keepView: true });
    setPoint("to", a, { keepView: true });
    autoSearch();
  });
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
    const which = !state.from ? "from" : !state.to ? "to" : state.picking || "to";
    setPoint(which, { ...PRESETS[b.dataset.preset] });
    autoSearch();
  }));
  $("#now").addEventListener("click", () => {
    const d = new Date();
    $("#date").value = isoDate(d);
    $("#time").value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    $("#mode").value = "depart";
    updateSchoolNote(); drawStops(); saveHash();
    if (state.from && state.to) runSearch();
    else $("#status").textContent = "Choisissez un départ et une arrivée (clic sur la carte ou adresse).";
  });
  $("#youth").addEventListener("click", () => {
    state.youth = !state.youth;
    $("#youth").setAttribute("aria-pressed", String(state.youth));
    if (state.youth && ["adulte", "jeune"].includes(prof.value)) prof.value = "eleve";
    if (!state.youth && prof.value === "eleve") prof.value = "adulte";
    updateSchoolNote(); drawStops(); autoSearch();
  });
  $("#date").addEventListener("change", () => { updateSchoolNote(); drawStops(); autoSearch(); });
  ["#time", "#mode", "#sort", "#profile", "#car", "#maxwalk"].forEach((s) => $(s).addEventListener("change", () => { saveHash(); autoSearch(); }));
  $("#show-stops").addEventListener("change", drawStops);
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setPicking(null); });
}

/* ------------------------------------------------------------------ partage par l'URL */
function saveHash() {
  const p = new URLSearchParams();
  if (state.from) p.set("a", `${state.from.lat.toFixed(5)},${state.from.lon.toFixed(5)},${state.from.label}`);
  if (state.to) p.set("b", `${state.to.lat.toFixed(5)},${state.to.lon.toFixed(5)},${state.to.label}`);
  p.set("d", $("#date").value); p.set("h", $("#time").value); p.set("m", $("#mode").value);
  if (state.youth) p.set("j", "1");
  if ($("#car").value !== "none") p.set("v", $("#car").value);
  if ($("#maxwalk").value !== "20") p.set("w", $("#maxwalk").value);
  history.replaceState(null, "", `#${p.toString()}`);
}
function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const pt = (s) => { if (!s) return null; const [la, lo, ...rest] = s.split(","); return { lat: +la, lon: +lo, label: rest.join(",") || `${la}, ${lo}` }; };
  if (p.get("d")) $("#date").value = p.get("d");
  if (p.get("h")) $("#time").value = p.get("h");
  if (p.get("m")) $("#mode").value = p.get("m");
  if (p.get("j") === "1") $("#youth").click();
  if (p.get("v")) $("#car").value = p.get("v");
  if (p.get("w")) $("#maxwalk").value = p.get("w");
  const a = pt(p.get("a")), b = pt(p.get("b"));
  if (a) setPoint("from", a, { keepView: true });
  if (b) setPoint("to", b, { keepView: !a });
  if (a && b) map.fitBounds(L.latLngBounds([[a.lat, a.lon], [b.lat, b.lon]]).pad(0.25));
}

/* ------------------------------------------------------------------ données */
function renderFeeds() {
  const net = state.net;
  $("#feed-list").innerHTML = net.feeds.map((f, i) => {
    const ok = f.status === "ok";
    const miss = f.missing && f.missing.length ? ` <span class="small">(non trouvées : ${esc(f.missing.join(", "))})</span>` : "";
    return `<label class="chk"><input type="checkbox" data-f="${i}" ${ok ? "checked" : "disabled"}>
      <span class="swatch" style="background:${FEED_COLORS[f.key] || "#555"}"></span> ${esc(f.label)}
      <span class="small">${ok ? `${f.trips} courses` : esc(f.status)}</span>${miss}</label>`;
  }).join("");
  $("#feed-list").querySelectorAll("input[data-f]").forEach((c) => c.addEventListener("change", () => {
    state.feedOn[+c.dataset.f] = c.checked; drawStops(); autoSearch();
  }));
  const gen = new Date(net.generated);
  $("#data-info").textContent = `Horaires générés le ${gen.toLocaleDateString("fr-FR")} à ${gen.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}, valables du ${new Date(net.start).toLocaleDateString("fr-FR")} sur ${net.ndays} jours. ${net.stops.length} arrêts, ${net.trips.length} courses.`;
}

async function loadData() {
  const status = $("#status");
  status.textContent = "Chargement des horaires…";
  try {
    const r = await fetch("data/network.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const net = await r.json();
    state.net = prepare(net);
    net.feeds.forEach((f, i) => { state.feedOn[i] = f.status === "ok"; });
    state.rxFeed = net.feeds.findIndex((f) => f.key === "rhonexpress");
    state.rxElsewhere = net.routes.some((r) => isRx(r) && r.f !== state.rxFeed);
    renderFeeds();
    drawStops();
    updateSchoolNote();
    const last = new Date(net.start); last.setDate(last.getDate() + net.ndays - 1);
    $("#date").max = isoDate(last);
    status.textContent = "Cliquez sur la carte pour placer le départ (A) puis l'arrivée (B).";
    if (state.from && state.to) runSearch();
  } catch (e) {
    status.classList.add("error");
    status.innerHTML = `<div class="banner">Les horaires ne sont pas encore disponibles (${esc(e.message)}). Ils sont générés automatiquement par le workflow GitHub « Déploiement » ; relancez-le depuis l'onglet Actions du dépôt si besoin.</div>`;
  }
}

initForm();
loadHash();
loadData();
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  // une nouvelle version du site prend la main : recharger une fois pour utiliser le code à jour
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
}

// Moteur d'itinéraires : Connection Scan Algorithm (CSA) sur les horaires GTFS précalculés.
// Fonctionne dans le navigateur et sous Node (tests).

export const WALK_M_PER_MIN = 75;     // ~4,5 km/h
export const DETOUR = 1.3;            // facteur trajet réel / vol d'oiseau
export const TRANSFER_MIN = 2;        // marge de correspondance
export const FOOTPATH_M = 450;        // correspondance à pied entre arrêts proches
export const MAX_WALK_MIN = 20;       // marche max par étape (réglable dans l'interface)
export const CAR_MAX_M = 30000;       // voiture : rayon de recherche des parkings (gares, trams, cars express)
export const CAR_LOCAL_M = 8000;     // voiture : tout arrêt de bus à moins de 8 km (rabattement local)
export const CAR_STOPS = 40;          // voiture : nombre max d'arrêts candidats

export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export const walkMin = (m) => Math.max(1, Math.ceil((m * DETOUR) / WALK_M_PER_MIN));
/** Voiture : distance routière ≈ 1,3 × vol d'oiseau ; 32 km/h sur courte distance, 60 km/h au-delà de 15 km (calé sur les durées IGN). */
export function carMin(m) {
  const road = m * DETOUR;
  const kmh = road > 15000 ? 60 : 32;
  return Math.max(2, Math.ceil(road / ((kmh * 1000) / 60)));
}
export const PARK_MIN = 5;            // se garer et rejoindre le quai

function dayOffset(startIso, dateIso) {
  const [y1, m1, d1] = startIso.split("-").map(Number), [y2, m2, d2] = dateIso.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function serviceRuns(hex, d) {
  if (d < 0) return false;
  const i = d >> 2;
  if (i >= hex.length) return false;
  return ((parseInt(hex[i], 16) >> (3 - (d & 3))) & 1) === 1;
}

/** Prépare les index (voisinage des arrêts, lignes par arrêt). À appeler une fois. */
export function prepare(net) {
  const n = net.stops.length;
  const cell = 0.005; // ~500 m
  const grid = new Map();
  const key = (la, lo) => `${Math.floor(la / cell)}:${Math.floor(lo / cell)}`;
  net.stops.forEach((s, i) => {
    const k = key(s[1], s[2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  net._grid = { grid, cell, key };
  const foot = new Array(n);
  for (let i = 0; i < n; i++) {
    const [, la, lo] = net.stops[i];
    const res = [];
    for (const j of nearbyIdx(net, la, lo, FOOTPATH_M)) {
      if (j === i) continue;
      const d = distM(la, lo, net.stops[j][1], net.stops[j][2]);
      if (d <= FOOTPATH_M) res.push([j, walkMin(d), Math.round(d)]);
    }
    foot[i] = res;
  }
  net._foot = foot;
  const stopRoutes = Array.from({ length: n }, () => new Set());
  net.patterns.forEach((p) => p.st.forEach((s) => stopRoutes[s].add(p.r)));
  net._stopRoutes = stopRoutes.map((s) => [...s]);
  // arrêts où l'on peut raisonnablement se garer : gares, trams, cars express, Rhônexpress, TAD/Péri
  net._carOk = net._stopRoutes.map((rs) => rs.some((ri) => {
    const r = net.routes[ri], f = net.feeds[r.f] || {};
    return r.t === 0 || r.t === 1 || r.t === 2 || (r.t >= 100 && r.t < 200) || r.t === 900 ||
      f.key === "rhonexpress" || (f.fare === "cars_region" && /^X/i.test(r.s || "")) || r.tad;
  }));
  return net;
}

export function nearbyIdx(net, lat, lon, radiusM) {
  const { grid, cell, key } = net._grid;
  const span = Math.ceil(radiusM / 400) + 1;
  const ci = Math.floor(lat / cell), cj = Math.floor(lon / cell);
  const out = [];
  for (let a = -span; a <= span; a++)
    for (let b = -span; b <= span; b++) {
      const arr = grid.get(`${ci + a}:${cj + b}`);
      if (arr) out.push(...arr);
    }
  return out.filter((j) => distM(lat, lon, net.stops[j][1], net.stops[j][2]) <= radiusM);
}

/**
 * Arrêts accessibles depuis un point : [[stopIdx, minutes, mètres, "walk"|"car"], …]
 * opts = {maxWalk: minutes de marche max, car: true pour autoriser la voiture}
 */
export function accessStops(net, lat, lon, opts = {}) {
  const maxWalk = opts.maxWalk ?? MAX_WALK_MIN;
  const radius = (maxWalk * WALK_M_PER_MIN) / DETOUR;
  const best = new Map();
  for (const j of nearbyIdx(net, lat, lon, radius)) {
    const d = distM(lat, lon, net.stops[j][1], net.stops[j][2]);
    const w = walkMin(d);
    if (w <= maxWalk) best.set(j, [j, w, Math.round(d), "walk"]);
  }
  // arrêts voisins (correspondance à pied) des arrêts trouvés
  for (const [j, w, m] of [...best.values()])
    for (const [nb, w2, m2] of net._foot[j] || []) {
      const cur = best.get(nb);
      if (w + w2 <= maxWalk && (!cur || cur[1] > w + w2)) best.set(nb, [nb, w + w2, m + m2, "walk"]);
    }
  if (opts.car) {
    const cand = [];
    const local = [];
    for (const j of nearbyIdx(net, lat, lon, CAR_MAX_M)) {
      const d = distM(lat, lon, net.stops[j][1], net.stops[j][2]);
      const isLocal = d <= CAR_LOCAL_M && !net._carOk[j];
      if (!net._carOk[j] && !isLocal) continue;
      // se garer seulement « de son côté » : pas à un arrêt plus proche de l'autre extrémité du trajet
      if (opts.other) {
        const dOther = distM(opts.other.lat, opts.other.lon, net.stops[j][1], net.stops[j][2]);
        const dTot = distM(lat, lon, opts.other.lat, opts.other.lon);
        if (d > dTot * 0.6 || dOther < d) continue;
      }
      (isLocal ? local : cand).push([j, carMin(d) + PARK_MIN, Math.round(d * DETOUR), "car"]);
    }
    cand.sort((a, b) => a[1] - b[1]);
    local.sort((a, b) => a[1] - b[1]);
    for (const c of [...cand.slice(0, CAR_STOPS), ...local.slice(0, 30)]) {
      const cur = best.get(c[0]);
      if (!cur || cur[1] > c[1] + 3) best.set(c[0], c); // à pied si presque aussi rapide
    }
  }
  return [...best.values()];
}

/**
 * Connexions élémentaires (arrêt → arrêt suivant) circulant le jour donné, triées par heure de départ.
 * routeOk(routeIdx) permet d'exclure des lignes (scolaires, réseaux masqués…).
 */
export function buildDay(net, dateIso, routeOk) {
  const d = dayOffset(net.start, dateIso);
  const list = [];
  const tripMeta = [];
  for (let ti = 0; ti < net.trips.length; ti++) {
    const [pi, si, dep0, times] = net.trips[ti];
    const p = net.patterns[pi];
    if (routeOk && !routeOk(p.r)) continue;
    const hex = net.services[si];
    for (const shift of [0, -1440]) {
      if (!serviceRuns(hex, d + (shift ? -1 : 0))) continue;
      const last = dep0 + times[times.length - 1] + shift;
      if (last < 0) continue;
      const k = tripMeta.length;
      tripMeta.push({ ti, shift, r: p.r });
      for (let i = 0; i + 1 < p.st.length; i++) {
        const dep = dep0 + times[i] + shift, arr = dep0 + times[i + 1] + shift;
        list.push(dep, arr, p.st[i], p.st[i + 1], k, i);
      }
    }
  }
  const m = list.length / 6;
  const order = new Uint32Array(m);
  for (let i = 0; i < m; i++) order[i] = i;
  order.sort((a, b) => list[a * 6] - list[b * 6] || list[a * 6 + 1] - list[b * 6 + 1]);
  const C = { dep: new Int32Array(m), arr: new Int32Array(m), from: new Int32Array(m), to: new Int32Array(m),
    trip: new Int32Array(m), pos: new Int32Array(m), n: m, tripMeta, date: dateIso };
  for (let i = 0; i < m; i++) {
    const o = order[i] * 6;
    C.dep[i] = list[o]; C.arr[i] = list[o + 1]; C.from[i] = list[o + 2]; C.to[i] = list[o + 3];
    C.trip[i] = list[o + 4]; C.pos[i] = list[o + 5];
  }
  return C;
}

function lowerBound(arr, n, v) {
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Un passage CSA : itinéraire le plus tôt arrivé en partant à t0 (minutes). */
export function csa(net, C, origin, dest, t0, opts = {}) {
  const n = net.stops.length;
  const S = new Float64Array(n).fill(Infinity);    // prêt à repartir (avec marge)
  const A = new Float64Array(n).fill(Infinity);    // arrivée brute
  const J = new Array(n);
  const T = new Int32Array(C.tripMeta.length).fill(-1);
  const egress = new Map(dest.map(([s, w, m, mode]) => [s, [w, m, mode]]));
  for (const [s, w, m, mode] of origin) {
    if (t0 + w < S[s]) { S[s] = t0 + w; A[s] = t0 + w; J[s] = { kind: "origin", walk: w, m, mode }; }
  }
  // pas de raccourci départ -> arrivée sans transport (les trajets à pied / en voiture seuls sont traités à part)
  let best = Infinity, bestStop = -1;
  const maxT = t0 + (opts.horizon || 360);
  for (let i = lowerBound(C.dep, C.n, t0); i < C.n; i++) {
    const dep = C.dep[i];
    if (dep >= best || dep > maxT) break;
    const tk = C.trip[i];
    if (T[tk] === -1) {
      if (S[C.from[i]] > dep) continue;
      if (opts.only !== undefined && J[C.from[i]] && J[C.from[i]].kind === "origin" && C.tripMeta[tk].r !== opts.only) continue;
      T[tk] = i;
    }
    const to = C.to[i], arr = C.arr[i];
    if (arr < A[to]) {
      A[to] = arr; S[to] = arr + TRANSFER_MIN; J[to] = { kind: "ride", enter: T[tk], exit: i };
      const e = egress.get(to);
      if (e && arr + e[0] < best) { best = arr + e[0]; bestStop = to; }
      for (const [nb, w, dm] of net._foot[to]) {
        const t = arr + w;
        if (t < A[nb] && !(J[nb] && J[nb].kind === "origin" && A[nb] <= t)) {
          A[nb] = t; S[nb] = t + TRANSFER_MIN; J[nb] = { kind: "foot", from: to, walk: w, m: dm };
          const e2 = egress.get(nb);
          if (e2 && t + e2[0] < best) { best = t + e2[0]; bestStop = nb; }
        }
      }
    }
  }
  if (bestStop < 0 || best === Infinity) return null;
  // reconstruction
  const legs = [];
  let s = bestStop, guard = 0;
  const [ew, em, emode] = egress.get(bestStop);
  legs.push({ kind: emode === "car" ? "car" : "walk", from: s, to: "dest", min: ew, m: em });
  while (guard++ < 50) {
    const j = J[s];
    if (!j) return null;
    if (j.kind === "origin") { legs.push({ kind: j.mode === "car" ? "car" : "walk", from: "origin", to: s, min: j.walk, m: j.m }); break; }
    if (j.kind === "foot") { legs.push({ kind: "walk", from: j.from, to: s, min: j.walk, m: j.m }); s = j.from; continue; }
    const ce = j.enter, cx = j.exit, meta = C.tripMeta[C.trip[ce]];
    const trip = net.trips[meta.ti], pat = net.patterns[trip[0]];
    legs.push({ kind: "ride", trip: meta.ti, route: pat.r, from: C.from[ce], to: C.to[cx], dep: C.dep[ce], arr: C.arr[cx],
      fromPos: C.pos[ce], toPos: C.pos[cx] + 1, headsign: trip[5] || "", resa: !!trip[4] });
    s = C.from[ce];
  }
  legs.reverse();
  const res = finalize(net, legs, best);
  if (res && opts.maxWalk && res.legs.some((l) => l.kind === "walk" && l.min > opts.maxWalk)) return null;
  return res;
}

function finalize(net, legs, arrival) {
  // fusionne les marches consécutives, retire les marches nulles
  const out = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (l.kind === "walk" && prev && prev.kind === "walk") { prev.min += l.min; prev.m = (prev.m || 0) + (l.m || 0); prev.to = l.to; continue; }
    out.push({ ...l });
  }
  const rides = out.filter((l) => l.kind === "ride");
  if (!rides.length) return null;
  // horaires des marches
  let t = rides[0].dep;
  for (let i = out.indexOf(rides[0]) - 1; i >= 0; i--) { out[i].arr = t; out[i].dep = t - out[i].min; t = out[i].dep; }
  const leave = t;
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind !== "ride" && out[i].dep === undefined) { const p = out[i - 1]; out[i].dep = p.arr; out[i].arr = p.arr + out[i].min; }
  }
  const arr = out[out.length - 1].arr ?? arrival;
  const sig = out.map((r) => (r.kind === "ride" ? `${r.trip}:${r.from}:${r.to}` : r.kind)).join("|");
  return { legs: out, leave, arrive: arr, duration: arr - leave, transfers: rides.length - 1, sig };
}

/** Marche directe si elle ne dépasse pas la marche max. */
export function walkOnly(o, d, t, arriveBy, maxWalk = MAX_WALK_MIN) {
  const m = distM(o.lat, o.lon, d.lat, d.lon);
  const min = walkMin(m);
  if (min > maxWalk) return null;
  const leave = arriveBy ? t - min : t;
  return { legs: [{ kind: "walk", from: "origin", to: "dest", min, m: Math.round(m), dep: leave, arr: leave + min }],
    leave, arrive: leave + min, duration: min, transfers: 0, sig: "walk" };
}

/** Trajet entièrement en voiture (estimation). */
export function carOnly(o, d, t, arriveBy) {
  const m = distM(o.lat, o.lon, d.lat, d.lon);
  if (m < 500) return null;
  const min = carMin(m);
  const leave = arriveBy ? t - min : t;
  return { legs: [{ kind: "car", from: "origin", to: "dest", min, m: Math.round(m * DETOUR), dep: leave, arr: leave + min }],
    leave, arrive: leave + min, duration: min, transfers: 0, sig: "car", carOnly: true };
}

/**
 * Recherche plusieurs solutions et les classe par durée.
 * q = {o:{lat,lon}, d:{lat,lon}, date:'AAAA-MM-JJ', time: minutes, arriveBy: bool, routeOk(fn), stopOk(fn)}
 */
export function search(net, q) {
  let C;
  if (q.cacheKey) {
    net._dayCache = net._dayCache || new Map();
    C = net._dayCache.get(q.cacheKey);
    if (!C) {
      C = buildDay(net, q.date, q.routeOk);
      if (net._dayCache.size > 6) net._dayCache.clear();
      net._dayCache.set(q.cacheKey, C);
    }
  } else C = buildDay(net, q.date, q.routeOk);
  const maxWalk = q.maxWalk ?? MAX_WALK_MIN;
  const car = q.car || "none";
  const runs = [[car === "start" || car === "both", car === "end" || car === "both"]];
  if (car !== "none") runs.push([false, false]); // garde aussi les solutions sans voiture
  const found = new Map();
  const add = (j) => { if (j && (!found.has(j.sig) || found.get(j.sig).duration > j.duration)) found.set(j.sig, j); };
  let origin = [], dest = [];
  for (const [co, cd] of runs) {
    const ori = accessStops(net, q.o.lat, q.o.lon, { maxWalk, car: co, other: q.d });
    const des = accessStops(net, q.d.lat, q.d.lon, { maxWalk, car: cd, other: q.o });
    if (!origin.length) { origin = ori; dest = des; }
    if (!ori.length || !des.length) continue;
    const starts = [];
    if (q.arriveBy) for (let t = q.time - 300; t <= q.time; t += 10) starts.push(t);
    else for (let t = q.time; t <= q.time + 240; t += 10) starts.push(t);
    for (const t0 of starts) {
      const j = csa(net, C, ori, des, t0, { horizon: 400, maxWalk });
      if (!j) continue;
      if (q.arriveBy && j.arrive > q.time) continue;
      if (!q.arriveBy && j.leave < q.time) continue;
      j.noCar = !j.legs.some((l) => l.kind === "car");
      add(j);
    }
  }
  // alternatives : une recherche par ligne accessible au départ, pour proposer aussi les lignes plus lentes
  // (ex. voiture + C201 aux 4 Vents quand voiture + C26 ou Rhônexpress est plus rapide)
  if (origin.length && dest.length) {
    const byRoute = new Map();
    for (const acc of origin)
      for (const r of net._stopRoutes[acc[0]] || []) {
        if (q.routeOk && !q.routeOk(r)) continue;
        const cur = byRoute.get(r);
        if (!cur) byRoute.set(r, { t: acc[1], stops: [acc] }); else { cur.stops.push(acc); cur.t = Math.min(cur.t, acc[1]); }
      }
    const have = new Set([...found.values()].map((j) => (j.legs.find((l) => l.kind === "ride") || {}).route));
    const routes = [...byRoute.entries()].filter(([r]) => !have.has(r)).sort((x, y) => x[1].t - y[1].t).slice(0, 15);
    const starts = [];
    if (q.arriveBy) for (let t = q.time - 240; t <= q.time; t += 30) starts.push(t);
    else for (let t = q.time; t <= q.time + 180; t += 30) starts.push(t);
    for (const [r, { stops }] of routes) {
      for (const t0 of starts) {
        const j = csa(net, C, stops, dest, t0, { horizon: 300, maxWalk, only: r });
        if (!j) continue;
        if (q.arriveBy && j.arrive > q.time) continue;
        if (!q.arriveBy && j.leave < q.time) continue;
        j.noCar = !j.legs.some((l) => l.kind === "car");
        j.alt = true;
        add(j);
      }
    }
  }
  add(walkOnly(q.o, q.d, q.time, q.arriveBy, maxWalk));
  if (car !== "none") add(carOnly(q.o, q.d, q.time, q.arriveBy));
  let list = [...found.values()];
  // retire les solutions dominées (partir plus tôt ET arriver plus tard qu'une autre)
  // (une solution sans voiture n'est écartée que par une autre solution sans voiture)
  // (une alternative n'est écartée que par une solution qui commence par la même ligne)
  const firstLine = (j) => (j.legs.find((l) => l.kind === "ride") || {}).route;
  list = list.filter((a) => a.carOnly || !list.some((b) => b !== a && !b.carOnly && (!a.noCar || b.noCar) &&
    (!a.alt || firstLine(a) === firstLine(b)) &&
    b.leave >= a.leave && b.arrive <= a.arrive &&
    (b.leave > a.leave || b.arrive < a.arrive) && b.transfers <= a.transfers));
  if (q.sort === "duration") list.sort((a, b) => a.duration - b.duration || a.arrive - b.arrive);
  else list.sort((a, b) => a.arrive - b.arrive || a.duration - b.duration);
  if (list.length) {
    const firstArr = Math.min(...list.filter((j) => !j.alt).map((j) => j.arrive), Infinity);
    list = list.filter((j) => !j.alt || j.arrive <= firstArr + 120);
  }
  // au plus 3 solutions par enchaînement de lignes, pour laisser de la place aux autres lignes
  const perSig = new Map();
  list = list.filter((j) => {
    const k = j.legs.map((l) => (l.kind === "ride" ? l.route : l.kind === "car" ? "c" : "")).filter(Boolean).join(">");
    perSig.set(k, (perSig.get(k) || 0) + 1);
    return perSig.get(k) <= 3;
  });
  return { journeys: list.slice(0, 12), originStops: origin.length, destStops: dest.length, connections: C.n };
}

export function fmtTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const day = Math.floor(min / 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}${day > 0 ? " (+1 j)" : day < 0 ? " (veille)" : ""}`;
}
export function fmtDur(min) {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

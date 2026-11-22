// Moteur d'itinéraires : Connection Scan Algorithm (CSA) sur les horaires GTFS précalculés.
// Fonctionne dans le navigateur et sous Node (tests).

export const WALK_M_PER_MIN = 75;     // ~4,5 km/h
export const DETOUR = 1.3;            // facteur trajet réel / vol d'oiseau
export const TRANSFER_MIN = 2;        // marge de correspondance
export const FOOTPATH_M = 450;        // correspondance à pied entre arrêts proches
export const ACCESS_M = 2000;         // marche max vers le premier / depuis le dernier arrêt
export const ACCESS_M_EXT = 4500;     // si aucun arrêt dans ACCESS_M (secteurs ruraux)

export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export const walkMin = (m) => Math.max(1, Math.ceil((m * DETOUR) / WALK_M_PER_MIN));

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

/** Arrêts accessibles à pied depuis un point : [[stopIdx, minutes, mètres], …] */
export function accessStops(net, lat, lon, allowedStop) {
  for (const r of [ACCESS_M, ACCESS_M_EXT]) {
    const res = nearbyIdx(net, lat, lon, r)
      .filter((j) => !allowedStop || allowedStop[j])
      .map((j) => {
        const d = distM(lat, lon, net.stops[j][1], net.stops[j][2]);
        return [j, walkMin(d), Math.round(d)];
      });
    if (res.length) {
      // ajoute les arrêts voisins (correspondances à pied) des arrêts trouvés
      const best = new Map(res.map((x) => [x[0], x]));
      for (const [j, w, m] of res)
        for (const [nb, w2, m2] of net._foot[j] || []) {
          const cur = best.get(nb);
          if (!cur || cur[1] > w + w2) best.set(nb, [nb, w + w2, m + m2]);
        }
      return [...best.values()];
    }
  }
  return [];
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
      tripMeta.push({ ti, shift });
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
  const egress = new Map(dest.map(([s, w, m]) => [s, [w, m]]));
  for (const [s, w, m] of origin) {
    if (t0 + w < S[s]) { S[s] = t0 + w; A[s] = t0 + w; J[s] = { kind: "origin", walk: w, m }; }
  }
  let best = Infinity, bestStop = -1;
  for (const [s, [w]] of egress) if (A[s] + w < best) { best = A[s] + w; bestStop = s; }
  const maxT = t0 + (opts.horizon || 360);
  for (let i = lowerBound(C.dep, C.n, t0); i < C.n; i++) {
    const dep = C.dep[i];
    if (dep >= best || dep > maxT) break;
    const tk = C.trip[i];
    if (T[tk] === -1) {
      if (S[C.from[i]] > dep) continue;
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
  const [ew, em] = egress.get(bestStop);
  legs.push({ kind: "walk", from: s, to: "dest", min: ew, m: em });
  while (guard++ < 50) {
    const j = J[s];
    if (!j) return null;
    if (j.kind === "origin") { legs.push({ kind: "walk", from: "origin", to: s, min: j.walk, m: j.m }); break; }
    if (j.kind === "foot") { legs.push({ kind: "walk", from: j.from, to: s, min: j.walk, m: j.m }); s = j.from; continue; }
    const ce = j.enter, cx = j.exit, meta = C.tripMeta[C.trip[ce]];
    const trip = net.trips[meta.ti], pat = net.patterns[trip[0]];
    legs.push({ kind: "ride", trip: meta.ti, route: pat.r, from: C.from[ce], to: C.to[cx], dep: C.dep[ce], arr: C.arr[cx],
      fromPos: C.pos[ce], toPos: C.pos[cx] + 1, headsign: trip[5] || "", resa: !!trip[4] });
    s = C.from[ce];
  }
  legs.reverse();
  return finalize(net, legs, best);
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
    if (out[i].kind === "walk" && out[i].dep === undefined) { const p = out[i - 1]; out[i].dep = p.arr; out[i].arr = p.arr + out[i].min; }
  }
  const arr = out[out.length - 1].arr ?? arrival;
  const sig = rides.map((r) => `${r.trip}:${r.from}:${r.to}`).join("|");
  return { legs: out, leave, arrive: arr, duration: arr - leave, transfers: rides.length - 1, sig };
}

/** Marche directe si la destination est proche. */
export function walkOnly(o, d, t, arriveBy) {
  const m = distM(o.lat, o.lon, d.lat, d.lon);
  if (m > 3000) return null;
  const min = walkMin(m);
  const leave = arriveBy ? t - min : t;
  return { legs: [{ kind: "walk", from: "origin", to: "dest", min, m: Math.round(m), dep: leave, arr: leave + min }],
    leave, arrive: leave + min, duration: min, transfers: 0, sig: "walk" };
}

/**
 * Recherche plusieurs solutions et les classe par durée.
 * q = {o:{lat,lon}, d:{lat,lon}, date:'AAAA-MM-JJ', time: minutes, arriveBy: bool, routeOk(fn), stopOk(fn)}
 */
export function search(net, q) {
  const C = buildDay(net, q.date, q.routeOk);
  const origin = accessStops(net, q.o.lat, q.o.lon);
  const dest = accessStops(net, q.d.lat, q.d.lon);
  const found = new Map();
  const add = (j) => { if (j && (!found.has(j.sig) || found.get(j.sig).duration > j.duration)) found.set(j.sig, j); };
  if (origin.length && dest.length) {
    const starts = [];
    if (q.arriveBy) for (let t = q.time - 300; t <= q.time; t += 10) starts.push(t);
    else for (let t = q.time; t <= q.time + 240; t += 10) starts.push(t);
    for (const t0 of starts) {
      const j = csa(net, C, origin, dest, t0, { horizon: 400 });
      if (!j) continue;
      if (q.arriveBy && j.arrive > q.time) continue;
      if (!q.arriveBy && j.leave < q.time) continue;
      add(j);
    }
  }
  add(walkOnly(q.o, q.d, q.time, q.arriveBy));
  let list = [...found.values()];
  // retire les solutions dominées (partir plus tôt ET arriver plus tard qu'une autre)
  list = list.filter((a) => !list.some((b) => b !== a && b.leave >= a.leave && b.arrive <= a.arrive &&
    (b.leave > a.leave || b.arrive < a.arrive) && b.transfers <= a.transfers));
  if (q.sort === "duration") list.sort((a, b) => a.duration - b.duration || a.arrive - b.arrive);
  else list.sort((a, b) => a.arrive - b.arrive || a.duration - b.duration);
  return { journeys: list.slice(0, 10), originStops: origin.length, destStops: dest.length, connections: C.n };
}

export function fmtTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const day = Math.floor(min / 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}h${String(m % 60).padStart(2, "0")}${day > 0 ? " (+1 j)" : day < 0 ? " (veille)" : ""}`;
}
export function fmtDur(min) {
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

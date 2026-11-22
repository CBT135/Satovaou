#!/usr/bin/env python3
"""Génère web/data/network.json à partir des GTFS publiés sur transport.data.gouv.fr.

Usage :
    python scripts/build_data.py --out web/data
    python scripts/build_data.py --out web/data --local ruban=tests/gtfs/ruban.zip ...

Le script n'utilise que la bibliothèque standard (pas de pip install).
Pour chaque réseau listé dans config/lines.json il :
  1. trouve le jeu de données (slug ou mots-clés du titre) via l'API transport.data.gouv.fr ;
  2. télécharge le GTFS (URL courante, sinon dernière copie archivée) ;
  3. garde seulement les lignes / courses utiles (voir « select ») ;
  4. écrit un JSON compact : arrêts, lignes, calendriers, courses.
Il récupère aussi les vacances scolaires de la zone A (académie de Lyon).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://transport.data.gouv.fr/api/datasets"
HOLIDAYS_API = (
    "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/"
    "fr-en-calendrier-scolaire/records"
)
UA = {"User-Agent": "satovaou-build/1.0 (+https://github.com/cbt135/satovaou)"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- utils
def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "")).upper()


def http_get(url: str, timeout=180) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_time(t: str) -> int | None:
    """'25:10:00' -> minutes depuis minuit (peut dépasser 1440)."""
    if not t:
        return None
    parts = t.strip().split(":")
    if len(parts) < 2:
        return None
    return int(parts[0]) * 60 + int(parts[1]) + (1 if len(parts) > 2 and int(parts[2]) >= 30 else 0)


def read_csv(zf: zipfile.ZipFile, name: str):
    names = {n.split("/")[-1]: n for n in zf.namelist()}
    if name not in names:
        return
    with zf.open(names[name]) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)


# --------------------------------------------------------------------------- datasets
_catalog = None


def catalog():
    global _catalog
    if _catalog is None:
        log("Téléchargement du catalogue transport.data.gouv.fr …")
        _catalog = json.loads(http_get(API, timeout=300))
    return _catalog


def find_datasets(spec: dict) -> list[dict]:
    found = []
    for slug in spec.get("slugs", []):
        try:
            found.append(json.loads(http_get(f"{API}/{slug}")))
            continue
        except Exception as e:  # noqa: BLE001
            log(f"  API /datasets/{slug} : {e} — recherche dans le catalogue")
        try:
            for d in catalog():
                if d.get("slug") == slug:
                    try:  # le détail (avec l'historique) s'obtient par l'identifiant
                        found.append(json.loads(http_get(f"{API}/{d.get('datagouv_id') or d.get('id')}")))
                    except Exception:  # noqa: BLE001
                        found.append(d)
                    break
        except Exception as e:  # noqa: BLE001
            log(f"  catalogue indisponible : {e}")
    if found:
        return found
    maxn = spec.get("max", 1)
    for kw_group in spec.get("title_keywords", []):
        for d in catalog():
            title = (d.get("title") or "").lower()
            if all(k.lower() in title for k in kw_group):
                if any(x.get("id") == d.get("id") for x in found):
                    continue
                if not any((r.get("format") or "").upper() == "GTFS" for r in d.get("resources", [])):
                    continue
                found.append(d)
                if len(found) >= maxn:
                    return found
    return found


def gtfs_urls(ds: dict) -> list[str]:
    """URLs candidates par ordre de préférence : ressource courante puis archives."""
    urls = []
    res = [r for r in ds.get("resources", []) if (r.get("format") or "").upper() == "GTFS"]
    res.sort(key=lambda r: (bool(r.get("is_available", True)), r.get("updated") or ""), reverse=True)
    for r in res:
        for k in ("url", "original_url"):
            if r.get(k):
                urls.append(r[k])
    hist = ds.get("history") or []
    hist = sorted(hist, key=lambda h: (h.get("payload") or {}).get("download_datetime", ""), reverse=True)
    for h in hist:
        p = h.get("payload") or {}
        if (p.get("format") or "GTFS").upper() == "GTFS" and p.get("permanent_url"):
            urls.append(p["permanent_url"])
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def download_gtfs(ds: dict) -> tuple[bytes, str] | None:
    for u in gtfs_urls(ds)[:6]:
        try:
            log(f"  téléchargement {u}")
            data = http_get(u, timeout=600)
            zipfile.ZipFile(io.BytesIO(data)).namelist()
            return data, u
        except Exception as e:  # noqa: BLE001
            log(f"    échec : {e}")
    return None


# --------------------------------------------------------------------------- calendar
def service_dates(zf, start: dt.date, ndays: int) -> dict[str, set[int]]:
    """service_id -> ensemble des jours (offset depuis start) où il circule."""
    out: dict[str, set[int]] = defaultdict(set)
    end = start + dt.timedelta(days=ndays - 1)
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for row in read_csv(zf, "calendar.txt") or []:
        try:
            s = dt.datetime.strptime(row["start_date"], "%Y%m%d").date()
            e = dt.datetime.strptime(row["end_date"], "%Y%m%d").date()
        except (KeyError, ValueError):
            continue
        d = max(s, start)
        while d <= min(e, end):
            if row.get(wd[d.weekday()], "0").strip() == "1":
                out[row["service_id"]].add((d - start).days)
            d += dt.timedelta(days=1)
    for row in read_csv(zf, "calendar_dates.txt") or []:
        try:
            d = dt.datetime.strptime(row["date"], "%Y%m%d").date()
        except (KeyError, ValueError):
            continue
        if d < start or d > end:
            continue
        off = (d - start).days
        if row.get("exception_type", "").strip() == "1":
            out[row["service_id"]].add(off)
        elif row.get("exception_type", "").strip() == "2":
            out[row["service_id"]].discard(off)
    return out


# --------------------------------------------------------------------------- feed processing
class Builder:
    def __init__(self, cfg, start: dt.date, ndays: int):
        self.cfg = cfg
        self.start = start
        self.ndays = ndays
        self.center = cfg["center"]
        self.radius = cfg["radius_km"]
        self.anchors = cfg["anchors"]
        self.stops: list = []          # [name, lat, lon, feedIdx]
        self.routes: list = []
        self.services: list[str] = []  # bitstrings hex
        self.service_index: dict[str, int] = {}
        self.patterns: list = []
        self.pattern_index: dict = {}
        self.trips: list = []
        self.feeds_meta: list = []
        self.loaded_routes: dict = {}

    def service_id(self, days: set[int]) -> int:
        bits = ["0"] * self.ndays
        for d in days:
            bits[d] = "1"
        s = "".join(bits)
        # hex compact : groupes de 4 jours
        s += "0" * (-len(s) % 4)
        h = "".join("%x" % int(s[i:i + 4], 2) for i in range(0, len(s), 4))
        if h not in self.service_index:
            self.service_index[h] = len(self.services)
            self.services.append(h)
        return self.service_index[h]

    def near_anchor(self, lat, lon, names, km):
        return any(haversine_km(lat, lon, *self.anchors[n]) <= km for n in names)

    def process(self, feed: dict, zf: zipfile.ZipFile, meta: dict):
        fidx = len(self.feeds_meta)
        self.feeds_meta.append(meta)
        sel = feed["select"]
        mode = sel["mode"]

        stops = {}
        for r in read_csv(zf, "stops.txt") or []:
            try:
                stops[r["stop_id"]] = (r.get("stop_name", "").strip(), float(r["stop_lat"]), float(r["stop_lon"]),
                                       r.get("parent_station", ""))
            except (KeyError, ValueError):
                continue

        routes = {}
        for r in read_csv(zf, "routes.txt") or []:
            routes[r["route_id"]] = r
        agencies = {a.get("agency_id", ""): (a.get("agency_name") or "").strip() for a in read_csv(zf, "agency.txt") or []}

        wanted_names = {norm(x) for x in sel.get("routes", [])}

        def route_matches_name(r):
            sn, ln = norm(r.get("route_short_name", "")), norm(r.get("route_long_name", ""))
            return sn in wanted_names or any(ln.startswith(w) for w in wanted_names if len(w) >= 3)

        # pass 1 : trips.txt
        trips = {}
        for t in read_csv(zf, "trips.txt") or []:
            if t.get("route_id") in routes:
                trips[t["trip_id"]] = t

        # pré-sélection des courses (évite de charger tout stop_times des gros réseaux)
        if mode in ("near", "trips_near", "routes_or_near"):
            near_ids = {sid for sid, st in stops.items()
                        if self.near_anchor(st[1], st[2], sel["anchors"], sel["km"])}
            near_trips = set()
            for s in read_csv(zf, "stop_times.txt") or []:
                if s.get("stop_id") in near_ids:
                    near_trips.add(s.get("trip_id"))
        else:
            near_trips = set()
        if mode == "trips_near":
            candidate = near_trips
        elif mode == "all":
            candidate = set(trips)
        else:
            ok_routes = {rid for rid, r in routes.items() if mode != "near" and route_matches_name(r)}
            ok_routes |= {trips[t]["route_id"] for t in near_trips if t in trips}
            candidate = {tid for tid, t in trips.items() if t["route_id"] in ok_routes}

        # pass 2 : stop_times regroupés par course (lecture en flux)
        st_by_trip: dict[str, list] = defaultdict(list)
        for s in read_csv(zf, "stop_times.txt") or []:
            tid = s.get("trip_id")
            if tid not in candidate or tid not in trips:
                continue
            dep = parse_time(s.get("departure_time") or s.get("arrival_time"))
            arr = parse_time(s.get("arrival_time") or s.get("departure_time"))
            if dep is None and arr is None:
                continue
            try:
                seq = int(s.get("stop_sequence", 0))
            except ValueError:
                seq = 0
            st_by_trip[tid].append((seq, s["stop_id"], arr if arr is not None else dep, dep if dep is not None else arr,
                                    s.get("pickup_type", "0") or "0", s.get("drop_off_type", "0") or "0"))

        keep_route = {trips[t]["route_id"]: True for t in st_by_trip}
        trip_near_mode = mode == "trips_near"

        cal = service_dates(zf, self.start, self.ndays)
        school_cfg = feed.get("school", {})
        tad_cfg = feed.get("tad", {})
        school_re = re.compile(school_cfg["name_regex"]) if school_cfg.get("name_regex") else None
        tad_re = re.compile(tad_cfg["name_regex"]) if tad_cfg.get("name_regex") else None
        not_school = {norm(x) for x in school_cfg.get("not_routes", [])}

        route_out: dict[str, int] = {}
        stop_out: dict[str, int] = {}
        nkept = 0
        found_names = set()

        def add_route(rid):
            if rid in route_out:
                return route_out[rid]
            r = routes[rid]
            short = (r.get("route_short_name") or "").strip()
            long_ = (r.get("route_long_name") or "").strip()
            label = short or long_
            if school_cfg.get("all"):
                school = True
            elif school_cfg.get("not_routes") is not None:
                school = norm(short) not in not_school
            elif school_re:
                school = bool(school_re.search(short or long_))
            else:
                school = False
            tad = bool(tad_re and tad_re.search(short or long_))
            try:
                rtype = int(r.get("route_type") or 3)
            except ValueError:
                rtype = 3
            agency = agencies.get((r.get("agency_id") or "").strip()) or (r.get("agency_id") or "").strip()
            route_out[rid] = len(self.routes)
            self.routes.append({
                "f": fidx, "s": short, "l": long_, "c": (r.get("route_color") or "").strip()[:6],
                "tc": (r.get("route_text_color") or "").strip()[:6], "t": rtype, "sc": school, "tad": tad,
                "a": agency,
            })
            found_names.add(label)
            return route_out[rid]

        def add_stop(sid):
            if sid in stop_out:
                return stop_out[sid]
            name, lat, lon, _ = stops[sid]
            stop_out[sid] = len(self.stops)
            self.stops.append([name, round(lat, 5), round(lon, 5), fidx])
            return stop_out[sid]

        for tid, sts in st_by_trip.items():
            t = trips[tid]
            rid = t["route_id"]
            days = cal.get(t.get("service_id"), set())
            if not days:
                continue
            sts.sort()
            sts = [x for x in sts if x[1] in stops]
            if len(sts) < 2:
                continue
            if trip_near_mode:
                if not any(self.near_anchor(stops[x[1]][1], stops[x[1]][2], sel["anchors"], sel["km"]) for x in sts):
                    continue
                # coupe les arrêts hors du rayon (on garde les extrémités internes)
                sts = [x for x in sts if haversine_km(stops[x[1]][1], stops[x[1]][2], *self.center) <= self.radius + 5]
                if len(sts) < 2:
                    continue
            elif rid not in keep_route:
                continue
            r = routes[rid]
            dkey = (feed.get("fare"), norm(r.get("route_short_name", "")))
            if dkey[1] and self.loaded_routes.get(dkey, fidx) != fidx:
                continue  # même ligne déjà chargée par un autre jeu de données
            ri = add_route(rid)
            self.loaded_routes[dkey] = fidx
            seq = tuple(add_stop(x[1]) for x in sts)
            pkey = (ri, seq)
            if pkey not in self.pattern_index:
                self.pattern_index[pkey] = len(self.patterns)
                self.patterns.append({"r": ri, "st": list(seq)})
            pidx = self.pattern_index[pkey]
            dep0 = sts[0][3]
            times = []
            for x in sts:
                times.append(max(0, x[2] - dep0))  # arrivée relative
            # réservation : pickup_type 2 (téléphoner à l'agence) ou 3 (au conducteur)
            resa = 1 if any(x[4] in ("2",) for x in sts) else 0
            headsign = (t.get("trip_headsign") or "").strip()
            self.trips.append([pidx, self.service_id(days), dep0, times, resa, headsign])
            nkept += 1

        if feed.get("supplement") and not feed["supplement"].get("only_if_no_gtfs"):
            nkept += self.supplement(feed, fidx, stops, route_out)
        meta.update({"trips": nkept, "routes": sorted(found_names | self._supp_names.pop(fidx, set()))})
        log(f"  {feed['key']} : {nkept} courses, lignes : {', '.join(sorted(found_names))[:300]}")
        missing = [n for n in sel.get("routes", []) if not any(norm(n) == norm(f) for f in found_names)]
        if missing and mode in ("routes", "routes_or_near"):
            meta["missing"] = missing
            log(f"  lignes non trouvées dans ce GTFS : {', '.join(missing)}")

    _supp_names: dict = {}

    def supplement(self, feed, fidx, gtfs_stops, route_out) -> int:
        """Ligne ajoutée à la main (TAD absent du GTFS), voir config « supplement »."""
        sp = feed["supplement"]
        cond = sp.get("skip_if_served_near")
        if cond:
            anchor = self.anchors[cond["anchor"]]
            mine = set(route_out.values())
            for pat in self.patterns:
                if pat["r"] in mine and not self.routes[pat["r"]]["sc"]:
                    if any(haversine_km(self.stops[s][1], self.stops[s][2], *anchor) <= cond["km"] for s in pat["st"]):
                        log("  supplément ignoré : le GTFS dessert déjà ce secteur")
                        return 0
        import unicodedata

        def fold(x):
            return unicodedata.normalize("NFKD", x).encode("ascii", "ignore").decode().lower()

        seq = []
        for spec in sp["stops"]:
            best = None
            for sid, (name, lat, lon, _) in gtfs_stops.items():
                n = fold(name)
                if any(all(w in n for w in alt.split()) for alt in spec["match"]):
                    d = haversine_km(lat, lon, *spec["coord"])
                    if d <= 3 and (best is None or d < best[0]):
                        best = (d, name, lat, lon)
            if best:
                name, lat, lon = best[1], best[2], best[3]
            else:
                name, lat, lon = spec["name"], spec["coord"][0], spec["coord"][1]
                log(f"  supplément : arrêt « {spec['name']} » non trouvé dans le GTFS, coordonnées approximatives")
            idx = len(self.stops)
            for i, s in enumerate(self.stops):
                if s[3] == fidx and s[0] == name and abs(s[1] - lat) < 1e-4 and abs(s[2] - lon) < 1e-4:
                    idx = i
                    break
            else:
                self.stops.append([name, round(lat, 5), round(lon, 5), fidx])
            seq.append(idx)
        r = sp["route"]
        ri = len(self.routes)
        self.routes.append({"f": fidx, "s": r["short"], "l": r["long"], "c": r.get("color", ""), "tc": "", "t": r.get("type", 3),
                            "sc": bool(r.get("school")), "tad": bool(r.get("tad")), "a": feed["label"]})
        self._supp_names.setdefault(fidx, set()).add(r["short"])
        # jours : lundi..dimanche, hors jours fériés
        days = set()
        for off in range(self.ndays):
            d = self.start + dt.timedelta(days=off)
            if sp["days"][d.weekday()] == "1" and not is_public_holiday(d):
                days.add(off)
        svc = self.service_id(days)
        offs = sp["offsets"]
        n = 0
        def expand(direction):
            if sp.get("frequency"):
                fq = sp["frequency"][direction]
                h1, m1 = map(int, fq["from"].split(":"))
                h2, m2 = map(int, fq["to"].split(":"))
                return [f"{t // 60:02d}:{t % 60:02d}" for t in range(h1 * 60 + m1, h2 * 60 + m2 + 1, fq["every"])]
            return sp[direction]

        for direction, times in (("outbound", expand("outbound")), ("inbound", expand("inbound"))):
            st = seq if direction == "outbound" else list(reversed(seq))
            rel = offs if direction == "outbound" else [offs[-1] - o for o in reversed(offs)]
            pkey = (ri, tuple(st))
            self.pattern_index[pkey] = len(self.patterns)
            self.patterns.append({"r": ri, "st": st})
            for t in times:
                h, m = map(int, t.split(":"))
                self.trips.append([self.pattern_index[pkey], svc, h * 60 + m, list(rel), 1 if r.get("tad") else 0, self.stops[st[-1]][0]])
                n += 1
        log(f"  supplément « {r['short']} » : {n} courses")
        return n

    def output(self, holidays):
        return {
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "start": self.start.strftime("%Y-%m-%d"),
            "ndays": self.ndays,
            "center": self.center,
            "radius_km": self.radius,
            "feeds": self.feeds_meta,
            "stops": self.stops,
            "routes": self.routes,
            "services": self.services,
            "patterns": self.patterns,
            "trips": self.trips,
            "holidays": holidays,
        }


def is_public_holiday(d: dt.date) -> bool:
    y = d.year
    a, b, c = y % 19, y // 100, y % 100
    dd, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - dd - g + 15) % 30
    i, k = c // 4, c % 4
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    day = (h + l_ - 7 * m + 114) % 31 + 1
    easter = dt.date(y, month, day)
    fixed = {(1, 1), (5, 1), (5, 8), (7, 14), (8, 15), (11, 1), (11, 11), (12, 25)}
    mobile = {easter + dt.timedelta(days=n) for n in (1, 39, 50)}
    return (d.month, d.day) in fixed or d in mobile


# --------------------------------------------------------------------------- holidays
def fetch_holidays():
    """Vacances zone A (académie de Lyon) : [[début, reprise, libellé], …] dates ISO, intervalle [début, reprise[."""
    try:
        q = {
            "where": 'location="Lyon" and end_date>="%s"' % (dt.date.today() - dt.timedelta(days=400)).isoformat(),
            "limit": "100",
            "order_by": "start_date",
        }
        data = json.loads(http_get(HOLIDAYS_API + "?" + urllib.parse.urlencode(q), timeout=60))
        out = {}
        for r in data.get("results", []):
            if r.get("population") not in (None, "-", "Élèves"):
                continue
            # les dates de l'API sont en UTC la veille à 22h/23h : on les ramène au jour local suivant si besoin
            def local_day(s):
                t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
                return (t + dt.timedelta(hours=3)).date().isoformat()
            s, e = local_day(r["start_date"]), local_day(r["end_date"])
            out[(s, e)] = r.get("description", "Vacances")
        res = [[s, e, d] for (s, e), d in sorted(out.items())]
        if res:
            return res
    except Exception as e:  # noqa: BLE001
        log(f"Vacances scolaires : API indisponible ({e}), la page utilisera sa liste intégrée")
    return []


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "data"))
    ap.add_argument("--config", default=os.path.join(ROOT, "config", "lines.json"))
    ap.add_argument("--local", nargs="*", default=[], help="clé=chemin.zip pour utiliser un GTFS local")
    ap.add_argument("--start", help="date de début AAAA-MM-JJ (défaut : hier)")
    ap.add_argument("--only-local", action="store_true", help="ne rien télécharger")
    args = ap.parse_args()

    cfg = json.load(open(args.config, encoding="utf-8"))
    local = dict(x.split("=", 1) for x in args.local)
    start = dt.date.fromisoformat(args.start) if args.start else dt.date.today() - dt.timedelta(days=1)
    b = Builder(cfg, start, cfg.get("date_window_days", 120))

    for feed in cfg["feeds"]:
        log(f"== {feed['label']}")
        metas = []
        if feed["key"] in local:
            metas.append(({"key": feed["key"], "label": feed["label"], "source": local[feed["key"]]},
                          open(local[feed["key"]], "rb").read()))
        elif args.only_local:
            if feed.get("supplement", {}).get("only_if_no_gtfs") and feed["key"] not in local:
                fidx = len(b.feeds_meta)
                meta = {"key": feed["key"], "label": feed["label"], "status": "ok", "source": "horaires de principe",
                        "fare": feed.get("fare"), "warning": feed.get("warning")}
                b.feeds_meta.append(meta)
                meta["trips"] = b.supplement(feed, fidx, {}, {})
                meta["routes"] = sorted(b._supp_names.pop(fidx, set()))
            continue
        else:
            try:
                dss = find_datasets(feed["datasets"])
            except Exception as e:  # noqa: BLE001
                log(f"  recherche impossible : {e}")
                dss = []
            if not dss and feed.get("urls"):
                dss = [{"slug": None, "title": feed["label"], "resources": [{"format": "GTFS", "url": u} for u in feed["urls"]]}]
            elif dss and feed.get("urls"):
                for ds in dss:  # URL directe en dernier recours
                    ds.setdefault("resources", []).extend({"format": "GTFS", "url": u, "is_available": False} for u in feed["urls"])
            if not dss:
                log("  aucun jeu de données trouvé")
                if feed.get("supplement", {}).get("only_if_no_gtfs"):
                    fidx = len(b.feeds_meta)
                    meta = {"key": feed["key"], "label": feed["label"], "status": "ok",
                            "source": "horaires de principe (config/lines.json)", "fare": feed.get("fare"), "warning": feed.get("warning")}
                    b.feeds_meta.append(meta)
                    meta["trips"] = b.supplement(feed, fidx, {}, {})
                    meta["routes"] = sorted(b._supp_names.pop(fidx, set()))
                else:
                    b.feeds_meta.append({"key": feed["key"], "label": feed["label"], "status": "introuvable"})
                continue
            for ds in dss:
                got = download_gtfs(ds)
                if not got:
                    b.feeds_meta.append({"key": feed["key"], "label": feed["label"], "status": "téléchargement impossible",
                                         "dataset": ds.get("slug")})
                    continue
                metas.append(({"key": feed["key"], "label": feed["label"], "dataset": ds.get("slug"),
                               "title": ds.get("title"), "source": got[1]}, got[0]))
        for meta, blob in metas:
            meta["status"] = "ok"
            meta["warning"] = feed.get("warning")
            meta["fare"] = feed.get("fare")
            try:
                b.process(feed, zipfile.ZipFile(io.BytesIO(blob)), meta)
            except Exception as e:  # noqa: BLE001
                meta["status"] = f"erreur : {e}"
                log(f"  erreur de lecture : {e}")

    holidays = [] if args.only_local else fetch_holidays()
    os.makedirs(args.out, exist_ok=True)
    out = b.output(holidays)
    path = os.path.join(args.out, "network.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    log(f"Écrit {path} : {len(out['stops'])} arrêts, {len(out['routes'])} lignes, {len(out['trips'])} courses, "
        f"{os.path.getsize(path) / 1e6:.1f} Mo")


if __name__ == "__main__":
    main()

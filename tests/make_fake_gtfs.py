#!/usr/bin/env python3
"""Crée de petits GTFS fictifs (coordonnées approximatives) pour tester la chaîne
build_data.py -> network.json -> moteur d'itinéraires, sans accès réseau.
Ces données ne sont PAS publiées : le site utilise les vrais GTFS générés par le workflow."""
import csv
import io
import os
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "gtfs")


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}:00"


def feed(name, stops, routes, trips, cal_days="1111110"):
    """trips : [(route_id, [(stop_id, minute)], pickup)]"""
    files = {}

    def w(fn, header, rows):
        s = io.StringIO()
        wr = csv.writer(s)
        wr.writerow(header)
        wr.writerows(rows)
        files[fn] = s.getvalue()

    w("agency.txt", ["agency_id", "agency_name", "agency_url", "agency_timezone"], [["A", name, "https://example.org", "Europe/Paris"]])
    w("stops.txt", ["stop_id", "stop_name", "stop_lat", "stop_lon"], [[k, v[0], v[1], v[2]] for k, v in stops.items()])
    w("routes.txt", ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color"],
      [[r[0], "A", r[1], r[2], r[3], r[4] if len(r) > 4 else ""] for r in routes])
    w("calendar.txt", ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
      [["S", *cal_days, "20260101", "20271231"]])
    trows, strows = [], []
    for i, (rid, sts, pick) in enumerate(trips):
        tid = f"{rid}_{i}"
        trows.append([rid, "S", tid, sts[-1][0]])
        for seq, (sid, m) in enumerate(sts):
            strows.append([tid, hhmm(m), hhmm(m), sid, seq + 1, pick, 0])
    w("trips.txt", ["route_id", "service_id", "trip_id", "trip_headsign"], trows)
    w("stop_times.txt", ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "pickup_type", "drop_off_type"], strows)
    os.makedirs(OUT, exist_ok=True)
    with zipfile.ZipFile(os.path.join(OUT, f"{name}.zip"), "w") as z:
        for fn, c in files.items():
            z.writestr(fn, c)


def every(start, end, step):
    return range(start, end + 1, step)


# Ruban : TAD Péri zone E (Satolas -> La Verpillière gare) + bus scolaire
feed("ruban",
     {"SAT": ("Satolas Place", 45.6935, 5.1305), "CHAF": ("Le Chaffard", 45.6750, 5.1180),
      "LVG": ("La Verpillière Gare", 45.6327, 5.1424), "ECO": ("Satolas École", 45.6940, 5.1290)},
     [("PERI", "1390", "Ruban Péri zone E", 3), ("SATS", "SATOLA", "Satolas scolaire", 3)],
     [("PERI", [("SAT", m), ("CHAF", m + 5), ("LVG", m + 15)], 2) for m in (405, 555, 675, 855, 975, 1095)] +
     [("PERI", [("LVG", m), ("CHAF", m + 10), ("SAT", m + 15)], 2) for m in (525, 645, 825, 945, 1065, 1185)] +
     [("SATS", [("CHAF", 490), ("ECO", 500)], 0)])

feed("sncf",
     {"LV": ("La Verpillière", 45.6327, 5.1424), "SQF": ("Saint-Quentin-Fallavier", 45.6443, 5.1105),
      "JM": ("Lyon Jean Macé", 45.7457, 4.8423), "PD": ("Lyon Part-Dieu", 45.7606, 4.8597),
      "GR": ("Grenoble", 45.1913, 5.7146), "LYS": ("Lyon Saint-Exupéry TGV", 45.7206, 5.0758),
      "BJ": ("Bourgoin-Jallieu", 45.5860, 5.2740)},
     [("TERO", "TER", "Lyon Jean Macé - Bourgoin", 2), ("TERG", "TER", "Lyon Part-Dieu - Grenoble", 2),
      ("TGV", "TGV INOUI", "Lyon Saint-Exupéry - Grenoble", 2)],
     [("TERO", [("BJ", m), ("LV", m + 9), ("SQF", m + 14), ("JM", m + 33)], 0) for m in every(360, 1260, 60)] +
     [("TERO", [("JM", m), ("SQF", m + 19), ("LV", m + 24), ("BJ", m + 33)], 0) for m in every(361, 1261, 60)] +
     [("TERG", [("PD", m), ("LV", m + 18), ("BJ", m + 26), ("GR", m + 85)], 0) for m in every(390, 1290, 60)] +
     [("TERG", [("GR", m), ("BJ", m + 59), ("LV", m + 67), ("PD", m + 85)], 0) for m in every(380, 1280, 60)] +
     [("TGV", [("LYS", m), ("GR", m + 63)], 0) for m in (550, 850, 1270)])

feed("tcl",
     {"COL": ("Colombier Les Salines", 45.7180, 5.1030), "SLM": ("Maréchal Juin", 45.6870, 5.0450),
      "GB": ("Grange Blanche", 45.7430, 4.8790), "PAN": ("Meyzieu Les Panettes", 45.7790, 5.0330),
      "MZI": ("Meyzieu ZI", 45.7760, 5.0160), "SOIE": ("Vaulx-en-Velin La Soie", 45.7610, 4.9210),
      "PDV": ("Part-Dieu Villette", 45.7598, 4.8608), "AER": ("Aéroport Gare routière", 45.7212, 5.0805),
      "GBD": ("Grange Blanche (métro D)", 45.7428, 4.8792), "SAXD": ("Saxe - Gambetta", 45.7536, 4.8473),
      "GUID": ("Guillotière", 45.7550, 4.8424), "BELD": ("Bellecour (D)", 45.7578, 4.8327),
      "BELA": ("Bellecour (A)", 45.7581, 4.8332), "AMPA": ("Ampère - Victor Hugo", 45.7531, 4.8291),
      "PERA": ("Perrache", 45.7489, 4.8262)},
     [("1E", "1E", "Colombier-Saugnieu - Grange Blanche", 3), ("T3", "T3", "Meyzieu - Part-Dieu", 0),
      ("248", "248", "Meyzieu ZI - Aéroport - Saint-Laurent-de-Mure", 3),
      ("MD", "D", "Métro D Gare de Vénissieux - Gare de Vaise", 1), ("MA", "A", "Métro A Perrache - Vaulx La Soie", 1)],
     [("1E", [("COL", m), ("SLM", m + 11), ("GB", m + 34)], 0) for m in every(300, 1320, 20)] +
     [("1E", [("GB", m), ("SLM", m + 23), ("COL", m + 34)], 0) for m in every(310, 1330, 20)] +
     [("T3", [("PAN", m), ("MZI", m + 2), ("SOIE", m + 12), ("PDV", m + 22)], 0) for m in every(300, 1410, 10)] +
     [("248", [("MZI", m), ("AER", m + 14), ("SLM", m + 25)], 0) for m in every(330, 1320, 30)] +
     [("MD", [("GBD", m), ("SAXD", m + 4), ("GUID", m + 6), ("BELD", m + 9)], 0) for m in every(300, 1440, 4)] +
     [("MD", [("BELD", m), ("GUID", m + 3), ("SAXD", m + 5), ("GBD", m + 9)], 0) for m in every(300, 1440, 4)] +
     [("MA", [("BELA", m), ("AMPA", m + 2), ("PERA", m + 4)], 0) for m in every(300, 1440, 4)] +
     [("MA", [("PERA", m), ("AMPA", m + 2), ("BELA", m + 4)], 0) for m in every(300, 1440, 4)])

feed("rhonexpress",
     {"RXA": ("Aéroport Saint-Exupéry", 45.7208, 5.0790), "RXM": ("Meyzieu ZI", 45.7762, 5.0165),
      "RXS": ("Vaulx-en-Velin La Soie", 45.7612, 4.9215), "RXP": ("Part-Dieu Villette", 45.7600, 4.8610)},
     [("RX", "RX", "Rhônexpress", 0)],
     [("RX", [("RXA", m), ("RXM", m + 11), ("RXS", m + 20), ("RXP", m + 28)], 0) for m in every(285, 1440, 15)])

feed("cre",
     {"LUZ": ("Luzais Parking", 45.6290, 5.1050), "GBX": ("Lyon Grange Blanche", 45.7425, 4.8795),
      "VF": ("Villefontaine Gare routière", 45.6130, 5.1500)},
     [("X06", "X06", "Express Villefontaine - Lyon", 3), ("X07", "X07", "Express Bourgoin - Lyon", 3)],
     [("X06", [("VF", m), ("LUZ", m + 8), ("GBX", m + 35)], 0) for m in every(360, 1170, 30)] +
     [("X07", [("LUZ", m), ("GBX", m + 27)], 0) for m in every(375, 1155, 30)])

feed("flixbus",
     {"FXA": ("Lyon Saint-Exupéry Aéroport", 45.7215, 5.0811), "FXG": ("Grenoble Gare routière", 45.1915, 5.7150)},
     [("FX", "N700", "Lyon Airport - Grenoble", 3)],
     [("FX", [("FXA", m), ("FXG", m + 60)], 0) for m in every(390, 1410, 60)], cal_days="1111111")

print("GTFS fictifs écrits dans", OUT)

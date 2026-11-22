# Satovaou

Recherche d'itinéraires en transports en commun **depuis et vers Satolas-et-Bonce** (et Colombier-Saugnieu, Saint-Quentin-Fallavier, La Verpillière, l'aéroport Lyon Saint-Exupéry, Meyzieu Les Panettes), vers des destinations à moins de 100 km.

Appli web qui fonctionne sur PC, Mac et téléphone. Sur téléphone, on peut l'installer sur l'écran d'accueil : « Partager > Sur l'écran d'accueil » sur iPhone, « Installer l'application » sur Android.

## Fonctionnalités

- Carte IGN (Plan IGN v2) ou photo aérienne, au choix dans le sélecteur de couches.
- Départ et arrivée : clic sur la carte, adresse (géocodeur IGN), arrêt, ou raccourcis. Bouton ⇅ pour inverser. Marqueurs déplaçables.
- Jour et heure, au choix « Partir à » ou « Arriver avant ».
- Solutions triées par **arrivée la plus tôt** ou par **durée la plus courte**.
- **Voiture** au départ, à l'arrivée ou les deux. On se gare à une gare, un arrêt de tram, un car express ou un transport à la demande, dans un rayon de 30 km. Un trajet tout en voiture est aussi proposé. Durées estimées hors trafic, coût ~0,15 €/km.
- **Marche plafonnée par étape** (20 min par défaut, réglable de 5 à 30 min) : vers le premier arrêt, depuis le dernier, et en correspondance. Les solutions qui dépassent sont éliminées.
- Survoler une solution la trace sur la carte ; cliquer dessus l'affiche en détail avec le tracé.
- Temps de marche calculé (vol d'oiseau × 1,3 à 4,5 km/h) :
  - vers le premier arrêt et depuis le dernier ;
  - entre deux arrêts en correspondance.
- Bouton **« Réservé aux jeunes (transport scolaire) »** : ajoute les lignes scolaires (Cars Région, Ruban, TCL Junior Direct). Elles sont automatiquement exclues pendant les vacances de la **zone A**, les jours fériés et le dimanche.
- Coût estimé selon le profil (adulte, 18–25, 11–17, 4–10, < 4 ans, élève) en trois colonnes :
  - trajet occasionnel ;
  - semaine (5 allers-retours) ;
  - mois (22 allers-retours).

  Pour la semaine et le mois, c'est le moins cher entre tickets ou carnets et abonnements (Pass 7 jours, abonnement mensuel, illico…).
- Alertes : réservation obligatoire pour le transport à la demande, ligne scolaire, FlixBus interdit aux moins de 16 ans non accompagnés, fin de BlaBlaCar Bus.
- Arrêts de toutes les lignes affichés et filtrables par réseau.
- Rhônexpress : le GTFS publié date de 2023. Sans GTFS à jour, l'appli utilise des horaires de principe (toutes les 15 min). La ligne Ruban Péri zone E est ajoutée d'après les horaires de la mairie quand elle manque au GTFS.

## Données

Horaires : fichiers GTFS publiés sur [transport.data.gouv.fr](https://transport.data.gouv.fr) (licence ODbL) pour :

- Ruban ;
- TCL, réseau complet (métro, tram, bus, Junior Direct), pour les correspondances dans la métropole de Lyon ;
- M réso / TAG, réseau complet de Grenoble, pour les correspondances à l'arrivée ;
- Rhônexpress ;
- Cars Région Express, Cars Région Isère (lignes T et X : Crémieu, Saint-Jean-de-Bournay, La Côte-Saint-André, Vienne, Voiron–Chambéry…) et Cars Région Ain (A71 Montluel, A32 et A11 Meximieux…) ;
- Synchro Bus (Chambéry), L'va (Vienne), Colibri (Miribel) et TICO (Montluel) ;
- SNCF (TER, TGV), y compris les trains de Chambéry, Vienne, Montluel, Miribel et Meximieux ;
- FlixBus et BlaBlaCar Bus.

Les lignes retenues sont celles du tableau « Transports en commun – Satolas-et-Bonce et alentours ». Elles sont définies dans [`config/lines.json`](config/lines.json) : pour ajouter une ligne, ajoutez son numéro dans `routes`.

Le workflow GitHub **Déploiement** tourne à chaque push, chaque lundi et à la demande. Il :

1. télécharge les GTFS (et, si un lien est cassé, la dernière copie archivée par transport.data.gouv.fr) ;
2. garde les lignes utiles et produit `web/data/network.json` ;
3. récupère les vacances scolaires zone A (académie de Lyon) ;
4. publie le site sur GitHub Pages.

Le résumé du workflow indique, réseau par réseau, les lignes trouvées et celles absentes du GTFS.

## Mise en route (une seule fois)

1. Dans le dépôt : **Settings > Pages > Build and deployment > Source : GitHub Actions**.
2. Onglet **Actions > Déploiement > Run workflow**.
3. Le site est alors en ligne à l'adresse `https://cbt135.github.io/Satovaou/`.

## Développement local

```bash
python scripts/build_data.py --out web/data       # horaires réels (connexion internet nécessaire)
cd web && python -m http.server 8000              # puis http://localhost:8000
```

Tests sans réseau, avec des GTFS fictifs :

```bash
python tests/make_fake_gtfs.py
python scripts/build_data.py --only-local --start 2026-11-22 --out /tmp/fake \
  --local ruban=tests/gtfs/ruban.zip sncf=tests/gtfs/sncf.zip tcl=tests/gtfs/tcl.zip \
          rhonexpress=tests/gtfs/rhonexpress.zip cri38=tests/gtfs/cre.zip flixbus=tests/gtfs/flixbus.zip
node tests/router.test.mjs /tmp/fake/network.json
```

## Structure

| Fichier | Rôle |
|---|---|
| `scripts/build_data.py` | GTFS → `network.json` (bibliothèque standard Python uniquement) |
| `config/lines.json` | réseaux, lignes du tableau, lignes scolaires |
| `web/js/router.js` | calcul d'itinéraires (Connection Scan Algorithm) |
| `web/js/fares.js` | estimation des coûts (occasionnel, semaine, mois) |
| `web/js/calendar.js` | vacances zone A et jours fériés |
| `web/js/app.js` | interface (carte Leaflet + IGN) |

Les durées et les coûts sont indicatifs. Vérifiez auprès des transporteurs, en particulier pour le transport à la demande Ruban Péri, à réserver la veille avant 19h30 au 04 74 94 62 03.

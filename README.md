# App de conducció i BFF de mobilitat

Aplicació mòbil per preparar i seguir serveis d’autobús sobre la xarxa integrada de transport. El repositori inclou una app Expo/React Native orientada a iPhone i un Backend-for-Frontend FastAPI que agrega GTFS estàtic, GTFS-Realtime i informació de trànsit.

<p align="center">
  <img src="docs/screenshots/home.png" width="22%" alt="Selecció de línia i preferències locals">
  &nbsp;
  <img src="docs/screenshots/routes.png" width="22%" alt="Catàleg complet de línies">
  &nbsp;
  <img src="docs/screenshots/settings.png" width="22%" alt="Configuració d’idioma i vehicle">
  &nbsp;
  <img src="docs/screenshots/map.png" width="22%" alt="Navegació sobre el mapa fosc">
</p>

## Què permet fer

- Cercar i filtrar 1.000+ serveis per operador, codi o destinació.
- Entrar amb una animació de sincronització i passar a un mode de cerca dedicat.
- Consultar un catàleg complet de línies en una pantalla independent.
- Guardar favorites en una llista scrollable i fins a quatre rutes recents localment, sense compte d’usuari.
- Prioritzar les línies amb parades més properes quan hi ha permís d’ubicació.
- Canviar tota la interfície entre català i castellà.
- Personalitzar el vehicle del mapa amb quatre accents validats.
- Seleccionar sentit, sortida programada i vehicle abans d’iniciar el servei.
- Navegar sobre un mapa fosc amb ruta, parades, posició projectada, edificis 3D i trànsit.
- Treballar en retrat i horitzontal respectant les safe areas de l’iPhone.

Les preferències es desen amb AsyncStorage, estan versionades, validades i limitades de mida. No s’hi desa cap dada sensible ni credencial d’usuari. La ubicació només s’utilitza en memòria per calcular proximitat: l’app l’arrodoneix abans d’enviar-la al BFF i ni el client ni Redis la persisteixen.

## Arquitectura

```text
ATM GTFS / GTFS-RT          TomTom Traffic
          \                    /
           \                  /
            v                v
         FastAPI BFF  <-->  Redis
              |
              | HTTPS + X-API-Key
              | WebSocket /api/v1/ws/live
              v
       Expo / React Native
       iPhone portrait + landscape
```

### App mòbil

- Expo SDK 57 i React Native 0.86.
- React Navigation amb pantalles d’inici, catàleg, configuració i mapa.
- MapLibre Native amb CARTO i Esri World Imagery.
- Cache local acotada per a favorites i recents.
- Peticions amb timeout, validació d’identificadors i HTTPS obligatori fora de desenvolupament.

### BFF

- FastAPI amb respostes ORJSON.
- Redis per a geometries, metadades i dades en temps real.
- Autenticació HTTP i WebSocket mitjançant `X-API-Key`.
- Rate limiting, límits de WebSocket i validació de payloads.
- Càrrega GTFS en segon pla per no bloquejar l’arrencada.

## Estructura del repositori

```text
app-conductor/             App Expo / React Native
  src/screens/             Inici, catàleg, configuració i mapa
  src/services/            API, presentació i preferències locals
app/                       BFF FastAPI
  api/v1/                  GTFS, GTFS-RT, trànsit i WebSocket
  services/                Ingesta, normalització i cache
tests/                     Proves del backend
docs/screenshots/          Captures reals de l’iPhone Simulator
docs/design/               Handoff vectorial del vehicle
```

## Model del vehicle

El marcador del bus és programàtic i no depèn d’una malla 3D. El handoff de disseny inclou les vistes superior, lateral, frontal i posterior, les proporcions i les quatre variants d’accent:

- [SVG editable](docs/design/bus-vehicle-model.svg)
- [Previsualització PNG](docs/design/bus-vehicle-model.png)

## Requisits

- Python 3.12 o superior.
- Node.js i npm.
- Redis local o Docker.
- Xcode amb un iPhone Simulator per executar iOS.

## Configuració

El BFF necessita una clau de desenvolupament a l’entorn:

```ini
BFF_API_KEY=replace-with-a-development-key
REDIS_URL=redis://localhost:6379/0
```

Configura la mateixa clau a l’app:

```bash
cp app-conductor/.env.example app-conductor/.env.local
```

`EXPO_PUBLIC_BFF_API_KEY` queda inclosa al bundle i no s’ha de considerar un secret. En producció cal utilitzar HTTPS/WSS i un mecanisme d’autenticació de client adequat.

## Execució local

Instal·la el backend i inicia Redis:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
redis-server
```

En un altre terminal, inicia el BFF:

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Instal·la i executa l’app:

```bash
cd app-conductor
npm install
npx expo start --dev-client --host lan --port 8081
```

## API principal

Tots els endpoints de dades requereixen `X-API-Key`.

- `GET /api/v1/gtfs/routes`
- `POST /api/v1/gtfs/routes/nearby`
- `GET /api/v1/gtfs/shapes/{route_id}`
- `GET /api/v1/gtfs/stops/{route_id}`
- `GET /api/v1/gtfs/routes/{route_id}/upcoming-trips`
- `GET /api/v1/atm_rt/vehicles/{route_id}`
- `GET /api/v1/atm_rt/trips/{route_id}`
- `GET /api/v1/traffic/summary`
- `WS /api/v1/ws/live`

Swagger UI està disponible a `http://localhost:8000/docs` durant el desenvolupament.

## Verificació

```bash
cd app-conductor && npx tsc --noEmit
cd .. && .venv/bin/python -m pytest -q
git diff --check
```

## Funcionament del servidor BFF

```text
                              +--------------------+
                              | ATM T-mobilitat    |
                              | (Production API)   |
                              +---------+----------+
                                        |
      +---------------------------------+---------------------------------+
      |                                 |                                 |
      v                                 v                                 v
+----------------+              +----------------+                +----------------+
|  Static GTFS   |              | GTFS-RT Feeds  |                | GTFS-RT Feeds  |
|  (ZIP Load)    |              | (TripUpdates,  |                | (Alerts)       |
|    Daily       |              |  Vehicles)     |                |                |
+-------+--------+              +-------+--------+                +-------+--------+
        |                               |                                 |
        |     +-------------------------v---------------------------+     |
        |     |                   Workers (30s)                     |     |
        |     |   (Downloads via curl to bypass Imperva WAF)        |     |
        |     +-------------------------+---------------------------+     |
        |                               |                                 |
        v                               v                                 v
+----------------------------------------------------------------------------------+
|                                    Redis Cache                                   |
|   (Shapes, Meta, Trip Updates, Vehicle Positions, Service Alerts, Geometries)    |
+---------------------------------------+------------------------------------------+
                                        |
+---------------------------------------v------------------------------------------+
|                                 FastAPI Gateway                                  |
|                               (Backend-For-Frontend)                             |
+---------+-------------------+--------------------+--------------------+----------+
          |                   |                    |                    |
          v                   v                    v                    v
  [ /api/v1/gtfs/* ] [ /api/v1/atm_rt/* ] [ /api/v1/merged/* ] [ /ws/v1/route/{id} ]
          |                   |                    |                    |
          +-------------------+--------------------+--------------------+
                                        |
                                        v
                              +--------------------+
                              | Tablet Application |
                              +--------------------+
```

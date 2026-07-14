# Proves remotes temporals

Aquest perfil permet provar l’app des d’un iPhone fora de la xarxa domèstica sense publicar directament Uvicorn, Redis ni Metro. No substitueix el desplegament de producció ni l’autenticació amb App Attest descrits al README.

## Abans d’obrir els ports

1. Regenera qualsevol token de DuckDNS que hagi aparegut en una captura o un xat. No el desis al repositori ni el posis en una ordre que acabi a l’historial del terminal.
2. Reserva `192.168.1.105` per al Mac al DHCP del router. Si l’adreça local del Mac canvia, actualitza les dues regles del router.
3. Mantén el BFF escoltant només a `127.0.0.1:8000`, Redis només en local o a la xarxa privada de Docker, i Metro fora del port forwarding.
4. Utilitza claus diferents i d’alta entropia per a `BFF_API_KEY` i `RATE_LIMIT_HASH_KEY`. La clau `EXPO_PUBLIC_BFF_API_KEY` queda dins del bundle i només és una barrera per a proves controlades.

El Redis local actual no té autenticació, així que aquest perfil manté deliberadament `ENVIRONMENT=development`: és una prova controlada i temporal, no un perfil de producció. En aquest mode la validació fail-fast de producció no s’executa i el rate limit falla obert si Redis cau. No deixis els ports oberts sense supervisió i atura Caddy immediatament si `/health/ready` deixa de respondre `200`.

Per al BFF local, ajusta `.env`:

```ini
ENVIRONMENT=development
SERVER_HOST=127.0.0.1
DOCS_ENABLED=false
TRUSTED_HOSTS=alvolant.duckdns.org,localhost,127.0.0.1
CORS_ALLOWED_ORIGINS=
FORWARDED_ALLOW_IPS=127.0.0.1
RATE_LIMIT_HASH_KEY=un-secret-diferent-i-aleatori-de-com-a-minim-32-caracters
```

Inicia’l amb el launcher endurit, que aplica límits de concurrència, confia només en el proxy configurat i desactiva l’access log d’Uvicorn:

```bash
.venv/bin/python -m app.server
```

## Proxy HTTPS

Instal·la Caddy i valida la configuració versionada:

```bash
brew install caddy
caddy validate --config deploy/Caddyfile --adapter caddyfile
```

Al router, substitueix la regla HTTP antiga i crea exactament aquestes dues regles **TCP** cap al Mac:

| Port públic | Port intern | IP interna |
| ---: | ---: | --- |
| 80 | 8080 | `192.168.1.105` |
| 443 | 8443 | `192.168.1.105` |

No obris `8000`, `6379` ni `8081`. Tampoc cal obrir UDP 443: aquest perfil limita Caddy a HTTP/1.1 i HTTP/2. Si el router permet desactivar UPnP, fes-ho perquè cap procés pugui crear regles noves automàticament.

Si `443` encara mostra el certificat o la pàgina del router, desactiva l’administració HTTPS des de WAN o mou-la a un altre port abans de crear la regla. Al Mac, ves a **Configuració del Sistema → Xarxa → Firewall → Opcions** i permet connexions entrants per a Caddy. Mantén bloquejades les connexions entrants de Python/Uvicorn, Redis i Node/Metro.

Amb el BFF ja actiu, inicia el proxy des de l’arrel del repositori:

```bash
caffeinate -i caddy run --config deploy/Caddyfile --adapter caddyfile
```

Caddy escolta als ports interns no privilegiats 8080/8443, obté i renova el certificat de `alvolant.duckdns.org`, redirigeix HTTP a HTTPS, elimina la documentació pública i envia el trànsit a `127.0.0.1:8000`. `caffeinate` evita que el repòs del Mac talli la prova; deixa aquest terminal obert i atura’l amb `Ctrl+C`. No s’ha activat l’access log ni a Caddy ni al launcher del BFF per evitar conservar rutes i metadades de les proves.

Per aplicar un canvi des d’un segon terminal:

```bash
caddy reload --config deploy/Caddyfile --adapter caddyfile
```

## Configuració de l’iPhone

Quan `https://alvolant.duckdns.org/health` respongui correctament des de dades mòbils, configura `app-conductor/.env.local` i reinicia Metro perquè Expo torni a generar el bundle:

```ini
EXPO_PUBLIC_BFF_URL=https://alvolant.duckdns.org
EXPO_PUBLIC_BFF_API_KEY=la-mateixa-clau-de-proves-del-bff
```

```bash
cd app-conductor
npx expo start --dev-client --host lan --port 8081 --clear
```

Metro continua sent local: per instal·lar o recarregar el bundle cal estar a la mateixa LAN. Un cop la build ja conté l’URL HTTPS, les crides al BFF sí que funcionen des de fora.

## Comprovacions

Fes-les des d’una xarxa externa, per exemple l’iPhone amb Wi-Fi desactivat, perquè alguns routers no suporten NAT loopback:

```bash
curl --fail --show-error https://alvolant.duckdns.org/health
curl --fail --show-error https://alvolant.duckdns.org/health/ready
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://alvolant.duckdns.org/docs
```

Les dues primeres ordres han de retornar l’estat del servei i la darrera, `404`. Si el certificat no es pot emetre, comprova que el DNS encara apunta a la IP pública actual i que els ports públics 80 i 443 arriben respectivament als ports interns 8080 i 8443.

L’adreça pública pot canviar. DuckDNS permet actualitzar-la amb HTTPS, però configura l’actualitzador només després de regenerar el token exposat i desa el token al clauer del sistema o al gestor de secrets del router; no el passis pel xat ni el versionis.

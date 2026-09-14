# Hello Friend Backend

Backend applicatif separe du frontend et du SFU. Il porte le plan de controle, les sessions
anonymes, le chat temps reel durable, la coordination E2EE et l'integration SFU.

## Etat actuel

La fondation technique fournit trois processus independants (`api`, `realtime`, `worker`), une
configuration stricte, des health checks, des erreurs RFC 9457, des metriques et un shutdown borne.
Le socle PostgreSQL/Redis fournit aussi les secrets par fichier, un pool borne par processus, une
unite de travail transactionnelle, des migrations checksumees/verrouillees et trois connexions Redis
separees. Les transactions idempotentes de creation et de jointure anonyme sont implementees avec
capacites HMAC versionnees, sessions opaques, cookie HttpOnly, controle Origin/Fetch Metadata,
quotas Redis fermes en cas de panne, audit et outbox atomiques. Les modules metier suivent
`02-specification-architecture-backend.md` sans dependance de production simulee.

## Prerequis

- Node.js 24 LTS
- npm 11+
- Docker avec Compose pour les tests PostgreSQL/Redis locaux

## Commandes

```bash
npm ci
npm run check
npm run dev:api
npm run dev:realtime
npm run dev:worker
```

Les ports locaux par defaut sont `3000`, `3001` et `3002`. En production, `APP_ROLE` doit
correspondre au point d'entree lance et toutes les origines publiques doivent utiliser HTTPS/WSS.

## Infrastructure locale

Les identifiants de `compose.yaml` sont exclusivement locaux. Les services ne sont publies que sur
la boucle locale. Redis est ephemere et utilise `noeviction`; PostgreSQL utilise un volume nomme.

```bash
docker compose up -d --wait postgres redis

export DATABASE_ENABLED=true
export DATABASE_DIRECT_URL='postgresql://hello_friend_owner:hello_friend_local_only@127.0.0.1:5432/hello_friend'
npm run migrate

export DATABASE_URL="$DATABASE_DIRECT_URL"
export REDIS_ENABLED=true
export REDIS_URLS='redis://127.0.0.1:6379/0'
export RUN_INFRASTRUCTURE_TESTS=true
npm run test:integration
```

Le processus `migration` utilise uniquement `DATABASE_DIRECT_URL[_FILE]` et force un pool de taille
un. En staging et production, PostgreSQL et Redis sont obligatoires, les secrets directs sont
refuses, les fichiers doivent etre sous `SECRET_MOUNT_ROOT` avec des permissions restrictives, les
CA sont obligatoires et Redis doit utiliser le mode Cluster.

## Reunions anonymes locales

Les routes sont desactivees par defaut en developpement. Leur activation exige PostgreSQL, Redis et
deux keyrings HMAC independants. Chaque keyring est un JSON contenant `currentVersion` et une map
`keys`; chaque cle est une valeur base64url de 32 octets. Les valeurs ci-dessous sont des exemples
de forme, pas des secrets a reutiliser.

```bash
export MEETINGS_ENABLED=true
export CAPABILITY_HMAC_KEYRING='{"currentVersion":1,"keys":{"1":"<base64url-32-octets>"}}'
export SESSION_HMAC_KEYRING='{"currentVersion":1,"keys":{"1":"<autre-base64url-32-octets>"}}'
npm run dev:api
```

`POST /v1/meetings` cree la reunion et la session hote. `POST /v1/meetings/{meetingId}/join` echange
la capacite invite contre une session participant ou viewer. Les deux routes exigent un `Origin`
present dans `ALLOWED_ORIGINS` et `Sec-Fetch-Site: same-origin|same-site`. Le frontend genere les
UUID de commande, les deux capacites et le binding appareil avec un CSPRNG; les capacites font
exactement 32 octets encodes en base64url. Le token de session ne figure jamais dans le JSON: il est
ecrit dans le cookie, tandis que le jeton CSRF est retourne au frontend pour etre conserve en
memoire.

En staging/production, utiliser uniquement `CAPABILITY_HMAC_KEYRING_FILE` et
`SESSION_HMAC_KEYRING_FILE` sous `SECRET_MOUNT_ROOT`; le cookie devient obligatoirement
`__Host-hf_session; Secure; HttpOnly; SameSite=Strict; Path=/`.

## Documentation

- `01-cadrage-backend-temps-reel.md`
- `02-specification-architecture-backend.md`
- `03-modele-menaces-securite.md`

`npm run docs:check` bloque les API publiques non documentees. `npm run docs:code` genere le site
TypeDoc dans `generated-docs/code`. En developpement et test, Swagger UI est servi sur `/docs` et le
contrat OpenAPI sur `/openapi.json`; les deux sont desactives par defaut hors environnement local.

Les commentaires TSDoc documentent les contrats et decisions non evidentes. Le projet ne commente
pas chaque ligne: les commentaires redondants vieillissent avec le code et diminuent la lisibilite;
le lint, TypeDoc et les tests imposent plutot une documentation verifiable aux frontieres publiques.

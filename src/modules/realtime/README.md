# Module `realtime`

## Mission

Posseder le WebSocket applicatif du backend : handshake, authentification par ticket, protocole
versionne, limites, registre local, presence et drainage. Il ne porte pas le signaling mediasoup et
ne signe pas l'admission SFU.

## Handshake

| ID      | Exigence                                                |
| ------- | ------------------------------------------------------- |
| WSS-001 | chemin exact `/v1/realtime`, aucune query               |
| WSS-002 | sous-protocole exact `hf-realtime.v1`                   |
| WSS-003 | origine exacte dans l'allowlist                         |
| WSS-004 | processus `ready`, pas `starting` ou `draining`         |
| WSS-005 | compression desactivee, taille/fragmentation bornees    |
| WSS-006 | limite de connexions par source avant allocation metier |

## Authentification

Le socket commence `unauthenticated`. Il doit envoyer exactement un `session.authenticate` avant
`REALTIME_AUTH_TIMEOUT_MS`. Le ticket est consomme atomiquement, puis la session SQL est revalidee.
Le socket devient `authenticated` avec un principal immutable et entre en presence.

Les commandes suivantes utilisent ce principal et declenchent une nouvelle lecture SQL au plus
toutes les `REALTIME_SESSION_REVALIDATE_SECONDS` secondes. La future commande de revocation
diffusera en plus un signal immediat aux pods ; elle n'est pas simulee dans cette etape.

## Protocole etapes 3 et 4

Client vers serveur :

- `session.authenticate` ;
- `room.subscribe` ;
- `chat.message.submit` ;
- `chat.sync.request` ;
- `presence.heartbeat` ;
- `ping`.

Serveur vers client :

- `session.authenticated` ;
- `room.snapshot` ;
- `chat.message.accepted` ;
- `chat.message.created` ;
- `chat.sync.page` ;
- `room.high_watermark` ;
- `presence.changed` ;
- `pong` ;
- `slow_consumer`, `session.revoked`, `server.draining`, `error`.

Le contrat machine est genere dans `/asyncapi.json` lorsque la documentation locale est active. Les
futurs messages E2EE seront ajoutes sans changer l'enveloppe v1.

## Limites

- frames texte seulement et JSON strict ;
- taille maximale avant parsing ;
- token buckets locaux distincts avant/apres auth ;
- limite distribuee sur ticket cote API ;
- file de commandes par socket strictement bornee ;
- une commande a la fois pour conserver l'ordre v1 ;
- file de sortie bornee par `bufferedAmount` ;
- evenements presence coalescables, erreurs/acks jamais supprimes ;
- heartbeat Ping/Pong et expiration presence ;
- timers `unref` et nettoyage idempotent.

## Reconnexion mobile

Le serveur fournit des codes stables indiquant `retryable`. Le frontend attend un delai aleatoire
initial puis un backoff exponentiel tronque, demande un ticket neuf et redemande un snapshot. Aucun
token consomme n'est rejoue. Un changement d'adresse IP n'invalide pas la session si le binding
appareil reste valide.

## Drainage

Le processus retire readiness, refuse les upgrades, envoie `server.draining`, laisse une courte
fenetre de reprise sur un autre pod, ferme les sockets avec code documente, retire listeners/timers,
puis ferme Redis/PostgreSQL et OTel.

## Chat et reconnexion

`room.subscribe.chat` ouvre la subscription Redis avant la lecture PostgreSQL, bufferise pendant le
catch-up, envoie le snapshot, puis fusionne le live par position. Un buffer plein ou une file de
sortie saturee ferme explicitement en `1013`; aucun message durable n'est abandonne silencieusement.
`chat.sync.request` exige le meme appareil public que l'abonnement du socket.

Les erreurs `CHAT_*` restent des erreurs de commande et ne ferment pas le socket. Une erreur
d'authentification, une frame invalide ou une saturation de transport conserve la politique de
fermeture generale. Le detail transactionnel vit dans `../chat/README.md`.

## Etat d'implementation

Le handshake, l'authentification one-shot, les commandes des etapes 3 et 4, le registre borne, les
token buckets, la file serie bornee, le controle `bufferedAmount`, Ping/Pong, presence, chat durable
et drainage sont implementes. Les commandes MLS et de moderation restent volontairement absentes du
parseur jusqu'a leurs transactions et politiques respectives.

Preuves automatisees : `tests/realtime.test.ts`, `tests/realtime-tickets.test.ts`,
`tests/presence.test.ts`, `tests/chat.test.ts`, `tests/realtime.asyncapi.test.ts` et
`tests/sessions.test.ts`. Les tests ouvrent un vrai serveur `ws`, verifient les refus de handshake
et executent un parcours chat authentifie contre PostgreSQL et Redis reels.

## Codes de fermeture applicatifs

| Code | Sens                                       |
| ---- | ------------------------------------------ |
| 4001 | authentification requise/invalide          |
| 4003 | origine ou session interdite               |
| 4008 | limite ou timeout                          |
| 4009 | session revoquee/remplacee                 |
| 4010 | serveur en drainage, reconnexion autorisee |
| 1013 | surcharge/backpressure temporaire          |

Les raisons sont courtes, constantes et sans identifiant.

## Tests requis

- handshake origine/path/protocole/query ;
- timeout auth et ticket one-shot concurrent ;
- frames invalides, binaires, trop grandes, flood ;
- ordre des commandes et backpressure ;
- ping/pong, socket fantome, fermeture et fuite de timer ;
- plusieurs pods via Redis, perte Pub/Sub et snapshot ;
- drain/reconnexion et test de charge memoire stable.

## References

- [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [`ws` heartbeat](https://github.com/websockets/ws/blob/master/README.md)
- [`ws` server options](https://github.com/websockets/ws/blob/master/doc/ws.md)
- [NestJS WebSocket adapters](https://docs.nestjs.com/websockets/adapter)
- `sfu-server/docs/10-phase-4-protocole-signaling.md` pour la frontiere SFU.

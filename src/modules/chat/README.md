# Module `chat`

## Mission

Fournir un journal de chat chiffre, durable, ordonne par reunion et reparable apres coupure. Le
module autorise une commande avec le principal du socket, persiste uniquement un ciphertext opaque
et ses metadonnees publiques, alloue une position monotone, cree l'outbox dans la meme transaction,
puis diffuse apres `COMMIT`.

Le module ne chiffre, ne dechiffre et ne genere aucune cle. Le cycle de vie MLS, les KeyPackages,
les Welcome et les changements d'epoch appartiennent au futur module `e2ee` de l'etape 7. Sans
appareil public et appartenance E2EE actifs, le chat refuse avec `CHAT_KEY_SYNC_REQUIRED`.

## Contrat fonctionnel

| ID       | Fonction                                                               | Statut                          |
| -------- | ---------------------------------------------------------------------- | ------------------------------- |
| CHAT-001 | accepter un ciphertext base64url canonique, borne et versionne         | implemente                      |
| CHAT-002 | deriver reunion et emetteur du principal authentifie                   | implemente                      |
| CHAT-003 | revalider session, participant, politique, appareil, groupe et epoch   | implemente                      |
| CHAT-004 | appliquer roles, types autorises, quota et slow mode serveur           | implemente                      |
| CHAT-005 | garantir l'idempotence par emetteur et `clientMessageId`               | implemente                      |
| CHAT-006 | allouer une position sans trou de commit dans chaque reunion           | implemente                      |
| CHAT-007 | persister message et outbox dans une transaction atomique              | implemente                      |
| CHAT-008 | confirmer la durabilite avant la tentative de diffusion                | implemente                      |
| CHAT-009 | diffuser par Redis Sharded Pub/Sub avec une voie rapide apres commit   | implemente                      |
| CHAT-010 | reprendre une diffusion perdue par worker apres expiration du lease    | implemente                      |
| CHAT-011 | paginer en avant selon le curseur, le watermark et l'appartenance E2EE | implemente                      |
| CHAT-012 | fusionner, remettre en ordre et dedoublonner dans une memoire bornee   | implemente                      |
| CHAT-013 | signaler un trou et reparer depuis PostgreSQL                          | implemente                      |
| CHAT-014 | supprimer les ciphertexts expires par lots `SKIP LOCKED`               | implemente                      |
| CHAT-015 | documenter commandes/resultats/evenements dans AsyncAPI 3              | implemente                      |
| CHAT-016 | provisionner et faire evoluer cryptographiquement le groupe MLS        | etape 7, bloque par gate G-02   |
| CHAT-017 | partager volontairement l'historique avec un futur membre              | option inactive, gate distincte |
| CHAT-018 | moderation, tombstones et suppression visible                          | planifie avec moderation        |

## Commandes WebSocket

Toutes les commandes utilisent l'enveloppe stricte `{v,id,type,payload}`. Elles ne contiennent pas
de `meetingId`, de `participantId`, de role ni de destination Redis choisis par le client.

### `room.subscribe`

Le payload peut inclure `chat: {deviceId, afterPosition?, limit?}`. Le serveur :

1. ouvre d'abord l'abonnement Redis de la reunion et commence un buffer borne ;
2. revalide l'acces SQL de l'appareil public ;
3. lit un snapshot jusqu'au `highWatermark` durable ;
4. envoie `room.snapshot` avec la page de chat ;
5. active le flux live, fusionne le buffer et elimine les doublons.

Sans objet `chat`, le snapshot retourne `chat.status=not_requested`. Un appareil inconnu ou non
membre n'obtient aucun ciphertext.

### `chat.message.submit`

Le payload contient `clientMessageId`, `deviceId`, `groupId`, `epoch`, `protocolVersion=1`,
`contentType` et `ciphertext`. Les types publics autorises sont `text`, `reaction` et `receipt` ; le
corps et les identifiants fonctionnels d'une reaction ou d'un recu restent dans le ciphertext.

Le resultat `chat.message.accepted` contient l'ID durable, la position, le temps serveur et
`replayed`. Il confirme le commit PostgreSQL, pas la reception ni la lecture par les autres
participants. L'ACK est mis dans la file du socket avant toute voie rapide Redis.

### `chat.sync.request`

La commande exige un abonnement chat actif pour le meme `deviceId`. Elle retourne une page ordonnee
`chat.sync.page` avec `messages`, `nextAfterPosition`, `highWatermark` et `hasMore`. Le curseur est
exclusif et encode en chaine decimale pour ne pas perdre la precision `bigint` dans JSON.

Le serveur peut emettre `room.high_watermark` lorsqu'une position durable depasse le curseur
contigu. Le client redemande alors les pages manquantes ; il ne saute jamais directement au plus
grand numero observe.

## Transaction T3

L'adapter PostgreSQL effectue dans une unite de travail :

1. relecture de la session, du participant et de la reunion encore actifs ;
2. resolution du `public_device_id`, verification du groupe chat et de l'appartenance active ;
3. comparaison stricte de l'epoch et application de la politique versionnee ;
4. recherche idempotente avant contention, puis verrouillage `FOR UPDATE` du stream head ;
5. seconde recherche sous verrou et comparaison constante du SHA-256 du ciphertext ;
6. controle du slow mode, increment du head et insertion du message ;
7. insertion de `chat.message.created` avec un lease court dans l'outbox ;
8. commit atomique.

Le verrou ne serialise que les messages d'une meme reunion. Des reunions differentes progressent en
parallele. Il garantit qu'une transaction portant N committe avant que N+1 puisse etre allouee ; une
sequence globale ne fournirait pas cette garantie de visibilite.

Un retry identique retourne le message original sans nouvelle position ni nouvelle outbox. Un meme
`clientMessageId` avec un hash, groupe, epoch ou type different retourne
`CHAT_IDEMPOTENCY_CONFLICT`.

## Autorisation et confidentialite

- `meetingId` et `senderParticipantId` viennent exclusivement du principal WSS ;
- l'appareil est recherche par son ID public puis rattache au participant courant ;
- le groupe doit appartenir a la meme reunion, avoir `purpose=chat` et etre actif ;
- l'epoch doit etre exactement l'epoch courant ;
- la politique JSON v1 accepte `participants`, `host_presenters`, `host_only` ou `disabled` ;
- `contentTypes` et `slowModeSeconds` sont controles cote serveur ;
- les evenements outbox et Redis sont revalides avant publication et avant fan-out ;
- le canal Redis est construit uniquement depuis l'ID de reunion valide par le serveur ;
- le listener refuse tout payload dont le `meetingId` ne correspond pas au canal observe.

PostgreSQL, Redis, les logs et les metriques ne voient jamais le texte clair. Ils voient cependant
les metadonnees necessaires au routage : reunion, emetteur pseudonyme, position, groupe, epoch,
type, taille et horodatage. Le produit ne doit donc pas presenter l'E2EE comme masquant ces
metadonnees.

## Historique

La pagination s'execute en `REPEATABLE READ`. Le `highWatermark` est lu avant la page et borne
toutes les lignes de cette reponse. La jointure d'appartenance ne retourne que les epochs pendant
lesquels l'appareil pouvait etre membre.

Avec `strict_membership`, `participant.chat_join_position` interdit aussi les positions anterieures
a la jointure. Un appareil ajoute a l'epoch E ne peut pas lire les messages des epochs precedents,
ce qui suit la confidentialite vers le passe de MLS.

`shared_history` ne donne aucune cle au serveur. Cette option ne devient utilisable que si un membre
enveloppe volontairement des cles d'historique pour le nouvel appareil, avec consentement produit,
modele de menace et tests distincts. Elle reste inactive par defaut.

## Livraison et pannes

La voie rapide possede initialement la livraison outbox pendant `CHAT_FAST_PATH_LEASE_MS`. Apres
l'ACK durable, elle tente `SPUBLISH` puis marque la livraison. Si le pod meurt, si Redis echoue ou
si l'ack SQL est perdu, le worker reprend la ligne avec `FOR UPDATE SKIP LOCKED` apres le lease. Une
publication peut donc etre dupliquee ; `eventId` et `position` la rendent idempotente.

Redis Pub/Sub est at-most-once et n'est jamais la sauvegarde. Un poll periodique compare par lots
les heads PostgreSQL des reunions localement observees. Une avance non recue produit un watermark et
force le rattrapage SQL.

En panne Redis, la soumission reste durable si PostgreSQL est sain. Le quota distribue passe sur un
token bucket local borne et marque la decision `degraded`; cette disponibilite ne remplace pas les
protections edge et devra etre testee sous plusieurs pods. Une panne PostgreSQL interdit tout ACK.

## Performance et memoire

- ciphertext decode avant checkout SQL et limite par `CHAT_MAX_CIPHERTEXT_BYTES` ;
- une seule requete de heads pour au plus 1 000 reunions par lot ;
- une subscription Redis par reunion et par pod, partagee entre ses sockets ;
- page, buffer de transition, reorder buffer, file WSS et `bufferedAmount` bornes ;
- token bucket Lua atomique base sur l'heure Redis ;
- pool PostgreSQL et concurrence outbox configures par processus ;
- aucune reunion, aucun participant et aucun message comme label Prometheus ;
- retention par lot afin de ne pas bloquer les commits chat.

La contention de `meeting_stream_heads` doit etre mesuree pour les lives massifs. Une evolution vers
un journal partitionne ne sera retenue qu'apres mesure et sans sacrifier l'ordre de commit.

## Variables d'environnement

| Variable                              | Role                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `CHAT_ENABLED`                        | active commandes realtime et worker chat               |
| `CHAT_MAX_CIPHERTEXT_BYTES`           | taille decodee maximale                                |
| `CHAT_HISTORY_PAGE_DEFAULT/MAX`       | pagination normale et plafond                          |
| `CHAT_RATE_PER_PARTICIPANT`           | debit soutenu du token bucket                          |
| `CHAT_RATE_BURST`                     | capacite de rafale                                     |
| `CHAT_FAST_PATH_LEASE_MS`             | reserve du pod ayant commis                            |
| `CHAT_HIGH_WATERMARK_INTERVAL_MS`     | detection periodique de pertes Pub/Sub                 |
| `CHAT_REORDER_BUFFER_MESSAGES`        | memoire maximale par socket pour evenements hors ordre |
| `CHAT_RETENTION_DAYS`                 | duree des ciphertexts durables                         |
| `CHAT_CLEANUP_BATCH_SIZE/INTERVAL_MS` | rythme borne de suppression                            |

Les validations croisees garantissent que le ciphertext encode tient dans une frame WSS, que le
burst couvre le debit soutenu et que le lease laisse une marge au timeout Redis. Le realtime exige
meetings, PostgreSQL et Redis ; le worker exige PostgreSQL et Redis sans charger les keyrings HTTP.

## Metriques et logs

Metriques : `hf_chat_commands_total`, `hf_chat_operation_duration_seconds`, `hf_chat_fanout_total`
et `hf_chat_synchronized_messages_total`. Tous les labels sont des enums bordees. Les logs
n'incluent ni ciphertext, ID participant/reunion, ticket, binding ni payload client ; seuls
evenement stable, event ID technique et erreur sanitisee sont admis.

## Tests et preuves

- `tests/chat.test.ts` : schemas, politiques, curseur, quota degrade, fan-out et retention ;
- `tests/realtime.test.ts` : abonnement avant catch-up, commandes, ACK avant fast path ;
- `tests/realtime.asyncapi.test.ts` : contrat AsyncAPI genere et route HTTP ;
- `tests/integration/chat-postgres.integration.test.ts` : concurrence, idempotence, pagination,
  isolation, retention, WSS reel et reprise outbox ;
- `tests/integration/realtime-redis.integration.test.ts` : Pub/Sub sharded et quota Lua reels.

## References

- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html)
- [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/)
- [Redis pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/)
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [AsyncAPI 3.0 specification](https://www.asyncapi.com/docs/reference/specification/v3.0.0)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [Matrix Client-Server API pagination and transaction IDs](https://spec.matrix.org/latest/client-server-api/)
- [RFC 9420, Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420)
- `02-specification-architecture-backend.md`, sections 7.3, 7.4, 8.4, 9.4 et 10.

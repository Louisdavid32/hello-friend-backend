# Module `presence`

## Mission

Representer les connexions backend realtime observees pour une reunion. La presence est ephemere,
reparable et ne constitue jamais une autorisation.

## Modele

Une personne peut avoir plusieurs `connectionId` depuis plusieurs onglets ou appareils. Redis
conserve un hash de details minimaux et un sorted set de dernier heartbeat, colocalises avec
`{meetingId}`. Le snapshot agrege par participant masque les doublons de connexion.

## Fonctions etape 3

| ID      | Fonction                                                    |
| ------- | ----------------------------------------------------------- |
| PRS-001 | ouvrir une connexion authentifiee avec TTL                  |
| PRS-002 | renouveler heartbeat avec heure Redis                       |
| PRS-003 | fermer une connexion de facon idempotente                   |
| PRS-004 | purger les entrees expirees pendant open/heartbeat/snapshot |
| PRS-005 | produire snapshot agrege et revision monotone               |
| PRS-006 | publier un signal coalescable sur canal de reunion          |
| PRS-007 | retrouver les connexions d'une session pour revocation      |
| PRS-008 | supprimer toutes les cles quand la reunion est terminee     |

## Statuts publics

- `online` : au moins une connexion fraiche ;
- `away` : futur signal client borne, sans implication de securite ;
- `unknown` : Redis indisponible ou snapshot incomplet ;
- `offline` : toutes les connexions observees sont fermees/expirees.

## Confidentialite et echelle

Redis ne contient ni IP, cookie, ticket, nom d'affichage, SDP, ICE ni contenu. Les metriques
n'utilisent aucun ID en label. Pour un live massif, le snapshot est pagine/compact et
`presence.changed` indique une revision plutot que de broadcast toute la liste a chaque heartbeat.

## Pannes

Pub/Sub est at-most-once. Un evenement manque est repare par snapshot. Redis indisponible ne coupe
pas une socket deja authentifiee mais marque la presence `unknown` et degrade la readiness. Les TTL
nettoient les processus morts.

## Etat d'implementation

Les scripts open/heartbeat/close/snapshot, les trois cles colocalisees, l'index de session,
l'agregation et les notifications Sharded Pub/Sub sont implementes. Le transport envoie une revision
compacte puis le client repare par snapshot. La commande metier de revocation qui consommera l'index
arrive avec la moderation ; elle n'est pas declaree disponible a cette etape. Les scripts, la
notification sharded, l'expiration et la restauration de revision ont ete prouves sur Redis 8.2.9
autonome. Redis Cluster, le failover et la charge restent des gates de preproduction.

## Tests requis

- open/heartbeat/close idempotents et concurrents ;
- plusieurs connexions d'un participant ;
- expiration par horloge Redis ;
- snapshot borne, corruption ignoree et revision monotone ;
- toutes les cles d'un script dans le meme hash slot ;
- panne Redis sans faux `offline`.

## References

- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- `04-specification-fonctionnelle-modulaire.md`, section 9.

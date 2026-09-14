# Plateforme `redis`

Mission : fournir les connexions Redis et un keyspace canonique aux modules, sans cacher les
garanties differentes de cache, ticket, presence et Pub/Sub.

Connexions separees :

1. `command` pour commandes et scripts courts ;
2. `publisher` pour publication ;
3. `subscriber` exclusivement en mode abonnement.

Invariants : Cluster et TLS obligatoires hors local, base zero, trois seeds au minimum, offline
queue desactivee, file client bornee, timeout par commande, reconnexion avec jitter et budget fini.
Le timeout par commande ne devient jamais un `socketTimeout` d'inactivite : les connexions et le
subscriber Pub/Sub doivent rester ouverts lorsqu'aucune donnee ne circule. Les scripts declarent
toutes leurs cles et utilisent un seul hash slot. Aucun lock Redis ne protege un invariant
PostgreSQL.

Le keyspace `hf:v1` valide UUID et digests. Toute nouvelle famille documente type Redis, TTL, owner,
hash tag, taille maximale et comportement de panne.

Pub/Sub est une notification at-most-once. Les donnees fonctionnelles durables doivent posseder un
chemin de rattrapage PostgreSQL.

Preuves : `tests/redis-connections.test.ts`, `tests/redis-keyspace.test.ts` et futurs tests Redis
Cluster de tickets/presence.

References :
[Redis security](https://redis.io/docs/latest/operate/oss_and_stack/management/security/),
[node-redis client configuration](https://github.com/redis/node-redis/blob/master/docs/client-configuration.md),
[Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/),
[Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/).

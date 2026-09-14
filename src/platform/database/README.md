# Plateforme `database`

Mission : fournir un pool PostgreSQL borne, un executeur SQL parametre, une unite de travail et un
runner de migrations. La plateforme ne contient aucune regle meeting, session, chat ou presence.

Invariants :

- un pool par processus et budget global calcule avant deploiement ;
- timeouts connect/query/statement/lock/idle transaction ;
- TLS avec verification certificat/hostname hors local ;
- une transaction utilise exactement le meme `PoolClient` ;
- release en `finally`, rollback sur toute erreur ;
- retries seulement pour serialization/deadlock et maximum trois ;
- aucune I/O externe dans un callback retentable ;
- SQL statique et valeurs en parametres positionnels ;
- migration sous advisory lock, checksum immutable et une transaction/fichier.

Readiness devient rouge si PostgreSQL requis ne repond pas. Un pool epuise doit produire
timeout/metrique, pas une file infinie.

Preuves : `tests/postgres-connection.test.ts`, `tests/postgres-unit-of-work.test.ts`,
`tests/migration-runner.test.ts` et tests d'integration PostgreSQL 18.

References : [node-postgres pooling](https://node-postgres.com/features/pooling),
[node-postgres transactions](https://node-postgres.com/features/transactions),
[PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html).

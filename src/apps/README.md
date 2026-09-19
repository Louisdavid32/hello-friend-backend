# Processus deployables

Le backend produit un artefact mais quatre roles de processus. `APP_ROLE` doit correspondre au point
d'entree ; aucun role ne recoit une dependance inutile.

| Role        | Responsabilite                                             | Dependances                           |
| ----------- | ---------------------------------------------------------- | ------------------------------------- |
| `api`       | REST, sessions, tickets, admissions SFU et JWKS            | PostgreSQL, Redis, KMS si admission   |
| `realtime`  | WSS applicatif, presence, chat futur                       | PostgreSQL, Redis                     |
| `worker`    | outbox, retention chat et nettoyage des audits d'admission | PostgreSQL, Redis/Kafka selon handler |
| `migration` | appliquer SQL checksume sous verrou                        | PostgreSQL direct uniquement          |

Chaque processus suit `starting -> ready -> draining`. Il ne devient ready qu'apres initialisation
de ses dependances obligatoires. Au drain, il refuse les nouveaux travaux, ferme les ressources dans
l'ordre et respecte une deadline.

Les ports locaux par defaut sont 3000, 3001, 3002 et 3003. En production, l'orchestrateur, les
NetworkPolicies et les identites de service sont distincts.

Preuves : `tests/health.test.ts`, `tests/http-application.test.ts`, `tests/telemetry.test.ts` et
`tests/realtime.test.ts` pour le drainage WSS.

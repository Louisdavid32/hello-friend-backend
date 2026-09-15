# Module `outbox`

## Mission

Rendre les effets externes recuperables apres commit PostgreSQL. Le module ne garantit pas
exactement une livraison ; il garantit une livraison au moins une fois avec deduplication
obligatoire chez le consommateur.

## Fonctions

| ID      | Fonction                                       | Statut                      |
| ------- | ---------------------------------------------- | --------------------------- |
| OBX-001 | inserer evenement dans la transaction metier   | implemente par repositories |
| OBX-002 | claim concurrent avec `FOR UPDATE SKIP LOCKED` | implemente                  |
| OBX-003 | lease borne et ownership verifie a l'ack       | implemente                  |
| OBX-004 | publications concurrentes bornees              | implemente                  |
| OBX-005 | retry exponentiel avec jitter                  | implemente                  |
| OBX-006 | passage `dead` apres budget                    | implemente                  |
| OBX-007 | registre destination vers un seul handler      | implemente                  |
| OBX-008 | boucle worker non chevauchante                 | implemente etape 4          |
| OBX-009 | handler Redis chat et voie rapide apres commit | implemente etape 4          |
| OBX-010 | handlers Kafka et controle SFU                 | planifies etapes 5/6        |

## Invariants

- la publication externe se produit hors transaction ;
- une perte d'ack peut produire un doublon mais jamais un faux succes ;
- seul le proprietaire du lease peut marquer `published` ou `retry` ;
- le worker ne claim que les destinations ayant un handler enregistre ;
- payload, version, event ID et scope reunion sont valides avant publication ;
- aucune erreur broker brute ou payload sensible n'entre dans les logs ;
- `dead` est visible et alerte, jamais abandonne silencieusement.

## Ordre

`partition_key=meetingId` preserve l'ordre logique attendu par les transports qui le supportent.
Plusieurs evenements d'une meme reunion peuvent etre claims ; le handler de destination doit
appliquer le contrat d'ordre specifique. Le chat utilisera `eventId` et `position` pour dedoublonner
et reparer Pub/Sub.

## Pannes

| Situation                           | Resultat                                      |
| ----------------------------------- | --------------------------------------------- |
| handler echoue                      | retry planifie avec erreur sanitisee          |
| worker meurt apres claim            | autre worker reprend apres lease              |
| publication reussit, ack SQL echoue | doublon possible au retry                     |
| aucun handler enregistre            | aucune ligne de cette destination n'est claim |
| annulation shutdown                 | travaux non commences rendus au prochain poll |

## Preuves

- `tests/outbox.test.ts` ;
- `tests/integration/infrastructure.integration.test.ts` ;
- `tests/integration/chat-postgres.integration.test.ts` prouve la reprise apres expiration du lease
  realtime et la publication Redis reelle.

## References

- [AWS Prescriptive Guidance - transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [Apache Kafka delivery semantics](https://kafka.apache.org/documentation/#semantics)
- `02-specification-architecture-backend.md`, sections 9.6 et 10.

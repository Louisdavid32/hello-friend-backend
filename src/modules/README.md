# Frontieres des modules metier

La baseline fonctionnelle commune vit dans `04-specification-fonctionnelle-modulaire.md`. Chaque
repertoire de module contient un `README.md` qui fixe mission, non-responsabilites, exigences,
invariants, pannes, tests et statut courant. Les controllers/gateways restent minces et appellent
des cas d'usage. Le domaine n'importe ni NestJS, ni PostgreSQL, ni Redis, ni Kafka, ni le SFU.

Ordre et ownership :

| Module             | Ownership                                                     |
| ------------------ | ------------------------------------------------------------- |
| `meetings`         | cycle de vie et politiques de reunion                         |
| `capabilities`     | capacites hote/invite et digests HMAC                         |
| `participants`     | pseudonymes, roles et etats limites a une reunion             |
| `sessions`         | cookies opaques, authentification et rotation                 |
| `realtime-tickets` | tickets WSS courts, lies au contexte et consommables une fois |
| `realtime`         | handshake WSS, protocole, limites et registre local           |
| `chat`             | ciphertext durable, ordre et pagination                       |
| `e2ee`             | credentials appareil, KeyPackages, epochs et artefacts MLS    |
| `sfu-integration`  | admission/JWKS, control port et projections SFU               |
| `outbox` / `inbox` | livraison et deduplication durables                           |
| `presence`         | connexions et heartbeats Redis ephemeres                      |
| `audit`            | evenements de securite sans contenu ni secret                 |

Une table ou un schema prepare ne rend pas un module fonctionnel. Le statut exact est maintenu dans
la specification globale et dans le README proprietaire, puis prouve par les tests references.

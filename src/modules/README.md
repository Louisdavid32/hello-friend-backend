# Frontieres des modules metier

Les modules sont ajoutes lorsqu'un comportement reel et ses tests sont implementes. Les
controllers/gateways restent minces et appellent des cas d'usage. Le domaine n'importe ni NestJS, ni
PostgreSQL, ni Redis, ni Kafka, ni le SFU.

Ordre et ownership :

| Module             | Ownership                                                  |
| ------------------ | ---------------------------------------------------------- |
| `meetings`         | cycle de vie et politiques de reunion                      |
| `capabilities`     | capacites hote/invite et digests HMAC                      |
| `participants`     | pseudonymes, roles et etats limites a une reunion          |
| `sessions`         | cookies opaques, rotation et tickets realtime              |
| `chat`             | ciphertext durable, ordre et pagination                    |
| `e2ee`             | credentials appareil, KeyPackages, epochs et artefacts MLS |
| `sfu-integration`  | admission/JWKS, control port et projections SFU            |
| `outbox` / `inbox` | livraison et deduplication durables                        |
| `presence`         | connexions et heartbeats Redis ephemeres                   |
| `audit`            | evenements de securite sans contenu ni secret              |

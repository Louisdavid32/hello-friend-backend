# Module `capabilities`

## Mission

Transformer des secrets opaques fournis par le client en digests HMAC versionnes et verifiables sans
conserver les secrets. Le module ne decide ni des roles ni du cycle de vie d'une reunion.

## Cas fonctionnels

| ID      | Fonction                                                       | Statut           |
| ------- | -------------------------------------------------------------- | ---------------- |
| CAP-001 | digerer une nouvelle capacite hote/invite avec la cle courante | implemente       |
| CAP-002 | calculer au plus trois candidats lors d'une rotation           | implemente       |
| CAP-003 | digerer separement session, CSRF et binding appareil           | implemente       |
| CAP-004 | generer un token CSPRNG de 256 bits                            | implemente       |
| CAP-005 | refuser une meme cle courante pour capabilities et sessions    | implemente       |
| CAP-006 | effacer les buffers de cles au shutdown                        | implemente       |
| CAP-007 | verifier sessions/CSRF avec toutes les versions actives        | etape 3          |
| CAP-008 | retirer une ancienne cle uniquement apres expiration maximale  | operation future |

## Invariants

- deux keyrings independants ;
- contexte HMAC separe pour `capability`, `session`, `csrf` et `device-binding` ;
- cles et secrets de 32 octets encodes base64url sans padding ;
- aucune API ne rend une cle chargee ;
- comparaison constante uniquement sur buffers de meme taille ;
- maximum trois versions pour borner CPU et amplification ;
- production : source fichier sous `SECRET_MOUNT_ROOT`, jamais variable inline.

## Entrees et sorties

Les entrees sont des chaines de 43 caracteres base64url. Une sortie persistable contient `version`
et un digest SHA-256 de 32 octets. Un secret invalide echoue avant tout acces PostgreSQL ou Redis.

## Rotation

1. monter l'ancienne et la nouvelle cle ;
2. declarer la nouvelle version courante ;
3. signer les nouvelles valeurs avec elle ;
4. verifier temporairement les deux versions ;
5. attendre le plus grand TTL des objets concernes ;
6. retirer l'ancienne et verifier les metriques de version.

## Pannes et securite

Un keyring absent, mal forme, trop large ou partage entre domaines bloque le demarrage. Aucun
fallback aleatoire n'est genere par le serveur. Les erreurs ne contiennent ni chemin complet
sensible ni valeur de cle.

## Preuves

- `tests/hmac-keyring.test.ts` ;
- `tests/manage-anonymous-meetings.test.ts` ;
- `npm run docs:check` pour le contrat public.

## References

- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [NIST SP 800-107 Rev.1](https://csrc.nist.gov/pubs/sp/800/107/r1/final)
- [Node.js Crypto](https://nodejs.org/api/crypto.html)
- `02-specification-architecture-backend.md`, sections 6.2, 8.8 et 16.2.

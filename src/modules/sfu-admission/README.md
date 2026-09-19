# Module `sfu-admission`

## Mission

Emettre juste a temps une admission media courte, strictement liee a la session, au participant, a
la reunion et a la politique courante. Le module traduit l'autorisation metier en permissions que le
SFU sait verifier. Il ne transporte aucun media, ne pilote pas mediasoup et ne remplace ni la
moderation ni la coordination E2EE.

## Fonctions de l'etape 5

| ID      | Fonction                                                                     | Statut                                  |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| SFU-001 | authentifier session, CSRF, binding appareil, origine et Fetch Metadata      | implemente                              |
| SFU-002 | limiter l'emission par adresse source et session avec une decision Redis     | implemente, refus ferme en cas de panne |
| SFU-003 | revalider session, participant, reunion, expirations et politique E2EE       | implemente dans la transaction A        |
| SFU-004 | deriver les permissions depuis le mode et les roles controles par le serveur | implemente et teste exhaustivement      |
| SFU-005 | reserver une tentative idempotente sans conserver le jeton                   | implemente                              |
| SFU-006 | signer Ed25519 par KMS avec concurrence, file et deadline bornees            | implemente                              |
| SFU-007 | revalider l'autorisation apres signature avant de retourner le jeton         | implemente dans la transaction B        |
| SFU-008 | publier la cle courante et les cles retirees dans un JWKS cacheable          | implemente avec ETag                    |
| SFU-009 | auditer resultat, `jti`, `kid` et version de politique sans jeton brut       | implemente                              |
| SFU-010 | invalider les admissions auditees d'une session revoquee                     | implemente comme port transactionnel    |
| SFU-011 | supprimer par lots les audits expires avec execution non chevauchante        | implemente dans le worker               |
| SFU-012 | exposer OpenAPI, metriques bornees, readiness du signer et erreurs stables   | implemente                              |

## Contrat HTTP

`POST /v1/sfu-admissions` exige une session anonyme active, `X-CSRF-Token`, `X-Device-Binding`, une
origine autorisee, Fetch Metadata et un `commandId` UUID. La reponse `201` contient
`admissionToken`, `expiresAt` et `sfuUrl`, avec `Cache-Control: no-store`. Un nouveau jeton se
demande apres reconnexion ; un jeton precedent n'est jamais renvoye ni rejoue.

`GET /v1/sfu-admission/jwks.json` publie uniquement des cles publiques Ed25519 de verification. Le
document comporte un ETag fort et un cache court avec revalidation. La cle courante precede les cles
retirees et chaque `kid` est unique.

Swagger decrit les deux routes dans `/openapi.json` et `/docs` en environnement local. Le signaling
media reste le contrat du SFU et n'est pas ajoute au protocole WebSocket applicatif.

## Profil JWT strict

Le JWS compact utilise exclusivement `alg=EdDSA`, `typ=sfu-admission+jwt` et un `kid` canonique. Le
payload contient `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `jti`, `tokenUse=sfu_admission`,
`roomId`, `role`, `permissions` et `displayName`. Le TTL configure est compris entre 30 et 300
secondes et ne depasse jamais l'expiration absolue de la session.

Le SFU doit verifier l'algorithme allow-liste, le type, l'emetteur, l'audience, les temps, le TTL
maximal, le schema ferme et le rejeu de `jti`. Le backend ne stocke ni le JWT ni sa signature. Un
JWT signe mais invalide par la transaction B est marque `invalidated` et n'est jamais retourne au
client.

## Permissions

| Mode            | Role SFU  | Emission autorisee                                     |
| --------------- | --------- | ------------------------------------------------------ |
| visioconference | `host`    | audio, video, ecran et reception                       |
| visioconference | `speaker` | audio, video, ecran et reception                       |
| appel audio     | `host`    | audio et reception, jamais video/ecran                 |
| appel audio     | `speaker` | audio et reception, jamais video/ecran                 |
| live            | `host`    | audio, video, ecran et reception                       |
| live            | `speaker` | audio, video, ecran et reception                       |
| tous modes      | `viewer`  | reception uniquement, aucun transport d'envoi/producer |

Toutes les admissions comprennent `room:join`, `transport:create:recv` et `media:consume`. Lorsque
la politique media E2EE est `required`, une appartenance active au groupe media et un appareil actif
sont necessaires ; sinon l'emission echoue avec `SFU_ADMISSION_KEY_SYNC_REQUIRED`. Aucun downgrade
implicite en clair n'existe.

## Transactions et concurrence

La transaction A verrouille session, participant et reunion, calcule la politique depuis l'etat SQL
et reserve une ligne `requested` unique pour `(session_id, command_id)`. L'appel KMS a lieu hors
transaction. La transaction B reverrouille les memes objets, compare identites, etats, expirations,
role, permissions, version de politique, cle et `jti`, puis passe l'audit a `issued` ou
`invalidated`. Un changement concurrent gagne toujours sur la publication du jeton.

Une commande deja reservee est refusee ; le service ne reconstitue pas un ancien jeton puisqu'il ne
le persiste pas. Les signatures sont executees avec une concurrence et une file bornes. Saturation,
timeout ou panne KMS produisent une erreur recuperable sans detail fournisseur.

## Cles et rotation

En staging/production, seule une cle asymetrique AWS KMS `ECC_NIST_EDWARDS25519` avec usage
`SIGN_VERIFY` est acceptee. Le role API ne requiert que `kms:GetPublicKey` et `kms:Sign`, restreints
a la cle et a l'algorithme Ed25519. Le provider fichier PKCS#8 est reserve au developpement et aux
tests, sous `SECRET_MOUNT_ROOT`, avec controles de type, symlink, taille et permissions.

Les cles asymetriques KMS se remplacent par rotation manuelle : deployer la nouvelle cle courante,
publier les anciennes cles publiques via `SFU_ADMISSION_RETIRED_JWKS_FILE`, attendre au moins TTL
maximal + tolerance d'horloge + cache JWKS, puis retirer l'ancienne cle. Le fichier de rotation ne
contient jamais de cle privee.

## Pannes et exploitation

- PostgreSQL ou Redis indisponible : aucune nouvelle admission ;
- KMS sature, lent ou indisponible : file bornee, timeout, refus recuperable et readiness degradee ;
- changement de role/session/E2EE pendant la signature : jeton invalide et non divulgue ;
- SFU indisponible apres emission : le client redemande une admission lors de sa tentative suivante
  ;
- nettoyage worker indisponible : emission continue, audits expires conserves temporairement ;
- rotation incorrecte ou `kid` duplique : demarrage refuse avant readiness.

Les metriques n'utilisent que des labels bornes `operation` et `outcome`. Les logs excluent token,
cookie, `jti`, identifiants de reunion/participant et message fournisseur.

## Preuves

- `tests/sfu-admission-config.test.ts` ;
- `tests/sfu-admission-policy.test.ts` ;
- `tests/sfu-admission-signing.test.ts` ;
- `tests/sfu-admission-use-case.test.ts` ;
- `tests/postgres-sfu-admission.repository.test.ts` ;
- `tests/sfu-admission.openapi.test.ts` ;
- `tests/integration/sfu-admission.integration.test.ts` sur PostgreSQL 18 et Redis 8 ;
- `tests/sfu-server.contract.test.ts` contre le verificateur reel du depot SFU.

## References

- [RFC 7517 - JSON Web Key](https://www.rfc-editor.org/rfc/rfc7517)
- [RFC 8037 - EdDSA for JOSE](https://www.rfc-editor.org/rfc/rfc8037)
- [RFC 8725 - JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [AWS KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- [AWS KMS asymmetric keys](https://docs.aws.amazon.com/kms/latest/developerguide/symmetric-asymmetric.html)
- [AWS KMS key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
- [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- `02-specification-architecture-backend.md`, sections 6.1, 7.1, 10.4 et 13.

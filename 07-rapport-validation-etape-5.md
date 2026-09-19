# Rapport de validation de l'etape 5

## 1. Perimetre

L'etape 5 livre l'admission SFU de courte duree sans melanger plan de controle backend et plan
media. Elle couvre politique media, emission Ed25519, JWKS, signature locale de test ou AWS KMS,
audit sans jeton, quotas, concurrence bornee, double validation transactionnelle, nettoyage worker,
metriques, OpenAPI et contrat execute avec le verificateur reel du SFU.

Elle ne declare pas terminees la moderation distante, la revocation instantanee d'une connexion SFU
deja etablie, MLS/SFrame, la qualification AWS KMS en staging, la charge longue duree ou le
deploiement multi-region. Ces travaux restent des gates explicites.

## 2. Invariants livres

- aucun role ni permission n'est accepte depuis le client ;
- un appel audio ne peut pas publier de video ou d'ecran ;
- un viewer live ne peut ni creer un transport d'envoi ni produire un media ;
- E2EE `required` refuse l'admission sans appareil et membre media actifs ;
- le JWT impose `EdDSA`, un type explicite, `kid`, `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `jti`,
  usage, reunion, role et permissions ;
- le TTL est borne a 30-300 secondes et a l'expiration absolue de session ;
- aucune cle privee, admission brute ou signature n'est persistee ou journalisee ;
- l'appel KMS ne conserve aucun verrou ni connexion SQL ;
- la transaction B invalide toute autorisation devenue stale pendant la signature ;
- saturation Redis/KMS/PostgreSQL refuse l'emission sans fallback permissif ;
- la rotation conserve les anciennes cles publiques pendant TTL + skew + cache.

## 3. Architecture executee

La transaction A verrouille session, participant et reunion, rederive la politique depuis PostgreSQL
et reserve une tentative unique. La signature s'execute ensuite hors transaction dans un executor a
concurrence, file et timeout bornes. La transaction B reverrouille et compare tout le contexte avant
de marquer `issued`; sinon elle marque `invalidated` et le JWT signe n'est jamais retourne.

Le processus API expose l'emission et le JWKS. Le worker ne charge aucune cle privee et nettoie par
lots les audits expires. Le SFU recupere seulement les cles publiques et applique lui-meme schema,
audience, TTL, permissions et anti-rejeu.

## 4. Validation automatisee

Les validations obligatoires sont :

- formatage, lint strict, typecheck, TypeDoc et build TypeScript ;
- tests unitaires de configuration, matrice de permissions, signature, KMS, JWKS, quotas, lifecycle,
  use case, repository PostgreSQL, OpenAPI et migration ;
- integration reelle PostgreSQL 18 / Redis 8 : migration, HTTP, JWKS, 16 emissions concurrentes,
  verification EdDSA, refus du rejeu et invalidation apres changement de politique ;
- contrat backend vers le verificateur reel du depot `sfu-server`, y compris refus du `jti` rejoue ;
- suite de regression complete et seuils globaux de couverture du repository.

Les resultats chiffres de la derniere execution sont consignes dans la section 8 apres la validation
finale sur la copie synchronisee.

## 5. Configuration et secrets

Le provider fichier est refuse en staging/production. AWS KMS doit fournir une cle
`ECC_NIST_EDWARDS25519`, usage `SIGN_VERIFY`; la signature utilise `MessageType=RAW` et
`ED25519_SHA_512`. Les permissions IAM attendues sont limitees a `kms:GetPublicKey` et `kms:Sign`,
avec restriction de cle et d'algorithme.

Les anciennes cles publiques sont injectees par un fichier JWKS sous `SECRET_MOUNT_ROOT`. Aucun PEM
prive n'est place dans le repository. Issuer HTTPS, URL SFU WSS, audience et cache JWKS doivent etre
alignes avec la configuration du SFU avant promotion.

## 6. Exploitation et alertes

Les metriques separent `authorize`, `sign` et `finalize`, ainsi que les issues `issued`, `rejected`,
`sign_failed` et `invalidated`, sans identifiant en label. La readiness enregistre le signer. Les
alertes staging doivent couvrir hausse des refus, saturation de file, timeout KMS, erreurs de
finalisation, age des audits `requested`, echec du janitor et echec de rafraichissement JWKS cote
SFU.

Un runbook de rotation doit prouver le chevauchement des `kid`. Un runbook d'incident doit pouvoir
arreter l'emission, retirer une cle compromise, raccourcir le cache et invalider les sessions sans
pretendre deconnecter les medias avant l'etape 6.

## 7. Gates restantes

L'etape 6 doit implementer le port de controle SFU, les commandes idempotentes de moderation et la
revocation active des participants/producers. L'etape 7 doit provisionner MLS/SFrame pour que les
reunions avec E2EE `required` quittent reellement `pending_key_sync`.

Avant production restent aussi obligatoires : qualification KMS reelle, Redis Cluster/failover,
charge et endurance, pertes reseau, sauvegarde/restauration, rotation pratique, observabilite et
promotion staging. Le passage des tests locaux ne vaut pas homologation de production.

## 8. Resultat final

Validation finale executee le 19 septembre 2026 depuis le dossier backend principal :

- `npm ci` : 513 paquets installes, 514 audites, aucune vulnerabilite signalee ;
- `npm run check` : formatage, lint strict, typecheck, TypeDoc, couverture et build valides ;
- regression : 31 fichiers de tests passes, 5 ignores par configuration ; 143 tests passes et 17
  tests opt-in ignores ;
- couverture globale : 82,48 % statements, 73,17 % branches, 87,09 % fonctions et 86,24 % lignes ;
- phase 5 ciblee : 7 fichiers et 30 tests passes ;
- integration PostgreSQL 18.6 / Redis 8.2.9 : 1 scenario passe, dont 16 emissions concurrentes,
  JWKS/ETag, verification EdDSA, rejeu refuse et invalidation apres changement d'autorisation ;
- contrat avec le verificateur reel de `sfu-server` : 1 scenario passe, admission acceptee puis
  `jti` rejoue refuse.

**Statut : etape 5 implementee, documentee et validee localement.** La qualification AWS KMS et la
promotion staging restent des gates de deploiement ; elles ne remettent pas en cause la fermeture de
l'etape d'implementation locale et ne doivent pas etre declarees passees avant execution sur
l'infrastructure cible.

## 9. References

- [RFC 7517 - JSON Web Key](https://www.rfc-editor.org/rfc/rfc7517)
- [RFC 8037 - EdDSA for JOSE](https://www.rfc-editor.org/rfc/rfc8037)
- [RFC 8725 - JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [AWS KMS Sign](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- [AWS KMS key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [OWASP REST Security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- `src/modules/sfu-admission/README.md` pour le contrat local et les preuves detaillees.

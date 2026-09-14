# Module `sessions`

## Mission

Authentifier une session anonyme bornee a une reunion a partir du cookie opaque, du CSRF et du
binding appareil. Le module ne cree pas de compte, ne choisit pas les droits SFU et ne transporte
pas les tickets WSS.

## Fonctions etape 3

| ID      | Fonction                                                                                | Statut                                    |
| ------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| SES-001 | extraire exactement le cookie configure sans accepter de doublon ambigu                 | implemente                                |
| SES-002 | exiger `X-CSRF-Token` et `X-Device-Binding` sur mutation                                | implemente                                |
| SES-003 | calculer des candidats HMAC de rotation bornes et alignes par version                   | implemente                                |
| SES-004 | verifier en SQL session, participant et reunion dans la meme transaction                | implemente                                |
| SES-005 | exiger l'egalite des trois HMAC de meme version et garder une erreur publique generique | implemente                                |
| SES-006 | refuser revoked/expired/ending/ended sans reveler lequel                                | implemente                                |
| SES-007 | prolonger l'idle TTL sans depasser l'expiration absolue/reunion                         | implemente                                |
| SES-008 | rendre un principal sans aucun secret au cas d'usage appelant                           | implemente                                |
| SES-009 | agreger les echecs de securite dans un audit durable                                    | planifie avec les commandes de revocation |

## Principal rendu

Le principal contient uniquement : sessionId, meetingId, participantId, mode, role produit, role
SFU, profil de permission/version et expirations. Il ne contient jamais token, CSRF, binding ou
digest.

## Cookie

Production impose `__Host-hf_session; Secure; HttpOnly; SameSite=Strict; Path=/` et aucun `Domain`.
Le cookie n'est accepte ni en query, ni dans un frame WSS.

## Rotation et reprise

Le keyring accepte temporairement plusieurs versions. Une future rotation de session cree un nouveau
token, lie `rotated_from_session_id` et revoque l'ancien atomiquement. Changer d'IP ne change pas
l'identite ; le binding aleatoire local est l'ancre de reprise, sans fingerprint materiel.

## Pannes

PostgreSQL ou keyring indisponible implique un refus ferme. Une session refusee utilise une erreur
generique et ne confirme pas l'existence de la reunion.

## Preuves actuelles

`tests/sessions.test.ts` couvre extraction, doublons, HMAC, erreurs generiques, requete parametree
et renouvellement borne. Le test PostgreSQL 18 reel demeure une gate d'environnement, pas une
fonctionnalite simulee.

## Tests de qualification restants

- cookie absent, duplique, trop grand ou mal forme ;
- chaque version du keyring et digest incorrect ;
- CSRF/binding incorrects ;
- toutes combinaisons d'etat et expiration ;
- update idle bornee et concurrence avec revocation ;
- aucune valeur sensible dans erreurs/logs.

## References

- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [MDN Secure cookie configuration](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies)
- `02-specification-architecture-backend.md`, sections 5.3 et 6.3.

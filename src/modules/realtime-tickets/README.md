# Module `realtime-tickets`

## Mission

Echanger une session HTTP deja authentifiee contre un secret WSS tres court, lie au contexte et
consommable une seule fois. Le ticket n'est ni une session durable, ni une admission SFU.

## Emission

`POST /v1/realtime-tickets` exige origine/fetch metadata, cookie, CSRF et binding. Le client fournit
un `commandId`. Apres authentification SQL, le module genere 32 octets CSPRNG, stocke seulement son
SHA-256 dans une cle Redis avec TTL et ecrit une ligne d'audit durable.

## Consommation

Le premier frame WSS contient `session.authenticate` avec le ticket et le meme binding appareil. Une
operation Redis atomique supprime et retourne le payload exactement une fois. Le payload est ensuite
confronte a l'origine du handshake et a l'etat SQL de la session avant d'etablir le principal
socket.

## Exigences

| ID      | Invariant                                                     |
| ------- | ------------------------------------------------------------- |
| TKT-001 | 256 bits d'entropie, base64url sans padding                   |
| TKT-002 | TTL entre 5 et 60 secondes                                    |
| TKT-003 | digest Redis, jamais secret brut                              |
| TKT-004 | payload JSON strict, versionne et borne                       |
| TKT-005 | un seul consommateur gagne sous concurrence                   |
| TKT-006 | ticket lie a session, meeting, participant, origine, appareil |
| TKT-007 | aucune valeur dans URL, log, trace ou metrique                |
| TKT-008 | Redis indisponible : emission/authentification refusee        |
| TKT-009 | rate limit source + session avant generation                  |
| TKT-010 | l'expiration ticket ne depasse jamais celle de la session     |

## Rejeu et reponse perdue

Un ticket consomme n'est jamais restaure. Si la reponse HTTP ou le premier frame est perdu, le
client demande un nouveau ticket avec jitter. Des tickets emis mais non consommes expirent seuls ;
leur nombre est borne par quota session/source. Le worker reconcilie ensuite les lignes d'audit
`pending|issued` en `expired` par lots `SKIP LOCKED`, sans scanner ni verrouiller toute la table.

## Etat d'implementation

Emission HTTP documentee par Swagger, authentification SQL, quota Redis, SHA-256, `SET NX PX`,
`GETDEL`, liaison origine/appareil, audit et reconciliation worker sont implementes. Les tests avec
doubles prouvent les transitions. Un test reel sur Redis 8.2.9 prouve qu'une seule des cent
consommations concurrentes gagne et que le TTL/NX sont appliques. Redis Cluster, le failover et la
charge restent des gates de preproduction.

## Tests requis

- emission et consommation reelles Redis ;
- 100 consommations concurrentes donnent un seul succes ;
- TTL, payload corrompu, origine differente et session revoquee ;
- Redis failover et absence de secret dans logs ;
- cluster slot canonique.

## References

- [Redis GETDEL](https://redis.io/docs/latest/commands/getdel/)
- [Redis Lua atomicity](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- `02-specification-architecture-backend.md`, section 6.3.

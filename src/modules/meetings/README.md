# Module `meetings`

## Mission

Posseder l'agregat reunion, ses modes, ses politiques et les parcours anonymes de creation/jointure.
Il orchestre les ports capabilities, sessions, audit et outbox, mais ne manipule jamais un socket ou
un objet mediasoup.

## Fonctions actuelles

| ID      | Fonction                                              | Statut     |
| ------- | ----------------------------------------------------- | ---------- |
| MTG-001 | creer une visio, un appel audio ou un live            | implemente |
| MTG-002 | creer hote, capacites et session dans T1              | implemente |
| MTG-003 | joindre avec capacite invite dans T2                  | implemente |
| MTG-004 | affecter `viewer` par defaut dans un live             | implemente |
| MTG-005 | rejouer une commande idempotente identique            | implemente |
| MTG-006 | refuser une reutilisation d'ID avec autre fingerprint | implemente |
| MTG-007 | quotas publics Redis create/join                      | implemente |
| MTG-008 | audit et outbox atomiques                             | implemente |
| MTG-009 | reprendre le meme participant sur appareil connu      | planifie   |
| MTG-010 | get/end/lock/waiting-room/moderation                  | planifie   |

## Regles par mode

- `video_conference` : hote `host`, invites `participant`, SFU futur `speaker` ;
- `audio_call` : meme roles, mais aucune permission video ne sera signee ;
- `live` : hote `host`, invite `viewer`, promotion presenter explicite future.

Le client ne fournit jamais `role`, `permission_profile`, `state` ou un droit SFU. Ces valeurs
proviennent de la politique serveur versionnee.

## T1 creation

La transaction reserve la commande, cree la reunion et son stream head, cree l'hote, stocke
seulement les digests des deux capacites, cree une session, ecrit audit/outbox puis complete la
commande. Un rollback annule l'ensemble.

## T2 jointure

La transaction verrouille d'abord la reunion, selectionne et verrouille une capacite invite valide,
reserve la commande, incremente `use_count`, cree participant/session, audit/outbox puis complete la
commande.

Les erreurs invitation inconnue, expiree, revoquee, meeting fermee ou quota epuise partagent le code
public `INVITATION_INVALID`.

## Moderation cible

L'hote pourra couper audio/video/ecran, bloquer le droit de republier, retirer, verrouiller la
salle, promouvoir un presenter et terminer. Une coupure distante ne permet jamais un unmute distant
: le consentement local reste obligatoire.

Ces actions necessitent le futur `SfuControlPort`; elles ne doivent jamais ecrire directement dans
le Redis ou les classes internes du SFU.

## Concurrence et performance

- isolation `serializable`, deux retries seulement sur erreurs retentables ;
- verrou ordre reunion puis capacite/participant ;
- aucune I/O externe dans la transaction ;
- SQL parametre et resultats bornes ;
- quotas Redis avant checkout PostgreSQL pour les routes publiques.

## Preuves

- `tests/manage-anonymous-meetings.test.ts` ;
- `tests/postgres-meeting.repository.test.ts` ;
- `tests/meeting.controller.test.ts` ;
- `tests/meeting.openapi.test.ts` ;
- integration PostgreSQL 18/Redis encore requise pour fermeture formelle.

## References

- [PostgreSQL Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [OWASP Transaction Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html)
- [Jitsi moderator semantics](https://jitsi.github.io/handbook/docs/faq/)
- [LiveKit participant management](https://docs.livekit.io/home/server/managing-participants/)
- `04-specification-fonctionnelle-modulaire.md`, sections 5 a 7.

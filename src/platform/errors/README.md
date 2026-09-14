# Plateforme `errors`

Mission : transformer les echecs attendus en contrats publics stables et les echecs inconnus en
reponses generiques sans fuite.

HTTP utilise RFC 9457 avec `type`, `title`, `status`, `detail`, `instance`, `code` et `traceId`. Les
details ne sont exposes que s'ils ont ete explicitement marques surs. Les exceptions inconnues
deviennent `INTERNAL_ERROR`.

Realtime utilise des codes analogues mais une enveloppe WSS et des close codes documentes. Aucun
message brut de PostgreSQL, Redis, cookie, ticket, frame ou stack n'est transmis au client.

Les codes sont des API : ils ne sont ni renommes ni reutilises pour un autre sens sans version de
contrat. Les logs contiennent le code et la cause redigee, pas le corps utilisateur.

References : [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457),
[OWASP Error Handling](https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html).

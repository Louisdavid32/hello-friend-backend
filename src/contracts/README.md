# Contrats versionnes

Les schemas HTTP, WebSocket et evenements sont ranges par version. Un contrat inconnu echoue
explicitement ; les types TypeScript sont derives des schemas de validation et ne les remplacent
pas.

```text
contracts/
  http/v1/
  realtime/v1/
  events/v1/
```

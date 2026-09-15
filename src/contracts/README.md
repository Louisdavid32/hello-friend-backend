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

Le contrat realtime v1 est un document AsyncAPI 3 genere a partir des memes schemas Zod stricts que
le parseur WebSocket. Il decrit commandes client, resultats correles, evenements serveur, endpoint,
sous-protocole et payloads chat. En local, il est disponible sur `/asyncapi.json` ; le signaling SFU
reste un contrat independant.

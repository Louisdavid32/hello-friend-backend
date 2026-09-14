# Plateforme `observability`

Mission : fournir logs structures, metriques Prometheus et traces OpenTelemetry sans changer le
resultat metier ni exposer de secrets.

Les noms d'evenement et labels sont bornes. Meeting, participant, session, connexion, IP, URL,
ticket, cookie, capability, JWT, ciphertext, SDP et ICE ne sont jamais des labels Prometheus.
Lorsqu'une correlation sensible est indispensable en log restreint, elle est pseudonymisee selon
politique.

L'etape realtime mesure au minimum upgrades/refus, sockets, auth timeout, messages/bytes, rate
limits, close codes allowlistes, backpressure, heartbeats, presence errors et event-loop lag. Aucun
corps de frame n'est logue.

Les exporters sont bornes et une panne telemetry ne bloque jamais le trafic. Le shutdown force-flush
dans une fraction de la deadline globale.

Preuves : `tests/log-sanitizer.test.ts`, `tests/telemetry.test.ts` et tests des metriques realtime.

References : [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/),
[Prometheus naming](https://prometheus.io/docs/practices/naming/).

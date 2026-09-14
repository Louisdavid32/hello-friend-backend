# Plateforme `health`

Mission : separer la vie du processus, sa capacite a servir et l'etat sanitise de ses dependances.

- `/live` prouve uniquement que le processus repond ;
- `/ready` exige phase `ready` et indicateurs obligatoires sains ;
- `beginDrain()` rend readiness rouge avant fermeture ;
- chaque probe a un timeout et respecte `AbortSignal` ;
- aucune probe ne mute une dependance ni ne revele sa topologie.

Pour le realtime, Redis tickets est bloquant pour nouvelles authentifications ; Redis presence peut
degrader les sockets existants vers `unknown`. Le payload public reste borne a des noms et etats
allowlistes.

Preuves : `tests/health.test.ts`, futurs tests de drain et de dependances partielles.

Reference :
[Kubernetes probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/).

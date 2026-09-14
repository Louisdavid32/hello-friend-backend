# Rapport de validation de l'etape 3

Date : 2026-09-14. Portee : backend applicatif Hello Friend uniquement. Le frontend et le SFU n'ont
pas ete modifies.

## 1. Decision

L'etape 3 est implementee et validee sur l'environnement local cible PostgreSQL 18.6 et Redis 8.2.9
autonome. Elle fournit les reunions anonymes create/join, l'authentification de session, les tickets
WSS a usage unique, le transport realtime strict, la presence reparable et l'outbox.

Cette decision ne signifie pas que l'application complete est prete pour la production. Le chat
durable E2EE, la moderation, le live, l'admission/commande SFU, la coordination E2EE media, Redis
Cluster, les essais de charge et la qualification preproduction restent des lots ou gates
ulterieurs.

## 2. Livrables documentaires

- `04-specification-fonctionnelle-modulaire.md` definit acteurs, droits, modes, parcours, refus,
  resilience mobile, acceptation et statut de chaque exigence ;
- chaque module et composant plateforme possede un `README.md` local avec mission, invariants,
  erreurs, securite, tests et references ;
- Swagger/OpenAPI documente les routes HTTP en developpement et en test ;
- TypeDoc verifie la documentation des contrats publics ;
- `03-modele-menaces-securite.md` reste la source des actifs, adversaires, frontieres de confiance
  et controles verifiables.

## 3. Fonctions validees

| Domaine      | Preuve obtenue                                                                        |
| ------------ | ------------------------------------------------------------------------------------- |
| Reunions     | creation hote, rejeu idempotent et jointure participant sur PostgreSQL reel           |
| Sessions     | cookie opaque, HMAC versionne, CSRF, binding appareil et revalidation SQL             |
| Tickets WSS  | 256 bits, digest Redis, `SET NX PX`, `GETDEL`, liaison au contexte et audit durable   |
| WebSocket    | chemin/origine/sous-protocole stricts, authentification bornee, heartbeat et drainage |
| Limites      | quotas par source/session/socket, taille de frame et backpressure                     |
| Presence     | Lua atomique, heure Redis, TTL, multi-onglet, snapshot et Sharded Pub/Sub             |
| Outbox       | ecriture atomique avec le metier, claim `SKIP LOCKED`, retry et dead letter           |
| Exploitation | readiness/liveness, metriques sans labels non bornes, logs structures et shutdown     |

## 4. Resultats automatises

La commande `npm run check` est passee integralement :

- formatage Prettier : passe ;
- ESLint sans avertissement : passe ;
- verification TypeScript stricte : passee ;
- validation TypeDoc : passee ;
- tests ordinaires : 22 fichiers passes, 2 suites d'infrastructure ignorees par defaut ;
- assertions ordinaires : 89 passees, 8 d'infrastructure ignorees par defaut ;
- build TypeScript : passe ;
- couverture : 83,33 % instructions, 71,47 % branches, 89,63 % fonctions et 87,19 % lignes.

Les suites reelles opt-in ont aussi ete executees :

- PostgreSQL 18.6 + Redis 8.2.9 : 5 scenarios passes ;
- Redis 8.2.9 : 3 scenarios passes ;
- cent consommations concurrentes d'un ticket : exactement un succes ;
- expiration, NX, scripts de presence, notification sharded et restauration de revision : passes.

## 5. Validation processus et bout en bout

Les quatre points d'entree compiles ont ete exerces avec les dependances reelles : `migration`,
`api`, `realtime` et `worker`. Les trois processus de service ont atteint une readiness `ok`. Une
connexion WSS non authentifiee a ete fermee avec le code attendu apres le delai d'authentification.

Un parcours manuel complet a retourne : creation HTTP 201, jointure HTTP 201, ticket HTTP 201, roles
`host` et `participant`, mode `video_conference`, ouverture WSS authentifiee et snapshot de presence
`available` contenant un participant.

## 6. Defauts trouves et corriges pendant la qualification

- les parametres UUID/text de l'ecriture audit/outbox sont maintenant castes explicitement pour
  PostgreSQL 18 ;
- les injections Nest sont explicites, y compris sous `tsx` sans metadata de constructeur emise ;
- le timeout Redis borne chaque commande et ne ferme plus une connexion simplement inactive ;
- Compose evite les ports locaux usuels deja occupes et protege Redis par mot de passe ;
- le heartbeat de presence prolonge la revision et la restaure atomiquement si sa cle a disparu.

## 7. Controles de securite et performance

Les secrets de session, capacites et tickets ne sont jamais stockes en clair. Les tickets ne
circulent ni dans l'URL ni dans le sous-protocole. Les pannes Redis refusent les nouvelles
authentifications au lieu d'accorder un faux succes. Les pools, files, frames, snapshots, timers et
retries sont bornes. La presence reste ephemere et reparable ; PostgreSQL reste l'autorite durable.

Le scan du depot ne trouve aucune cle privee ou jeton fournisseur. Les identifiants de Compose sont
des valeurs locales explicites et ne doivent jamais etre reutilises hors developpement.

## 8. Gates restantes

Avant production, il faut encore valider Redis Cluster et failover, executer les profils de charge
et de perte reseau, observer les budgets de latence/CPU/memoire, verifier le deploiement staging,
tester restauration PostgreSQL et rotation de secrets, puis passer les gates fonctionnelles des
modules ulterieurs. Aucune de ces gates n'est masquee par le statut de l'etape 3.

## 9. Tracabilite

Les exigences et scenarios sont lies a `04-specification-fonctionnelle-modulaire.md`. Les decisions
techniques restent dans `02-specification-architecture-backend.md`, les menaces dans
`03-modele-menaces-securite.md`, et les contrats de module dans `src/modules/*/README.md`. Aucun
push Git n'a ete effectue.

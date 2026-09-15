# Rapport de validation de l'etape 4

Date : 2026-09-15. Portee : backend applicatif Hello Friend uniquement. Le frontend et le SFU n'ont
pas ete modifies et aucun push Git n'a ete effectue.

## 1. Decision

L'etape architecturale 4, chat durable chiffre, est implementee et validee sur PostgreSQL 18.6,
Redis 8.2.9 et le transport WebSocket reel. Elle couvre l'acceptation transactionnelle T3,
l'idempotence, l'ordre durable par reunion, la pagination, le fanout temps reel, le rattrapage des
trous, la reprise outbox et la retention.

Cette decision ne pretend pas que le produit complet est pret pour la production. Les participants
restent en `pending_key_sync` et l'envoi renvoie `CHAT_KEY_SYNC_REQUIRED` tant que la distribution
MLS n'est pas implementee. L'admission SFU KMS/JWKS est l'etape architecturale 5 ; la coordination
MLS est l'etape 7. Ce verrou empeche explicitement d'accepter un message faussement E2EE.

## 2. Contrat fonctionnel livre

| Domaine         | Garantie implementee                                                                  |
| --------------- | ------------------------------------------------------------------------------------- |
| Autorisation    | session revalidee en SQL, participant actif, appareil public resolu et reunion isolee |
| E2EE applicatif | seul le ciphertext canonique est persiste ; epoch et membership sont controles        |
| Idempotence     | meme commande et meme contenu rejouent le resultat ; contenu different refuse         |
| Ordre           | position monotone par reunion sous verrou de ligne PostgreSQL                         |
| Historique      | curseur opaque, taille bornee et plancher fixe a la position de jointure              |
| Livraison       | commit PostgreSQL avant ACK, outbox leasee, retry, dead letter et reprise apres crash |
| Temps reel      | Sharded Pub/Sub par reunion, multiplexage, deduplication et rattrapage PostgreSQL     |
| Quotas          | token bucket Redis/Lua base sur `TIME`, avec repli local borne                        |
| Retention       | nettoyage par lots avec `FOR UPDATE SKIP LOCKED`                                      |
| Exploitation    | metriques bornees, erreurs stables, logs sans contenu et arret propre                 |

## 3. Protocole et documentation

- `src/modules/chat/README.md` porte les exigences `CHAT-001` a `CHAT-018`, les invariants, erreurs,
  flux, securite, performance, configuration et scenarios de test ;
- `src/contracts/realtime/v1/asyncapi.ts` genere le contrat AsyncAPI 3.0 depuis les schemas Zod
  reels afin de limiter la derive entre documentation et execution ;
- `/asyncapi.json` publie le contrat des commandes et evenements WebSocket lorsque la documentation
  et le service realtime sont actives ;
- TypeDoc verifie les classes, fonctions et contrats publics. Les blocs complexes documentent les
  invariants de concurrence et de securite ; les instructions triviales ne sont pas surchargees de
  commentaires repetitifs.

## 4. Resultats automatises

La validation ordinaire complete a obtenu :

- formatage Prettier : passe ;
- ESLint sans avertissement : passe ;
- verification TypeScript stricte : passee ;
- validation TypeDoc : passee ;
- audits npm, dependances de production puis arbre complet : 0 vulnerabilite signalee ;
- scan cible de cles privees et jetons fournisseur : aucun resultat ;
- 25 fichiers de tests passes et 3 suites d'infrastructure ignorees par defaut ;
- 115 assertions passees et 15 assertions d'infrastructure ignorees par defaut ;
- couverture : 82,49 % instructions, 72,44 % branches, 87,50 % fonctions et 86,21 % lignes.

Les suites opt-in sur les services reels ont obtenu :

- socle PostgreSQL/Redis : 5 scenarios passes ;
- chat PostgreSQL/WebSocket/outbox : 5 scenarios passes ;
- tickets/presence/fanout/quota Redis : 5 scenarios passes.

## 5. Scenarios critiques exerces

- envois concurrents avec positions uniques et strictement croissantes ;
- rejeu idempotent et conflit de contenu detecte par empreinte comparee en temps constant ;
- refus inter-reunions et resolution correcte d'un identifiant public d'appareil ;
- historique interdit avant la jointure d'un nouveau participant ;
- suppression de retention par lots sans bloquer tout le flux ;
- authentification WSS, abonnement avant rattrapage, ACK durable, evenement live et lecture SQL ;
- lease outbox expiree reprise par un autre worker apres simulation d'interruption ;
- notification Sharded Pub/Sub, quota atomique Redis et repli local borne.

## 6. Defauts trouves et corriges pendant la qualification

- les parametres SQL pouvant etre interpretes a la fois comme texte et UUID sont castes
  explicitement ;
- la jointure d'historique resout l'identifiant public d'appareil au lieu de le confondre avec la
  cle interne ;
- le worker chat peut etre active sans exposer les cles HTTP de reunion ;
- le module realtime importe explicitement Redis pour que l'injection Nest reelle soit valide ;
- l'outbox ne revendique que les destinations enregistrees par ce processus ;
- les frames Pub/Sub sont bornees avant `JSON.parse` et leur reunion est revalidee ;
- le test d'expiration Redis utilise une fenetre compatible avec l'ordonnancement CI sans reduire la
  contrainte testee ;
- les erreurs WebSocket transmettent uniquement des details classes comme surs et ne ferment pas la
  connexion pour une erreur metier recuperable.

## 7. Bases techniques verifiees

La conception suit la documentation PostgreSQL sur les verrous de ligne et `SKIP LOCKED`, la
semantique at-most-once de Redis Pub/Sub compensee par PostgreSQL/outbox/catch-up, AsyncAPI 3.0 pour
le contrat asynchrone et les controles OWASP WebSocket. Les references exactes sont conservees dans
le README du module chat et dans la specification d'architecture.

## 8. Gates restantes

L'etape suivante du plan directeur est l'etape 5 : emission d'une admission SFU courte duree, signee
par KMS, validation par JWKS, liaison reunion/participant/appareil/role et commandes de moderation
idempotentes. Elle ne doit pas contourner le verrou `pending_key_sync`.

Restent ensuite MLS/E2EE effectif, live, moderation complete, reprise multi-region, essais de
charge/perte reseau, Redis Cluster, sauvegarde/restauration, rotation reelle des secrets et
qualification staging. Ces gates restent visibles et aucune n'est declaree terminee par ce rapport.

## 9. Tracabilite

Les exigences fonctionnelles sont dans `04-specification-fonctionnelle-modulaire.md`, les decisions
dans `02-specification-architecture-backend.md`, les menaces dans `03-modele-menaces-securite.md` et
les contrats locaux dans `src/modules/*/README.md`.

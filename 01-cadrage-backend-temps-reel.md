# Cadrage du backend temps reel Hello Friend

## 1. Decision executive

Hello Friend a besoin d'un backend applicatif distinct du SFU. Le navigateur ne doit pas obtenir des secrets permanents ni fabriquer seul ses droits d'acces. Le backend doit creer les reunions, attribuer des capacites temporaires, autoriser l'entree dans le SFU, maintenir l'etat applicatif et fournir une messagerie temps reel durable.

Le backend ne doit pas transporter l'audio ou la video. Apres admission, le navigateur communique directement avec le SFU pour la signalisation et les medias WebRTC. Cette separation respecte le role de mediasoup, qui laisse volontairement le protocole de signalisation et l'identite des participants a l'application.[^1]

Le socle recommande pour la specification d'architecture est :

| Domaine | Choix de cadrage | Motif principal |
|---|---|---|
| Runtime | Node.js 24 LTS | Ligne LTS maintenue jusqu'en avril 2028; les versions en fin de vie ne doivent pas etre deployees.[^2][^63] |
| Langage | TypeScript strict | Continuite avec le frontend et le SFU, contrats partages et validation statique. |
| Framework | NestJS avec adaptateur Fastify | Modules, injection de dependances, guards, validation, observabilite, performance et organisation explicite.[^3][^4][^64] |
| Temps reel | WebSocket natif securise, RFC 6455, via l'adaptateur `ws` de NestJS | Protocole navigateur natif, sans simulation ni polling; NestJS prend officiellement en charge `ws`.[^5][^6] |
| Base durable | PostgreSQL 18, toujours sur le dernier correctif mineur, actuellement 18.6 | Version stable majeure la plus recente, maintenue jusqu'au 14 novembre 2030.[^7] |
| Etat volatil | Redis Open Source 8.2 Extended ou service compatible gere | Presence, TTL, quotas, coordination et diffusion rapide; branche de support etendu jusqu'en septembre 2030.[^8] |
| Chiffrement de groupe | MLS comme cible de protocole pour le chat, sous reserve de validation de l'implementation | Standard IETF pour etablir des secrets de groupe avec forward secrecy et post-compromise security.[^9][^10] |
| E2EE media | WebRTC Encoded Transform cote client | Permet de transformer les trames encodees avant leur passage par le SFU.[^11] |
| Telemetrie | OpenTelemetry, metriques Prometheus et journaux structures | Correlation des requetes HTTP, connexions WebSocket, traitements asynchrones et appels au SFU.[^12][^13] |

Ce document est un cadrage, pas encore la specification executable. Il fixe les responsabilites, les invariants et les decisions a prendre. Les schemas SQL, les contrats HTTP/WebSocket exhaustifs, les diagrammes de sequence, les budgets de concurrence et les choix de bibliotheques seront arretes dans le document d'architecture suivant.

## 2. Besoin produit confirme

Le produit doit proposer trois experiences utilisant le meme socle de reunion :

| Mode | Media | Interaction confirmee | Etat applicatif attendu |
|---|---|---|---|
| Visioconference | Audio et video multidirectionnels | Tous les participants autorises peuvent publier et envoyer des messages | Participants, roles, presence, chat, etat de reunion, admission SFU |
| Appel audio | Audio multidirectionnel | Participants autorises, sans video | Meme cycle de vie qu'une reunion, politiques media limitees a l'audio |
| Live | Une ou plusieurs sources publient vers une audience | Chat de masse en direct; politique exacte des emetteurs et de moderation a confirmer | Hote, presentateurs, audience, chat, limites de charge, cycle du live |

La messagerie de visioconference est un vrai chat :

- envoi et reception en temps reel;
- historique defilable et pagine;
- possibilite d'afficher des messages envoyes avant l'ouverture du panneau de chat;
- conservation durable selon une duree encore a decider;
- reconnexion sans doublons visibles ni trou silencieux dans l'historique;
- chiffrement de bout en bout du contenu;
- acces en ecriture pour tous les participants autorises de la visioconference.

La phrase precedemment transmise sous la forme « timegate, ecrit, sixieme, iOS » est explicitement ignoree comme faute de frappe. Elle ne cree aucune exigence concernant les accusés de lecture, les reactions, les indicateurs de saisie ou les notifications mobiles.

## 3. Objectifs

Le backend doit atteindre les objectifs suivants :

1. Permettre de creer une reunion sans creer de compte utilisateur.
2. Produire un lien ou un code de partage pour les invites et une capacite separee pour l'hote.
3. Autoriser chaque action en fonction de la reunion, du participant ephemere, du role et de l'etat courant.
4. Delivrer des jetons d'admission SFU courts et renouvelables, sans exposer la cle de signature au frontend.
5. Fournir un protocole WebSocket versionne, reel, securise et observable.
6. Rendre les messages durables, ordonnes par reunion, idempotents et recuperables apres reconnexion.
7. Stocker uniquement le texte chiffre lorsque l'E2EE est active; le backend ne doit pas posseder les cles de contenu.
8. Se comporter proprement lors des pertes reseau, redemarrages, doubles envois, ralentissements et pannes partielles.
9. Monter horizontalement sans attacher la verite metier a la memoire d'une instance.
10. Integrer le SFU par ses contrats publics, sans modifier ou fragiliser son coeur media.

## 4. Hors perimetre et non-decisions

Les elements suivants ne sont pas demandes ou ne sont pas encore suffisamment definis. Ils ne doivent pas etre implementes implicitement :

- comptes, mots de passe, profils globaux, connexion sociale ou annuaire d'utilisateurs;
- reactions, emojis, indicateur de saisie, accusés lu/recu et notifications iOS;
- pieces jointes, partage de fichiers et recherche plein texte;
- transcription, traduction, sous-titres et intelligence artificielle;
- facturation et abonnements;
- duree exacte de retention des reunions et messages;
- nombre maximal de participants par visioconference, appel et live;
- debit maximal du chat de live;
- politique de moderation du chat de live;
- enregistrement lorsque l'E2EE media est active;
- acces d'un nouvel arrivant aux messages E2EE anterieurs a son admission.

Une fonctionnalite absente de cette liste et non confirmee par le besoin doit passer par une decision explicite avant implementation.

## 5. Frontieres du systeme

### 5.1 Backend applicatif

Le backend est responsable de :

- creer, ouvrir, terminer et expirer une reunion;
- valider un code ou une capacite de reunion;
- attribuer une identite ephemere a un appareil pour cette reunion;
- gerer les roles et autorisations;
- emettre et renouveler les admissions SFU;
- conserver l'etat durable de la reunion;
- accepter, persister et distribuer les enveloppes de chat chiffrees;
- gerer les curseurs de rattrapage et l'idempotence;
- distribuer les messages de controle cryptographique necessaires aux membres;
- appliquer les quotas, limites de taille et controles anti-abus;
- exposer sante, disponibilite, metriques, traces et journaux non sensibles;
- publier les evenements metier necessaires a l'exploitation.

### 5.2 SFU

Le SFU reste responsable de :

- la signalisation mediasoup deja definie;
- les transports WebRTC, ICE, DTLS, RTP/RTCP et TURN;
- les producteurs, consommateurs, simulcast/SVC et adaptation QoS;
- le placement et la reprise des salles media;
- les metriques et evenements propres au media;
- l'application des droits contenus dans l'admission SFU.

Le contrat deja pose par le SFU exige aussi que le backend puisse decouvrir le noeud proprietaire d'une room, terminer une room ou revoquer un participant via l'API interne, et consommer les evenements Kafka versionnes. Ces integrations passent par des contrats publics; le backend ne manipule jamais directement les objets mediasoup.

Le SFU possede deja les transforms clientes AES-256-GCM permettant de router des trames opaques, ainsi que les garde-fous qui interdisent l'enregistrement dans une room E2EE. Ce qui manque pour pouvoir annoncer une E2EE de production est justement le service backend de creation, distribution authentifiee, rotation, revocation et recuperation des cles de groupe. Le nouveau backend doit combler ce manque sans deplacer les cles dans le SFU.

mediasoup ne fournit pas de protocole de signalisation impose. Il permet a l'application de choisir WebSocket, HTTP ou un autre canal bidirectionnel et expose egalement les DataChannels.[^1][^14] Pour Hello Friend, le chat durable ne sera cependant pas place uniquement dans un DataChannel : un participant hors ligne, reconnecte ou nouvellement autorise a besoin d'une source durable et d'un rattrapage ordonne. Le DataChannel pourra rester reserve a des donnees ephemeres si une specification ulterieure en justifie le besoin.

### 5.3 Frontend

Le frontend est responsable de :

- conserver localement la capacite de reprise de son participant ephemere;
- generer et proteger ses cles E2EE d'appareil;
- chiffrer avant envoi et dechiffrer apres reception;
- verifier les erreurs et versions de protocole;
- maintenir une file locale d'envois en attente;
- reprendre le chat a partir du dernier curseur confirme;
- communiquer directement avec le SFU une fois admis;
- afficher sans ambiguite les etats de reconnexion et les erreurs irrecuperables.

### 5.4 Interdictions de couplage

- Le backend ne doit pas importer les modules internes du SFU.
- Le SFU ne doit pas acceder directement aux tables du backend.
- Redis ne doit pas devenir une base commune implicite entre services sans contrat de cle versionne.
- Le frontend ne doit contenir aucune cle privee de signature, aucun secret TURN permanent et aucun secret d'infrastructure.
- Le backend ne doit pas relayer les flux audio/video normaux.
- Un changement de protocole doit etre versionne et teste des deux cotes avant activation.

## 6. Mode sans comptes

L'absence de comptes ne signifie pas l'absence d'autorisation. WebSocket n'inclut aucun mecanisme d'authentification applicative; chaque connexion et chaque action doivent etre autorisees explicitement.[^15][^16]

Le modele minimal comprend :

- une reunion identifiable par un identifiant public non secret;
- une capacite d'hote a forte entropie, distincte du lien invite;
- un lien ou code d'invitation donnant seulement les droits invites;
- un `participant_id` ephemere, limite a une reunion;
- une paire de cles d'appareil pour l'E2EE;
- un jeton backend court pour la connexion et sa reprise;
- un jeton SFU distinct, court, signe par l'autorite d'admission;
- une date d'expiration et un mecanisme de revocation.

L'invite choisit un nom d'affichage. Ce nom n'est pas une identite verifiee et ne doit jamais servir de cle d'autorisation. Deux participants peuvent choisir le meme nom; l'interface les distingue par leur identifiant ephemere.

Le lien hote doit etre traite comme une capacite sensible. Une personne qui le possede obtient les droits d'hote. La specification d'architecture devra choisir un transport qui evite sa fuite dans les journaux, referers, captures d'URL et outils d'analytique. Les codes humains courts exigent limitation de debit, verrouillage progressif et detection d'enumeration.

Il n'y a pas de session utilisateur globale. Il existe uniquement une session technique de reunion, necessaire pour reprendre une connexion, renouveler les jetons courts et conserver l'identite cryptographique de l'appareil pendant la reunion.

Les roles metier sans comptes doivent etre traduits vers le vocabulaire deja accepte par le SFU : `host`, `speaker` ou `viewer`. Le role seul n'accorde aucun droit. Le backend remplit separement la liste stricte de permissions, par exemple rejoindre, creer un transport montant ou descendant, produire audio/video, consommer, moderer ou gerer l'enregistrement.

## 7. Cycle de vie conceptuel

Les noms exacts seront fixes par la specification, mais le domaine doit distinguer au minimum :

- reunion creee mais pas encore ouverte;
- reunion ouverte aux admissions;
- reunion ou live actif;
- reunion en cours de terminaison;
- reunion terminee;
- reunion expiree et eligible a la purge.

Les transitions sensibles, ouverture, terminaison, changement de role, exclusion et fermeture des admissions, sont autorisees par le backend et produisent un evenement durable. Une commande repetee avec la meme cle d'idempotence doit produire le meme resultat logique.

Le backend ne doit pas deduire l'existence durable d'une reunion de la seule presence d'une salle en memoire dans le SFU. Inversement, une reunion durable ne garantit pas qu'un worker media soit deja alloue. La creation logique et l'allocation media sont deux etapes coordonnees avec des compensations et des delais explicites.

## 8. Messagerie temps reel et historique

### 8.1 Principe de fiabilite

Redis Pub/Sub est adapte a la diffusion rapide entre instances, mais sa semantique est « at most once » : un abonne deconnecte peut perdre definitivement une publication.[^17] Il ne peut donc pas etre la source de verite du chat.

La regle imposee est :

1. Le client attribue une cle d'idempotence unique a chaque tentative logique.
2. Le backend valide l'enveloppe, les droits, la taille et le quota.
3. Le message chiffre et un evenement de sortie sont ecrits atomiquement dans PostgreSQL.
4. Un numero de sequence monotone dans la reunion est attribue cote serveur.
5. Un worker publie l'evenement vers Redis pour les instances WebSocket.
6. Les clients connectes recoivent l'enveloppe en direct.
7. Apres coupure, le client demande tout ce qui suit son dernier curseur confirme.
8. Les doublons sont absorbes a partir de la cle d'idempotence et de l'identifiant serveur.

Le mecanisme precis peut utiliser un transactional outbox PostgreSQL et Redis Pub/Sub ou Streams. Redis Streams persiste ses entrees et propose des groupes de consommateurs; `XADD` et `XREADGROUP` sont les primitives officielles correspondantes.[^18][^19] Le choix final doit etre justifie par les garanties voulues, le volume et la complexite operationnelle. Dans tous les cas, l'historique utilisateur durable reste dans PostgreSQL.

### 8.2 Ordre et pagination

L'ordre d'affichage canonique est le numero de sequence serveur dans une reunion, pas l'horloge du navigateur. L'horodatage serveur est informatif. L'heure cliente peut etre conservee dans l'enveloppe signee, mais ne determine ni l'ordre ni les droits.

L'historique est pagine par curseur stable, jamais uniquement par `OFFSET`. Le frontend peut charger les messages les plus recents puis remonter vers les plus anciens. Une reconnexion utilise un curseur « apres sequence N » afin de combler tous les trous avant de reprendre le flux direct.

PostgreSQL fournit les transactions, le MVCC, plusieurs niveaux d'isolation, des index et du verrouillage explicite.[^20][^21][^22][^23] La specification devra definir la transaction qui attribue les sequences sans serialiser inutilement toutes les reunions entre elles.

### 8.3 Donnees durables minimales

Chaque enregistrement de chat doit pouvoir contenir, sans texte clair :

- identifiant de reunion;
- identifiant de message serveur;
- sequence de reunion;
- identifiant ephemere de l'emetteur;
- cle d'idempotence client;
- type et version d'enveloppe;
- ciphertext authentifie et parametres publics requis;
- identifiant d'epoque ou de groupe cryptographique;
- date serveur de reception;
- eventuelle date d'expiration;
- etat de suppression logique si cette fonction est plus tard confirmee.

Les contraintes d'unicite sur la cle d'idempotence et la sequence rendent l'operation verifiable. Les index suivent les parcours reels : derniers messages d'une reunion, page avant un curseur, rattrapage apres un curseur et purge par expiration. Le partitionnement n'est introduit qu'apres mesures montrant son utilite; PostgreSQL documente ses benefices mais aussi les contraintes de conception et de maintenance.[^24]

### 8.4 Retour de pression

Le protocole doit definir :

- taille maximale d'une enveloppe;
- nombre maximal de messages en attente par connexion;
- quotas par participant, reunion et adresse reseau;
- comportement lorsque la file d'envoi serveur est saturee;
- delai d'acquittement et politique de nouvelle tentative;
- codes d'erreur stables pour surcharge, quota, message trop grand et version incompatible;
- ping/pong, detection de connexion morte et nettoyage deterministe.

OWASP recommande WSS, validation stricte de l'origine, autorisation par message, limites de taille, limitation de debit, heartbeat et backpressure pour eviter l'epuisement memoire.[^16]

## 9. Chiffrement de bout en bout

### 9.1 Definition exigee

TLS/WSS chiffre le transport entre le client et le serveur, mais le serveur peut normalement lire le contenu. Cela n'est pas de l'E2EE. Pour pouvoir annoncer un chat E2EE contre le backend, le plaintext et les cles de contenu doivent n'exister que sur les appareils autorises. Le backend agit comme service d'admission et de livraison, et stocke des enveloppes chiffrees.

Le backend voit necessairement certaines metadonnees : identifiant de reunion, taille approximative, moment d'envoi, identifiant ephemere, volume et topologie de livraison. Le produit ne doit donc pas promettre l'anonymat des metadonnees.

### 9.2 Chat de groupe

MLS est la cible de cadrage pour la gestion des cles de chat de groupe. Le standard couvre des groupes de deux a des milliers de clients, des changements de membres, la forward secrecy et la securite apres compromission.[^9] Son architecture separe un service d'authentification et un service de livraison largement non fiable pour la confidentialite.[^10]

MLS emploie notamment HPKE pour chiffrer du materiel destine a un client donne. Toute implementation doit donc respecter le profil MLS choisi et la specification HPKE, sans substituer une construction locale.[^61]

Dans Hello Friend sans comptes, le service d'authentification MLS ne peut pas certifier une identite humaine persistante. Il peut uniquement attester qu'une cle d'appareil a ete admise dans une reunion avec un role donne. Cette limitation doit etre visible dans le modele de menace et dans le vocabulaire produit.

Le backend peut conserver et transmettre :

- KeyPackages ou materiel public equivalent;
- propositions d'ajout/retrait;
- commits d'epoque;
- messages Welcome chiffres pour les nouveaux membres;
- enveloppes applicatives chiffrees;
- etat public necessaire a la synchronisation.

Il ne doit pas conserver les secrets d'epoque en clair. La bibliotheque retenue devra etre maintenue, testee sur les plateformes cibles et soumise a une revue de securite. OpenMLS constitue une implementation de reference utile, mais son adoption ou son integration WebAssembly ne doit pas etre decidee sans prototype, audit de compatibilite et strategie de mise a jour.[^25]

### 9.3 Contradiction a arbitrer : ancien historique et nouvel arrivant

MLS prevoit qu'un membre nouvellement ajoute peut lire les nouveaux messages, mais pas ceux emis avant son ajout.[^9] Cela entre en tension avec le souhait qu'un participant voie des messages anterieurs.

Deux politiques sont valides, mais elles ne peuvent pas etre presentees comme la meme garantie :

| Politique | Effet | Garantie perdue ou preservee |
|---|---|---|
| Historique strict par appartenance | Le nouvel arrivant ne dechiffre que les messages a partir de son admission | Preserve la confidentialite des epoques anterieures vis-a-vis des nouveaux membres |
| Historique partage aux nouveaux admis | Un membre existant ou un mecanisme client autorise remet des cles d'historique ciblees au nouvel arrivant | Permet l'historique, mais renonce volontairement a la confidentialite des anciens messages vis-a-vis de ce nouvel arrivant |

Cette decision doit etre prise avant le schema cryptographique et les tests d'acceptation. Le serveur ne doit pas contourner le choix en detenant lui-meme toutes les cles, car cela supprimerait l'E2EE contre le backend.

### 9.4 Media audio et video

WebRTC chiffre deja les segments entre chaque navigateur et le SFU, mais le SFU termine normalement ce chiffrement de transport. Pour une E2EE media reelle, le frontend doit chiffrer la charge utile des trames encodees avant leur envoi et la dechiffrer apres reception, avec WebRTC Encoded Transform.[^11][^26]

Le SFU doit continuer a lire les informations indispensables au routage et a l'adaptation sans acceder au contenu media. La gestion des cles media doit etre coordonnee avec l'appartenance a la reunion, les exclusions, les changements d'epoque, la reconnexion et les appareils multiples.

Les consequences doivent etre acceptees explicitement :

- l'enregistrement serveur en clair est incompatible avec l'E2EE stricte, sauf bot enregistreur admis comme endpoint et visible des participants;
- la moderation automatique du contenu audio/video cote serveur devient impossible;
- les outils de transcodage qui ont besoin du contenu ne peuvent pas fonctionner sans devenir endpoint autorise;
- les navigateurs non compatibles doivent etre refuses ou basculer dans un mode clairement etiquete, jamais silencieusement moins securise.

### 9.5 Chat du live

L'E2EE du chat de visioconference est confirmee. Son extension au chat d'un live de masse reste a decider. Dans un grand live, l'E2EE de groupe, la moderation, l'arrivee continue de spectateurs et l'acces a l'historique ont des couts et objectifs contradictoires. Le document d'architecture devra proposer des profils distincts apres fixation du besoin :

- live prive avec audience admise et chat E2EE;
- live public avec chat chiffre en transport, moderation serveur et aucune promesse E2EE;
- live public avec E2EE et moderation uniquement par signalement volontaire cote client.

Aucun profil ne doit etre selectionne silencieusement.

### 9.6 Pratiques cryptographiques

- Ne pas inventer d'algorithme ou de protocole maison.
- Utiliser des primitives authentifiees et des sources aleatoires cryptographiques fournies par les plateformes.[^27]
- Separer les cles des donnees chiffrees et definir generation, activation, rotation, revocation, sauvegarde et destruction.[^28][^29][^62]
- Versionner les suites et enveloppes pour permettre les migrations.
- Authentifier les metadonnees critiques comme donnees associees.
- Effacer les secrets de la memoire et du stockage local lorsque la plateforme le permet.
- Ne jamais journaliser plaintext, cles, jetons complets ou enveloppes privees inutiles.

## 10. Architecture logique cible

Le backend peut etre deploye initialement comme un monolithe modulaire, avec processus de workers separables, sans melanger les responsabilites dans de gros fichiers. « Monolithe modulaire » signifie une seule unite de livraison possible, pas un seul module ni un seul fichier.

Modules de domaine envisages :

| Module | Responsabilite | Ne doit pas faire |
|---|---|---|
| `meetings` | Cycle de vie et configuration des reunions | Manipuler les transports mediasoup internes |
| `participants` | Identites ephemeres, roles et presence logique | Dechiffrer les messages |
| `capabilities` | Liens/codes, jetons courts, revocation | Stocker des secrets en clair dans les journaux |
| `sfu-admission` | Adapter le contrat backend vers l'admission SFU | Proxifier les medias |
| `realtime` | Connexions WSS, protocole, heartbeat, backpressure | Porter les regles metier directement dans les gateways |
| `chat` | Validation, ordre, idempotence, persistance, historique | Utiliser Redis comme verite durable |
| `e2ee` | Livraison du materiel public et des messages de controle | Posseder les secrets de contenu |
| `presence` | Connexions actives, TTL et diffusion | Produire un historique durable implicite |
| `outbox` | Publication fiable des evenements valides | Reexecuter sans idempotence |
| `observability` | Logs, metriques, traces, correlation | Capturer le contenu prive |
| `health` | Liveness, readiness et dependances | Declarer pret avant migrations ou connexions critiques |

Les controllers HTTP et gateways WebSocket traduisent le transport vers des commandes applicatives. Les services applicatifs orchestrent les cas d'usage. Le domaine contient les invariants sans dependance a NestJS, PostgreSQL, Redis ou au SFU. Les adapters d'infrastructure implementent les ports. NestJS fournit modules et injection de dependances; les providers peuvent etre scopes et remplaces dans les tests.[^3][^30]

Les types de protocole, constantes de domaine, schemas de validation, services et adapters restent dans des fichiers ou repertoires dedies. Un fichier ne doit pas accumuler types publics, variables d'environnement, logique de transport, acces SQL et regles metier.

## 11. Donnees et concurrence

### 11.1 PostgreSQL

PostgreSQL est la source de verite pour :

- reunions et etat durable;
- capacites sous forme non reutilisable directement, par exemple empreintes ou secrets chiffres selon le cas;
- participants ephemeres et roles;
- messages chiffres et sequences;
- materiel public et messages de controle E2EE necessaires a la reprise;
- outbox, idempotence et audit de securite minimal;
- politiques de retention et marqueurs de purge.

Les migrations sont versionnees, testees en montee et lorsque possible en retour. Les changements de schema compatibles sont deployes avant le code qui les exige. Les transactions doivent etre courtes. Les verrous et niveaux d'isolation sont choisis par invariant, pas globalement au niveau maximal.[^21][^22]

Pour la production, sauvegardes, restauration point-in-time, replication et test regulier de restauration sont obligatoires. PostgreSQL documente l'archivage WAL, le warm standby et le suivi des statistiques.[^31][^32][^33]

`LISTEN/NOTIFY` peut signaler un changement local, mais ne remplace ni l'outbox durable ni Redis pour la diffusion multi-instance. Les notifications sont delivrees apres commit et les applications doivent gerer leur fenetre d'initialisation.[^34][^35]

### 11.2 Redis

Redis porte uniquement les donnees reconstruisibles ou temporaires :

- presence avec TTL;
- compteurs et fenetres de rate limiting;
- routage connexion-vers-instance;
- cache de validations courtes;
- diffusion des evenements apres persistance;
- verrous distribues uniquement lorsque l'invariant ne peut pas etre mieux exprime en base.

Les expirations, l'eviction, la persistence et la replication doivent etre configurees consciemment.[^36][^37][^38][^39] Le pipelining peut reduire les allers-retours pour des lots independants, mais il ne remplace ni transaction ni controle de taille des lots.[^66] Redis doit etre protege par segmentation reseau, TLS lorsque disponible, ACL minimales et comptes distincts par service.[^40][^41]

Un verrou Redis n'est pas un substitut automatique a une contrainte unique ou transaction PostgreSQL. Lorsque necessaire, son TTL, son token aleatoire, sa liberation compare-and-delete et le comportement lors d'une partition doivent suivre un protocole explicite.[^42]

### 11.3 Concurrence applicative

- Toute commande modifiant un invariant possede une cle d'idempotence.
- Les effets externes sont emis depuis l'outbox, pas avant le commit.
- Les consumers sont idempotents et tolerent les livraisons repetees.
- Les operations longues sont annulables avec timeout et signal de cancellation.
- Une deconnexion annule listeners, timers, abonnements et references de socket.
- Les files ont des bornes; aucune liste en memoire ne grandit sans limite.
- Le traitement est serialise seulement par reunion ou ressource concernee lorsque l'ordre l'exige.
- Chaque reprise apres crash est testee entre les etapes critiques.

## 12. Protocoles externes a specifier

### 12.1 HTTP de controle

La specification suivante devra definir au minimum les contrats pour :

- creer une reunion et retourner separement les capacites hote/invite;
- obtenir les informations publiques d'une reunion;
- rejoindre ou reprendre comme participant ephemere;
- renouveler un jeton backend et une admission SFU;
- terminer une reunion;
- paginer l'historique chiffre;
- publier ou recuperer le materiel public E2EE;
- exposer liveness, readiness et version de protocole.

La documentation OpenAPI sera generee depuis des schemas uniques, sans dupliquer manuellement les DTO.[^43] Toutes les entrees sont validees et les proprietes inconnues interdites selon le contexte; NestJS et Fastify fournissent des mecanismes officiels de validation et serialisation.[^4][^44]

### 12.2 WebSocket de chat

Le sous-protocole applicatif doit etre versionne et documenter :

- handshake et authentification de reunion;
- negotiation de version;
- enveloppe commune avec `type`, identifiant de requete, version et payload valide;
- envoi d'un message chiffre;
- acquittement d'acceptation durable;
- evenement message disponible;
- rattrapage apres curseur;
- membres ajoutes/retires et messages E2EE de controle;
- ping/pong, expiration et renouvellement de jeton;
- surcharge, fermeture et codes d'erreur;
- limites et politique de reconnexion avec jitter.

RFC 6455 et le standard vivant WHATWG definissent WebSocket; RFC 8441 et RFC 9220 decrivent son bootstrap sur HTTP/2 et HTTP/3.[^45][^60][^46][^47] Leur disponibilite dependra du proxy et du load balancer. Le contrat applicatif reste independant de la version HTTP utilisee pour etablir la connexion.

### 12.3 Contrat SFU

L'integration doit suivre la reference cliente et la version du protocole SFU deja presentes dans le depot SFU. Le backend emet un jeton contenant uniquement les claims necessaires, notamment reunion, participant, roles, operations media, audience, expiration, issuer et audience cryptographique.

Le contrat actuel exige exactement un header de type `sfu-admission+jwt` et les claims `iss`, `aud`, `sub`, `iat`, `exp`, `jti`, `tokenUse`, `roomId`, `role` et `permissions`. `nbf`, `displayName`, `tenantId` et `deviceId` sont optionnels. Pour Hello Friend sans comptes, `tenantId` reste absent tant qu'un besoin multi-tenant n'est pas confirme. `jti` est unique et le jeton est a usage unique; le TTL maximal SFU par defaut est de 300 secondes.

Les JWT doivent respecter un profil ferme : algorithmes explicitement autorises, validation stricte de `iss`, `aud`, `exp`, `nbf`, type explicite, identifiant de cle et rotation. La BCP JWT avertit notamment contre la confusion d'algorithme et la validation incomplete.[^48][^49]

La cle privee de signature ne quitte jamais le backend ou le gestionnaire de secrets. Le SFU ne recoit que les cles publiques necessaires. Le frontend ne recoit que le jeton court signe.

## 13. Securite applicative

Menaces minimales a couvrir :

- enumeration ou brute force des codes de reunion;
- vol d'une capacite d'hote;
- rejeu d'une commande ou d'une enveloppe;
- participant exclu qui conserve une connexion ouverte;
- changement de role concurrent a un envoi;
- Cross-Site WebSocket Hijacking;
- origine non autorisee;
- message JSON malforme, trop grand ou profond;
- inondation de connexions ou de messages;
- file de sortie lente qui epuise la memoire;
- injection SQL, XSS stockee apres dechiffrement cote client et log injection;
- fuite de jetons, cles ou plaintext dans logs, traces, erreurs et metriques;
- dependance compromise;
- rollback de protocole ou downgrade E2EE;
- divergence entre appartenance backend, groupe E2EE et admission SFU.

Controles obligatoires :

- HTTPS/WSS uniquement en production;
- allowlist exacte de `Origin` au handshake;
- jeton court ou message d'authentification qui n'apparait pas dans l'URL et les access logs;
- autorisation a chaque commande, pas seulement a la connexion;
- validation structurelle avec limites de taille et profondeur;
- quotas par capacite, participant, reunion, IP et infrastructure, avec une implementation testable de limitation de debit.[^65]
- nonces, idempotence et fenetres temporelles contre le rejeu;
- rotation et revocation des admissions;
- fermeture active des connexions d'un membre retire;
- rekey E2EE apres changement de membres;
- journaux de securite sans contenu sensible;
- inventaire et analyse des dependances;
- gestionnaire de secrets en staging et production;
- suppression et rotation de tout secret permanent deja expose dans le frontend.

## 14. Pannes et comportement degrade

| Incident | Comportement cible |
|---|---|
| Coupure navigateur | Reconnexion avec backoff et jitter, reprise d'identite ephemere, rattrapage apres curseur |
| Double envoi client | Une seule insertion logique grace a l'idempotence |
| Redis indisponible | Aucune perte durable; diffusion temps reel degradee, rattrapage depuis PostgreSQL; readiness ajustee selon le niveau de service possible |
| PostgreSQL indisponible | Refus explicite des nouvelles mutations; ne jamais confirmer un message non durable |
| Instance backend arretee | Connexion retablie vers une autre instance; etat reconstruit depuis PostgreSQL et Redis |
| Worker outbox arrete | Evenements restent en attente et sont republies idempotemment au redemarrage |
| SFU indisponible | Reunion logique conservee; admission ou connexion media echoue avec erreur recuperable et nouvelle tentative bornee |
| Participant exclu | Jetons revoques, sockets fermees, admission SFU retiree, nouvelle epoque E2EE |
| Client lent | File bornee; degradation ou fermeture explicite avant epuisement memoire |
| Version incompatible | Fermeture avec code documente et aucune interpretation approximative |

La disponibilite reelle exigera plusieurs instances, repartition de charge, arrets gracieux et repartition topologique. Kubernetes fournit des primitives pour limiter les disruptions volontaires et repartir les pods entre domaines de panne.[^50][^51] Leur configuration exacte dependra des objectifs de charge et de disponibilite encore a fixer.

## 15. Observabilite et exploitation

Le backend doit etre observable des sa premiere fonctionnalite :

- logs JSON structures avec `trace_id`, `request_id`, `meeting_id` pseudonymise, type d'evenement et code d'erreur;
- traces distribuees HTTP, WebSocket, PostgreSQL, Redis, outbox et appel d'admission SFU;
- metriques de connexions actives, admissions, refus, latences, messages acceptes, erreurs, files, rattrapages et consommation memoire;
- histogrammes pour latences et tailles, avec buckets choisis a partir des SLO, pas arbitrairement; Prometheus documente les compromis des histogrammes.[^13]
- liveness pour le processus, readiness pour sa capacite a servir correctement et startup probe si les migrations ou prechauffages le necessitent;
- tableaux de bord et alertes associes a des actions d'exploitation;
- correlation backend/SFU sans reutiliser de secrets comme identifiants;
- redaction automatique des champs sensibles.

OpenTelemetry JavaScript permet l'instrumentation Node.js et l'export de traces et metriques.[^12] Les endpoints de sante peuvent utiliser les patterns Terminus de NestJS, mais doivent verifier les dependances selon leur impact reel.[^52]

## 16. Performance et capacite

Il est impossible de declarer le backend « complet et performant » sans charge cible. Les valeurs suivantes doivent etre fournies ou mesurees avant dimensionnement :

- participants simultanes globaux;
- reunions simultanees;
- taille maximale d'une visioconference et d'un appel audio;
- audience maximale d'un live;
- messages par seconde moyens et en pic par live;
- taille moyenne et maximale des enveloppes chiffrees;
- duree de retention et volume historique;
- regions de deploiement et latence cible;
- disponibilite et RPO/RTO attendus;
- proportion de reconnexions massives apres incident.

La validation de performance doit couvrir :

- HTTP creation/join/refresh;
- connexions et reconnexions WebSocket;
- broadcast d'une reunion et d'un live;
- persistance et lecture paginee;
- lag de l'outbox;
- panne Redis et rattrapage;
- panne/reprise PostgreSQL;
- consommation CPU, memoire, descripteurs et event-loop lag;
- backpressure avec clients lents;
- tempete de reconnexion;
- interaction avec le SFU sous charge media.

mediasoup recommande en general un worker par coeur CPU et explique les mecanismes de repartition et de piping entre routers.[^53] Le dimensionnement media reste celui du SFU et ne doit pas etre extrapole aux instances backend.

## 17. Strategie de tests de bout en bout

### 17.1 Contrats

- Validation de tous les schemas HTTP et WebSocket.
- Compatibilite entre versions supportees.
- Verification des claims d'admission avec la cle publique SFU.
- Tests contractuels contre la reference cliente SFU.
- Rejet des champs inconnus, types invalides, messages trop grands et versions non supportees.

### 17.2 Reunions sans comptes

- Creation d'une reunion.
- Separation effective hote/invite.
- Entree par lien ou code.
- Deux invites portant le meme nom restent distincts.
- Capacite expiree, revoquee ou falsifiee refusee.
- Reprise sur le meme appareil et rejet d'une reprise volee.

### 17.3 Chat

- Deux onglets echangent de vraies enveloppes via WSS.
- Tous les participants autorises d'une visio peuvent envoyer.
- Historique pagine sans doublon ni trou.
- Message rejoue ne cree pas de doublon.
- Coupure entre commit PostgreSQL et publication Redis ne perd pas le message.
- Reconnexion recupere les sequences manquees avant le direct.
- Deux instances backend distribuent le meme ordre canonique.
- Client lent et flood ne font pas croitre la memoire sans borne.
- Redis coupe puis restaure sans perte durable.

### 17.4 E2EE

- PostgreSQL, Redis, logs et traces ne contiennent jamais le plaintext.
- Un non-membre ne peut pas dechiffrer.
- Un membre retire ne peut pas dechiffrer apres la nouvelle epoque.
- Un nouvel arrivant respecte exactement la politique d'historique choisie.
- Modification du ciphertext ou des metadonnees authentifiees detectee.
- Rejeu inter-reunion refuse.
- Rotation et reprise de cles testees apres coupure.
- E2EE media verifiee par capture et inspection du point SFU, qui ne doit pas retrouver le contenu encode clair.
- Navigateurs cibles testes pour Encoded Transform; aucun downgrade silencieux.

### 17.5 Media et parcours reels

- Visioconference a deux onglets avec audio, video et chat.
- Appel audio sans creation de producteur video.
- Live avec presentateur, audience et charge de chat correspondant au profil choisi.
- Reseau degrade, perte de paquets, bascule Wi-Fi/mobile et reconnexion.
- Terminaison par l'hote ferme correctement admissions, medias et chat.
- Redemarrage backend et SFU a des moments distincts.

Les statistiques WebRTC standardisees servent a mesurer RTT, pertes, bitrate et qualite des connexions clientes.[^54] Elles completent, sans les remplacer, les metriques internes du SFU.

## 18. Criteres de sortie du backend

Le backend ne sera considere pret pour staging que lorsque :

- la specification d'architecture et les contrats sont approuves;
- toutes les decisions bloquantes de la section suivante sont tranchees;
- aucun secret permanent n'est livre au navigateur;
- les migrations sont reproductibles sur une base vide et une base de version precedente;
- les tests unitaires, integration, contrats et E2E passent;
- les tests de panne prouvent l'absence de confirmation avant durabilite;
- les tests E2EE prouvent l'absence de plaintext cote serveur;
- la charge cible est atteinte avec marges CPU, memoire, connexions et base;
- sauvegarde et restauration PostgreSQL ont ete executees reellement;
- rotation de cles et revocation ont ete executees reellement;
- dashboards, alertes et runbooks existent;
- un deploiement progressif et un rollback compatible schema/protocole sont valides;
- le frontend utilise les contrats courants du SFU et du backend.

La production exige en plus une observation stable en staging, un test de restauration recent, un plan d'incident, des quotas definitifs et un dimensionnement issu des mesures.

## 19. Decisions necessaires avant la specification finale

| ID | Question | Pourquoi elle bloque |
|---|---|---|
| D-01 | Combien de temps conserver reunions et messages? | Schema de purge, cout PostgreSQL, sauvegardes et UX d'historique |
| D-02 | Un nouvel invite peut-il dechiffrer les messages emis avant son admission? | Modele de cles et garantie de confidentialite retroactive |
| D-03 | Le chat du live est-il E2EE, modere par le serveur, ou decline en deux profils? | E2EE stricte et moderation plaintext sont incompatibles |
| D-04 | Qui peut ecrire dans le chat du live? | Roles, quotas et charge maximale |
| D-05 | L'E2EE media est-elle obligatoire pour visio, audio et live? | Compatibilite navigateur, enregistrement, transcodage et tests |
| D-06 | L'enregistrement est-il requis? | Un enregistreur doit devenir un endpoint E2EE visible ou le mode ne peut pas enregistrer |
| D-07 | Quelles limites de participants, audience et messages/s? | Architecture de diffusion, partitionnement, capacite et cout |
| D-08 | Quelle duree maximale et quelle reprise apres fin de reunion? | Expiration des capacites, cles locales et donnees |
| D-09 | Quelles regions et quels objectifs SLO/RPO/RTO? | Haute disponibilite, replication et deploiement |
| D-10 | Quels navigateurs et appareils sont obligatoires? | Support reel d'Encoded Transform et bibliotheque MLS |

Ces questions ne doivent pas etre resolues par des valeurs arbitraires dans le code.

## 20. Documents locaux SFU pris en compte

Le cadrage a ete confronte aux documents directeurs et aux etapes deja presentes dans `sfu-server`. Ils restent les autorites locales pour l'integration :

| Document local | Element repris dans ce cadrage |
|---|---|
| `docs/02-architecture-cible.md` | Le SFU ne devient pas le backend metier; integration par admission, API interne et evenements versionnes |
| `docs/03-plan-directeur-autopilot.md` | Barriere de production maintenue tant que la gestion backend des cles E2EE manque |
| `docs/08-phase-2-admission-isolation-et-limites.md` | JWT a usage unique, claims stricts, permissions explicites, JWKS/SPKI, Origin, quotas et anti-rejeu |
| `docs/10-phase-4-protocole-signaling.md` | Enveloppe versionnee, reprise bornee, E2EE cote clients, enregistrement incompatible |
| `docs/11-client-reference-e2e-navigateur.md` | Parcours navigateur reel servant de reference d'integration |
| `docs/16-phase-9-redis-cluster-multinoeuds.md` | Placement distribue et revocation partagee sans memoire locale comme verite |
| `docs/17-phase-10-qualification-release.md` | Blocage explicite du `GO` E2EE tant que le service de cles backend n'existe pas |
| `etapes/README.md` et `etapes/references/` | Historique V1, V2, V3 conserve comme contexte, sans remplacer les documents courants |

Le nouveau backend est cree hors du depot SFU. Ce cadrage n'exige aucune modification du code SFU existant.

## 21. Enseignements des projets et standards examines

| Reference | Enseignement retenu | Ce qui n'est pas copie aveuglement |
|---|---|---|
| mediasoup et mediasoup-demo | Le SFU reste une primitive media; l'application definit signalisation, pairs et workflows.[^1][^55] | La demo n'est pas une architecture produit ni un contrat Hello Friend |
| LiveKit Server | Separation des tokens d'acces, droits de room, deploiement distribue et clients directs vers le SFU.[^56] | Le serveur Hello Friend existe deja; il n'est pas remplace par LiveKit |
| Jitsi Videobridge | Le SFU est un composant backend parmi d'autres dans une pile de conference.[^57] | La pile Jitsi complete et son modele XMPP ne sont pas introduits |
| Matrix Synapse et SDK JS | Historique durable, synchronisation incrementale et E2EE client dans un systeme distribue.[^58][^59] | Federation, comptes Matrix et protocole complet sont hors perimetre |
| MLS et OpenMLS | Gestion de cles de groupe par epoques, ajouts, retraits et securite apres compromission.[^9][^25] | Aucune bibliotheque n'est declaree production-ready pour ce produit sans validation |
| Redis | Diffusion rapide et etat ephemere, mais Pub/Sub peut perdre des messages.[^17] | Redis n'est pas transforme en archive de chat |
| PostgreSQL | Transactions et stockage durable avec HA, sauvegarde et observabilite.[^20][^31][^32] | Aucun partitionnement ou niveau d'isolation maximal sans mesure |
| OWASP et IETF | WSS, Origin allowlist, autorisation par message, limites, JWT ferme et anti-rejeu.[^16][^48] | Les valeurs d'exemple ne deviennent pas automatiquement les quotas produit |

## 22. Plan documentaire suivant

1. **Cadrage**, le present document : besoins, frontieres, garanties, risques et decisions ouvertes.
2. **Specification d'architecture** : diagrammes, modules, flux, schemas de donnees, transactions, outbox, topologie Redis/PostgreSQL, integration SFU, strategie E2EE, variables d'environnement et deploiement.
3. **Contrats de protocoles** : OpenAPI, sous-protocole WebSocket, evenements, erreurs, versionnement et claims SFU.
4. **Modele de menace** : actifs, adversaires, frontieres de confiance, abus, E2EE et controles verifiables.
5. **Strategie de tests et capacite** : matrices unitaires/integration/E2E, fault injection, reseau degrade, charge et criteres de sortie.
6. **Runbooks deploiement/exploitation** : migrations, rotation, sauvegarde/restauration, alertes, incident, rollback et reprise.

L'etape 2 ne doit commencer qu'en conservant les decisions ouvertes comme parametres explicites ou apres reponse du produit. Le SFU demeure inchange pendant cette phase documentaire.

## Sources

[^1]: mediasoup, *Communication Between Client and Server*, https://mediasoup.org/documentation/v3/communication-between-client-and-server/
[^2]: Node.js, *Node.js v22 to v24*, https://nodejs.org/en/blog/migrations/v22-to-v24
[^3]: NestJS, *Modules*, https://docs.nestjs.com/modules
[^4]: NestJS, *Validation*, https://docs.nestjs.com/techniques/validation
[^5]: IETF, *RFC 6455: The WebSocket Protocol*, https://www.rfc-editor.org/rfc/rfc6455
[^6]: NestJS, *WebSocket Adapter*, https://docs.nestjs.com/websockets/adapter
[^7]: PostgreSQL Global Development Group, *Versioning Policy*, https://www.postgresql.org/support/versioning/
[^8]: Redis, *Redis Open Source version management*, https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/
[^9]: IETF, *RFC 9420: The Messaging Layer Security Protocol*, https://www.rfc-editor.org/rfc/rfc9420
[^10]: IETF, *RFC 9750: The Messaging Layer Security Architecture*, https://www.rfc-editor.org/rfc/rfc9750
[^11]: W3C, *WebRTC Encoded Transform*, https://www.w3.org/TR/webrtc-encoded-transform/
[^12]: OpenTelemetry, *Node.js Getting Started*, https://opentelemetry.io/docs/languages/js/getting-started/nodejs/
[^13]: Prometheus, *Histograms and summaries*, https://prometheus.io/docs/practices/histograms/
[^14]: mediasoup, *API: DataProducer and DataConsumer*, https://mediasoup.org/documentation/v3/mediasoup/api/#DataProducer
[^15]: NestJS, *WebSocket Gateways*, https://docs.nestjs.com/websockets/gateways
[^16]: OWASP, *WebSocket Security Cheat Sheet*, https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
[^17]: Redis, *Redis Pub/Sub and delivery semantics*, https://redis.io/docs/latest/develop/pubsub/
[^18]: Redis, *XADD command*, https://redis.io/docs/latest/commands/xadd/
[^19]: Redis, *XREADGROUP command*, https://redis.io/docs/latest/commands/xreadgroup/
[^20]: PostgreSQL, *Concurrency Control and MVCC*, https://www.postgresql.org/docs/current/mvcc.html
[^21]: PostgreSQL, *Transaction Isolation*, https://www.postgresql.org/docs/current/transaction-iso.html
[^22]: PostgreSQL, *Explicit Locking*, https://www.postgresql.org/docs/current/explicit-locking.html
[^23]: PostgreSQL, *Indexes*, https://www.postgresql.org/docs/current/indexes.html
[^24]: PostgreSQL, *Table Partitioning*, https://www.postgresql.org/docs/current/ddl-partitioning.html
[^25]: OpenMLS, *Rust implementation of MLS*, https://github.com/openmls/openmls
[^26]: W3C, *WebRTC 1.0: Real-Time Communication Between Browsers*, https://www.w3.org/TR/webrtc/
[^27]: W3C, *Web Cryptography Level 2*, https://www.w3.org/TR/webcrypto-2/
[^28]: OWASP, *Cryptographic Storage Cheat Sheet*, https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
[^29]: NIST, *SP 800-57 Part 1 Rev. 5: Recommendation for Key Management*, https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final
[^30]: NestJS, *Providers*, https://docs.nestjs.com/providers
[^31]: PostgreSQL, *Continuous Archiving and Point-in-Time Recovery*, https://www.postgresql.org/docs/current/continuous-archiving.html
[^32]: PostgreSQL, *Warm Standby and Streaming Replication*, https://www.postgresql.org/docs/current/warm-standby.html
[^33]: PostgreSQL, *The Cumulative Statistics System*, https://www.postgresql.org/docs/current/monitoring-stats.html
[^34]: PostgreSQL, *LISTEN*, https://www.postgresql.org/docs/current/sql-listen.html
[^35]: PostgreSQL, *NOTIFY*, https://www.postgresql.org/docs/current/sql-notify.html
[^36]: Redis, *EXPIRE command*, https://redis.io/docs/latest/commands/expire/
[^37]: Redis, *Key eviction*, https://redis.io/docs/latest/develop/reference/eviction/
[^38]: Redis, *Persistence*, https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/
[^39]: Redis, *Replication*, https://redis.io/docs/latest/operate/oss_and_stack/management/replication/
[^40]: Redis, *Security*, https://redis.io/docs/latest/operate/oss_and_stack/management/security/
[^41]: Redis, *Access Control Lists*, https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
[^42]: Redis, *Distributed Locks with Redis*, https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/
[^43]: NestJS, *OpenAPI Introduction*, https://docs.nestjs.com/openapi/introduction
[^44]: Fastify, *Validation and Serialization*, https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
[^45]: IETF, *RFC 6455: The WebSocket Protocol*, https://www.rfc-editor.org/rfc/rfc6455
[^46]: IETF, *RFC 8441: Bootstrapping WebSockets with HTTP/2*, https://www.rfc-editor.org/rfc/rfc8441
[^47]: IETF, *RFC 9220: Bootstrapping WebSockets with HTTP/3*, https://www.rfc-editor.org/rfc/rfc9220
[^48]: IETF, *RFC 8725: JSON Web Token Best Current Practices*, https://www.rfc-editor.org/rfc/rfc8725
[^49]: IETF, *RFC 7519: JSON Web Token*, https://www.rfc-editor.org/rfc/rfc7519
[^50]: Kubernetes, *Disruptions and Pod Disruption Budgets*, https://kubernetes.io/docs/concepts/workloads/pods/disruptions/
[^51]: Kubernetes, *Pod Topology Spread Constraints*, https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/
[^52]: NestJS, *Healthchecks with Terminus*, https://docs.nestjs.com/recipes/terminus
[^53]: mediasoup, *Scalability*, https://mediasoup.org/documentation/v3/scalability/
[^54]: W3C, *Identifiers for WebRTC's Statistics API*, https://www.w3.org/TR/webrtc-stats/
[^55]: versatica, *mediasoup-demo*, https://github.com/versatica/mediasoup-demo
[^56]: LiveKit, *LiveKit Server*, https://github.com/livekit/livekit
[^57]: Jitsi, *Jitsi Videobridge*, https://github.com/jitsi/jitsi-videobridge
[^58]: Matrix.org, *Synapse homeserver*, https://github.com/matrix-org/synapse
[^59]: Matrix.org, *Matrix JavaScript SDK*, https://github.com/matrix-org/matrix-js-sdk
[^60]: WHATWG, *WebSockets Standard*, https://websockets.spec.whatwg.org/
[^61]: IETF, *RFC 9180: Hybrid Public Key Encryption*, https://www.rfc-editor.org/rfc/rfc9180
[^62]: OWASP, *Key Management Cheat Sheet*, https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html
[^63]: Node.js, *End-of-Life releases*, https://nodejs.org/en/about/eol
[^64]: NestJS, *Performance with Fastify*, https://docs.nestjs.com/techniques/performance
[^65]: NestJS, *Rate Limiting*, https://docs.nestjs.com/security/rate-limiting
[^66]: Redis, *Pipelining*, https://redis.io/docs/latest/develop/using-commands/pipelining/

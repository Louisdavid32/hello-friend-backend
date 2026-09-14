# Specification fonctionnelle modulaire

Statut : baseline fonctionnelle v1 ; etape 3 implementee et qualifiee sur PostgreSQL 18/Redis 8
autonome. La qualification Redis Cluster et preproduction reste une gate de deploiement. Date de
revue : 2026-09-14. Portee : backend applicatif Hello Friend, sans modifier le frontend ni le SFU.

## 1. Objet et regles de lecture

Cette specification decrit ce que le produit doit faire du point de vue des participants, de l'hote
et de l'exploitation. Elle complete, sans les remplacer :

- `01-cadrage-backend-temps-reel.md`, qui fixe le probleme et les limites ;
- `02-specification-architecture-backend.md`, qui fixe l'architecture technique ;
- `03-modele-menaces-securite.md`, qui fixe les risques et controles ;
- les `README.md` locaux, qui constituent le contrat fonctionnel de chaque module ;
- OpenAPI, les schemas realtime et TypeDoc, qui sont les contrats executables.

Chaque exigence porte un identifiant stable. Les statuts ont un sens strict :

| Statut        | Signification                                                                          |
| ------------- | -------------------------------------------------------------------------------------- |
| `IMPLEMENTE`  | code et tests automatises existent ; une preuve d'infrastructure peut rester explicite |
| `ETAPE_3`     | inclus dans le lot WSS actuellement construit                                          |
| `PLANIFIE`    | specifie mais pas encore disponible dans le produit                                    |
| `BLOQUE_GATE` | interdit tant qu'une preuve de securite ou d'integration manque                        |

Une fonctionnalite n'est jamais declaree disponible uniquement parce que sa table, son DTO ou son
ecran existe.

## 2. Promesse produit

Hello Friend permet de creer sans compte global une conversation limitee a une reunion, puis d'y
participer en visioconference, en appel audio ou en live. Le backend connait des identites
pseudonymes propres a la reunion ; il ne construit pas de profil global et ne demande ni email ni
mot de passe.

Le produit vise les navigateurs mobiles et desktop, y compris les situations ou la connexion alterne
entre Wi-Fi, 4G/3G, partage de connexion et coupures. Cette priorite ne suppose pas qu'un continent
entier possede un reseau uniforme : les decisions sont mesurees par connexion et restent
controlables par la personne.

### 2.1 Principes fonctionnels non negociables

| ID     | Exigence                                                                                 | Statut                                                   |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| GF-001 | aucun compte global requis pour creer ou rejoindre                                       | `IMPLEMENTE`                                             |
| GF-002 | toute identite et tout droit sont bornes a une reunion                                   | `IMPLEMENTE`                                             |
| GF-003 | le frontend ne choisit jamais directement un role privilegie                             | `IMPLEMENTE`                                             |
| GF-004 | un secret d'invitation n'est ni un ID public ni une permission hote                      | `IMPLEMENTE`                                             |
| GF-005 | le backend et le SFU ont des WSS distincts et des responsabilites distinctes             | `IMPLEMENTE` pour la frontiere ; admission SFU planifiee |
| GF-006 | aucun participant distant ne peut activer un micro ou une camera sans consentement local | `PLANIFIE`                                               |
| GF-007 | un evenement durable n'est pas remplace par une notification Redis volatile              | `IMPLEMENTE`                                             |
| GF-008 | une panne est annoncee comme inconnue ou degradee, jamais comme un faux succes           | `IMPLEMENTE`                                             |
| GF-009 | les secrets, contenus clairs et identifiants bruts n'entrent pas dans les metriques      | `IMPLEMENTE`                                             |
| GF-010 | chaque fonctionnalite possede contrat, tests, metriques et comportement de rollback      | `ETAPE_3`                                                |

## 3. Acteurs et droits

### 3.1 Acteurs humains

| Acteur      | Definition                                  | Droits fonctionnels cibles                                           |
| ----------- | ------------------------------------------- | -------------------------------------------------------------------- |
| hote        | createur ayant echange la capacite hote     | politiques, moderation, fin, invitation, publication selon mode      |
| participant | invite d'une visio ou d'un appel            | publier selon mode, consommer, chat selon politique                  |
| presenter   | personne promue dans un live                | publier audio/video/ecran, consommer, chat selon politique           |
| viewer      | spectateur d'un live                        | consommer, reactions/chat selon politique, jamais publier par defaut |
| operateur   | identite de plateforme hors produit anonyme | exploitation auditee, aucun contenu E2EE clair                       |

Le terme « professeur » designe fonctionnellement l'hote d'une reunion de cours. Il n'introduit pas
un compte enseignant global. Une future delegation de moderation utilisera une permission bornee,
explicite et revocable, jamais une elevation implicite parce qu'une personne est arrivee en premier.

### 3.2 Matrice de base

| Action                             | Hote                           | Participant     | Presenter      | Viewer         |
| ---------------------------------- | ------------------------------ | --------------- | -------------- | -------------- |
| rejoindre/quitter                  | oui                            | oui             | oui            | oui            |
| publier micro                      | selon mode                     | visio/audio     | live           | non            |
| publier camera                     | visio/live                     | visio           | live           | non            |
| partager ecran                     | selon politique                | selon politique | oui            | non            |
| lire/ecrire chat                   | politique                      | politique       | politique      | politique live |
| couper une publication distante    | oui                            | non             | non par defaut | non            |
| reactiver une publication distante | jamais sans consentement local | non             | non            | non            |
| retirer un participant             | oui                            | non             | non par defaut | non            |
| promouvoir un presenter live       | oui                            | non             | non            | non            |
| terminer la reunion                | oui                            | non             | non            | non            |

## 4. Cycle de vie global

Une reunion suit `OPEN -> ACTIVE -> ENDING -> ENDED` ou `OPEN -> EXPIRED`.

| ID     | Regle                                                                                   |
| ------ | --------------------------------------------------------------------------------------- |
| GF-020 | `OPEN` accepte les echanges de capacite tant que la politique et le TTL le permettent   |
| GF-021 | la premiere activite durable ou admission media fait passer a `ACTIVE`                  |
| GF-022 | `ENDING` refuse tout nouvel entrant et toute nouvelle publication                       |
| GF-023 | `ENDING` laisse les workers terminer revocation, audit et outbox pendant un delai borne |
| GF-024 | `ENDED` et `EXPIRED` sont terminaux                                                     |
| GF-025 | un evenement ancien du SFU ne peut pas rouvrir une reunion terminee                     |
| GF-026 | un participant suit `PENDING_KEY_SYNC -> ACTIVE -> LEFT` ou `REVOKED`                   |
| GF-027 | une session suit `ACTIVE -> ROTATING -> REVOKED` ou `EXPIRED`                           |

## 5. Parcours de creation et de jointure

### 5.1 Creation par l'hote

1. Le client choisit `video_conference`, `audio_call` ou `live`.
2. Il demande un nom d'affichage et les preferences initiales micro/camera.
3. Il genere localement un ID de commande, une capacite hote, une capacite invite et un binding
   appareil, tous avec un CSPRNG.
4. `POST /v1/meetings` valide l'origine, les limites et les donnees.
5. Une transaction cree reunion, hote, capacites, session, audit et outbox.
6. Le token de session arrive uniquement dans un cookie HttpOnly ; le client conserve en memoire le
   CSRF et les capacites qu'il a lui-meme generees.
7. Le lien partage contient la capacite invite dans le fragment URL, jamais dans une query envoyee
   au serveur.

Une perte de reponse autorise le rejeu de la meme commande. La commande ne cree pas une seconde
reunion. Un meme ID avec des donnees differentes est refuse.

### 5.2 Jointure personnelle d'un invite

1. Le navigateur ouvre `/room/{meetingId}#invite={secret}`.
2. Le frontend extrait le fragment, le retire de l'URL visible et ne l'envoie ni aux analytics ni
   aux logs.
3. La personne choisit son nom, son micro et sa camera avant de rejoindre.
4. Le client genere un binding appareil et un ID de commande.
5. Le backend echange la capacite invite contre un participant et une session.
6. En live, le role initial est `viewer`; en visio/audio, `participant`.
7. Le WSS backend est obtenu avec un ticket court ; l'admission SFU est un jeton distinct emis plus
   tard selon les droits reels.

Une erreur invitation inconnue, expiree, revoquee ou epuisee utilise la meme reponse publique afin
de limiter l'enumeration. Le nom n'est jamais une identite.

### 5.3 Reprise apres coupure

| ID     | Exigence                                                                                         | Statut                     |
| ------ | ------------------------------------------------------------------------------------------------ | -------------------------- |
| GF-040 | le cookie et le binding appareil reprennent le meme participant tant que la session reste valide | `PLANIFIE`                 |
| GF-041 | un nouveau ticket remplace la tentative WSS perdue sans reutiliser le ticket consomme            | `IMPLEMENTE` backend       |
| GF-042 | le client applique un backoff exponentiel tronque avec full jitter                               | `ETAPE_3` contrat frontend |
| GF-043 | la presence peut devenir `unknown` pendant la coupure, jamais faussement `offline`               | `IMPLEMENTE` backend       |
| GF-044 | le prochain abonnement fournit un snapshot canonique                                             | `IMPLEMENTE` backend       |
| GF-045 | le futur chat reprend apres le dernier curseur durable sans trou                                 | `PLANIFIE`                 |
| GF-046 | micro et camera restent dans leur dernier choix local et ne se rallument jamais automatiquement  | `PLANIFIE` frontend/SFU    |

## 6. Modes de reunion

### 6.1 Visioconference

La visio est un espace plusieurs-vers-plusieurs. Hote et participants peuvent publier audio/video
sous reserve de permission. L'affichage grille, intervenant actif et partage d'ecran sont des choix
frontend/SFU, pas du backend realtime.

Exigences cibles :

- liste des participants coherente malgre plusieurs onglets par personne ;
- camera, micro et partage d'ecran controles independamment ;
- publication initiale desactivee jusqu'au consentement navigateur ;
- chat E2EE durable et historique selon appartenance ;
- adaptation de couche simulcast/SVC sans modifier les droits ;
- moderation auditee et visible a la personne affectee ;
- reprise apres changement reseau sans creer une nouvelle identite si possible.

### 6.2 Appel audio

Le mode audio ne doit jamais accorder `media:produce:video`. L'interface peut afficher un avatar et
le niveau de parole sans allouer de transport video.

Exigences cibles :

- micro local desactive par defaut sauf choix explicite ;
- pas de camera demandee par le navigateur ;
- priorite a la continuite audio lorsque la bande passante baisse ;
- chat facultatif selon politique de reunion ;
- changement de micro et restart ICE sans quitter la reunion ;
- consommation de donnees et de batterie mesuree lors de la qualification.

### 6.3 Live

Le live est un modele quelques-vers-plusieurs. L'hote et les presenters publient, les viewers
consomment. Un viewer ne recoit jamais une admission de production, meme si son frontend envoie une
commande de publication.

Fonctions cibles :

- promotion/demotion idempotente d'un presenter par l'hote ;
- limite explicite de presenters simultanes ;
- mode questions/reactions/chat configurable ;
- slow mode et quota par viewer pour limiter les rafales ;
- possibilite de fermer l'ecriture du chat sans couper le flux media ;
- arrivees en rafale absorbees par quotas et admission progressive ;
- snapshot compact avant chargement progressif de la liste complete ;
- diffusion multi-routeurs SFU selon charge, sans exposer la topologie interne ;
- en E2EE, pas d'enregistrement serveur pretendument transparent.

## 7. Moderation et salle de cours

### 7.1 Couper micro ou camera

L'hote/professeur peut demander la coupure d'une publication audio, video ou partage d'ecran.
L'action doit produire deux effets coordonnes :

1. reduire la permission backend/SFU pour empecher une republication immediate ;
2. demander au SFU de fermer ou mettre en pause le producer concerne.

Le client affecte recoit un evenement avec un code de raison public. L'action est auditee avec
commandId, acteur, cible et resultat, sans SDP ni contenu.

**Interdit :** activer a distance un micro ou une camera. Une action « autoriser a parler » restaure
seulement le droit de publier ; la personne clique ensuite elle-meme pour activer son appareil.
Cette distinction protege la vie privee et evite le faux sentiment qu'un simple bouton mute
constitue une politique.

### 7.2 Autres controles cibles

| Action                  | Effet                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| mute all                | retire temporairement le droit audio a tous sauf une allowlist       |
| verrouiller audio/video | refuse les nouvelles publications du type jusqu'a reouverture        |
| retirer                 | revoque sessions, tickets, WSS et admission SFU de la cible          |
| verrouiller la salle    | refuse toute nouvelle jointure sans retirer les personnes presentes  |
| salle d'attente         | cree une demande d'admission sans droit media/chat avant acceptation |
| promouvoir presenter    | change le profil live et emet une nouvelle admission SFU             |
| ralentir le chat        | impose un intervalle serveur non contournable par reconnexion        |
| terminer                | passe a `ENDING`, refuse les nouveaux travaux puis propage la fin    |

Ces commandes appartiennent aux futures etapes meetings/SFU. Elles sont decrites ici pour que
l'etape realtime ne cree pas un protocole impossible a etendre.

## 8. Session, ticket WSS et protocole realtime

### 8.1 Session HTTP

La session est un token opaque de 256 bits en cookie. PostgreSQL ne conserve que son HMAC versionne.
Toute authentification verifie session, participant, reunion, expirations, revocation, binding
appareil et origine.

Le jeton CSRF accompagne chaque mutation HTTP. Le binding appareil est un secret aleatoire local,
pas une empreinte materielle ou publicitaire.

### 8.2 Ticket WSS

| ID     | Exigence                                                                         | Statut                                    |
| ------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| RT-001 | `POST /v1/realtime-tickets` exige session, CSRF, binding et origine valides      | `IMPLEMENTE`                              |
| RT-002 | le ticket contient 256 bits aleatoires et expire en quelques secondes            | `IMPLEMENTE`                              |
| RT-003 | Redis ne conserve que le digest et un payload minimal borne                      | `IMPLEMENTE`                              |
| RT-004 | la consommation est atomique et exactement une tentative gagne                   | `IMPLEMENTE`, prouve sur Redis 8 autonome |
| RT-005 | le ticket est lie a session, reunion, participant, origine et appareil           | `IMPLEMENTE`                              |
| RT-006 | le ticket est envoye dans le premier frame, jamais URL, cookie ou sous-protocole | `IMPLEMENTE` protocole                    |
| RT-007 | une panne Redis refuse toute nouvelle authentification WSS                       | `IMPLEMENTE`                              |
| RT-008 | un audit durable distingue emis, consomme, expire et refuse                      | `IMPLEMENTE` avec reconciliation worker   |

### 8.3 Handshake et authentification

- URL fixe `/v1/realtime`, sans query ni fragment ;
- sous-protocole exact `hf-realtime.v1` ;
- `Origin` compare par egalite a l'allowlist ;
- compression par message desactivee ;
- payload et fragmentation bornes au niveau `ws` ;
- premier frame `session.authenticate` avant le timeout ;
- tout autre frame avant authentification provoque une erreur puis fermeture ;
- chaque commande applique le principal courant ; PostgreSQL le revalide au plus toutes les
  `REALTIME_SESSION_REVALIDATE_SECONDS` secondes et toute future revocation publiee court-circuitera
  cette fenetre.

### 8.4 Enveloppe v1

```json
{
  "v": 1,
  "id": "018f5f87-5c7a-7abc-8def-0123456789ad",
  "type": "session.authenticate",
  "payload": {
    "ticket": "<base64url-32-octets>",
    "deviceBinding": "<base64url-32-octets>"
  }
}
```

Les objets inconnus, versions inconnues, tableaux ou nombres hors limites, frames binaires et UTF-8
invalide sont refuses. Une erreur contient un code, `replyTo` lorsque disponible et un message
public ; jamais le frame recu.

### 8.5 Limites et backpressure

- compteurs separes avant et apres authentification ;
- limites par socket, session et source reseau ;
- une seule commande traitee a la fois par socket dans v1 ;
- file entrante et file sortante bornees ;
- `bufferedAmount` mesure avant tout envoi ;
- presence et QoS sont coalescables ; l'etape 3 abandonne seulement une notification de revision
  reparable par snapshot ;
- un resultat fiable impossible a ecrire provoque une fermeture `1013` ;
- tous timers/listeners sont liberes a la fermeture.

## 9. Presence

La presence represente une observation ephemere, pas une preuve d'autorisation. Une personne peut
posseder plusieurs connexions. Le statut participant est agrege : `online` si au moins une connexion
fraiche, `away` sur signal client borne, `unknown` lorsque Redis est indisponible, et `offline`
seulement apres expiration ou fermeture observee.

| ID     | Exigence                                                                               | Statut                                 |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------- |
| PR-001 | open/heartbeat/close sont atomiques dans un hash slot Redis par reunion                | `IMPLEMENTE`                           |
| PR-002 | l'heure serveur Redis et un TTL bornent les connexions fantomes                        | `IMPLEMENTE`                           |
| PR-003 | aucune IP, ticket, cookie ou nom brut n'est stocke dans Redis presence                 | `IMPLEMENTE`                           |
| PR-004 | snapshot agrege dedoublonne plusieurs onglets du meme participant                      | `IMPLEMENTE`                           |
| PR-005 | chaque evenement porte une revision monotone de presence par reunion                   | `IMPLEMENTE`                           |
| PR-006 | Pub/Sub sert de notification ; un snapshot repare toute perte                          | `IMPLEMENTE`                           |
| PR-007 | une panne Redis rend la presence inconnue sans fermer les sockets deja authentifies    | `IMPLEMENTE`                           |
| PR-008 | revocation retrouve les connexions d'une session ; la commande de revocation les ferme | index `IMPLEMENTE`, commande planifiee |

## 10. Resilience adaptee aux usages mobiles en Afrique

Les rapports ITU/GSMA montrent des contraintes persistantes de cout, de qualite, de couverture et
d'energie. Elles motivent les innovations suivantes sans reduire la securite :

1. **Join leger** : le WSS de controle s'etablit avant tout media ; camera et micro restent opt-in,
   ce qui evite une consommation inutile avant admission.
2. **Audio-first explicite** : lorsque le client mesure une degradation, il peut proposer video
   basse ou audio seul ; le serveur ne deduit pas le pays depuis l'IP et ne force pas une qualite
   inferieure.
3. **Snapshots compacts** : le premier snapshot contient l'essentiel et un curseur ; listes et
   historique se chargent par pages bornees.
4. **Reconnexion anti-tempete** : full jitter, ticket neuf et reprise par curseur ; aucune boucle
   immediate lors du retour d'une antenne ou du courant.
5. **Economie de donnees** : pas de WebSocket compression par defaut pour eviter risques/memoire ;
   en revanche, evenements coalescables, JSON compact et aucune repetition de grands objets.
6. **Presence honnete** : une coupure infra affiche `unknown` plutot qu'une foule faussement
   deconnectee.
7. **Changement reseau** : session et identite survivent au changement d'IP ; l'IP limite l'abus
   mais n'est pas une identite durable.
8. **Budget batterie** : heartbeat serveur suffisamment lent, timers regroupes, pas de polling
   rapide en arriere-plan et mesures mobile obligatoires.
9. **Mode live massif** : viewers sans droit de publication, snapshots compactes et liste de
   presence paginee evitent O(N) par evenement.
10. **Accessibilite hors audio** : etats textuels, sous-titrage futur et chat E2EE permettent de
    suivre lorsque l'audio est temporairement inutilisable.

Les heuristiques `saveData`, RTT ou type de reseau du navigateur ne deviennent jamais une
autorisation et restent facultatives car leur disponibilite varie.

## 11. Degradation et messages fonctionnels

| Panne                       | Comportement attendu                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| PostgreSQL indisponible     | aucune session/ticket nouveau ; pas de faux ack                           |
| Redis tickets indisponible  | emission et nouvelle authentification WSS refusees                        |
| Redis presence indisponible | sockets actives continuent, statut `unknown`, readiness degradee          |
| Pub/Sub perdu               | snapshot/catch-up repare ; aucune garantie durable fondee sur Pub/Sub     |
| client lent                 | coalescence, avertissement, fermeture bornee, puis reprise                |
| coupure mobile              | reconnexion avec jitter et nouveau ticket                                 |
| session revoquee            | ticket refuse, sockets fermees, admission SFU revoquee plus tard          |
| processus en drain          | aucun nouvel upgrade/ticket, sockets averties puis fermees avant deadline |

## 12. Catalogue des modules et statut

| Module             | Responsabilite                                | Statut apres implementation de l'etape 3                        |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------- |
| `capabilities`     | HMAC et rotation des secrets                  | implemente                                                      |
| `meetings`         | create/join et politiques de reunion          | create/join implementes, cycle complet planifie                 |
| `sessions`         | authentification et rotation de session       | authentification/revalidation implementees ; rotation planifiee |
| `realtime-tickets` | emission/consommation WSS one-shot            | implemente, concurrence prouvee sur Redis 8 autonome            |
| `realtime`         | handshake, protocole, limites, registre local | implemente pour commandes etape 3                               |
| `presence`         | etat ephemere Redis multi-instance            | implemente sur Redis 8 ; qualification Cluster encore requise   |
| `outbox`           | livraison durable apres commit                | moteur implemente, destinations futures                         |
| `chat`             | ciphertext durable et rattrapage              | etape 4                                                         |
| `sfu-admission`    | JWT/JWKS et profils                           | etape 5                                                         |
| `sfu-control`      | terminer/revoquer via contrat SFU             | etape 6 et gate G-01                                            |
| `e2ee`             | credentials, MLS et SFrame                    | etape 7 et gates G-02/G-03                                      |

## 13. Definition de fini par module

Un module n'est fini que si :

- sa specification locale est a jour ;
- ses API/frames/evenements sont schemas et versionnes ;
- les invariants et refus sont testes ;
- la concurrence et l'idempotence sont prouvees lorsque pertinentes ;
- les pannes de dependance ont un comportement explicite ;
- les logs et metriques n'exposent aucun secret ni label non borne ;
- le lifecycle ferme timers, listeners, sockets et connexions ;
- les tests reels necessaires sont executes sur les versions ciblees ;
- le statut `IMPLEMENTE` est coherent entre ce document, README et code.

## 14. Scenarios d'acceptation produit

### 14.1 Visioconference de cours

L'hote cree et partage ; deux invites rejoignent ; chacun choisit ses appareils. L'hote coupe le
micro d'un participant perturbateur. Le droit audio est bloque, le producer SFU est ferme, la
personne est avertie et ne peut pas republier. Une restauration du droit n'allume pas le micro.
Apres consentement local, elle peut parler. Une coupure reseau reprend la meme identite et l'etat
canonique.

### 14.2 Appel audio

Deux participants rejoignent sans permission camera. Audio et chat optionnel fonctionnent. La perte
de bande passante ne provoque aucun chargement video. Le changement d'IP mobile renouvelle ticket et
WSS sans creer de compte.

### 14.3 Live

L'hote publie, promeut un presenter et accueille une rafale de viewers. Aucun viewer ne peut creer
de producer. Le slow mode limite le chat. Un viewer lent est degrade ou reconnecte sans ralentir le
diffuseur ni les autres viewers.

### 14.4 Securite realtime

Un ticket rejoue simultanement sur deux sockets authentifie exactement un seul. Une origine
inconnue, query contenant un token, frame binaire, payload trop gros, commande inconnue ou flood est
refuse sans secret dans les logs.

## 15. References officielles et implementations comparees

Les references orientent les invariants ; aucune architecture externe n'est copiee telle quelle.

1. IETF, [RFC 6455 - WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455).
2. OWASP,
   [WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).
3. OWASP,
   [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
4. OWASP,
   [CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
5. OWASP,
   [Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
6. NestJS, [WebSocket gateways](https://docs.nestjs.com/websockets/gateways).
7. NestJS, [WebSocket adapter](https://docs.nestjs.com/websockets/adapter).
8. NestJS, [Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events).
9. `ws`, [README and heartbeat guidance](https://github.com/websockets/ws/blob/master/README.md).
10. `ws`, [Server options](https://github.com/websockets/ws/blob/master/doc/ws.md).
11. Redis, [Pub/Sub](https://redis.io/docs/latest/develop/pubsub/).
12. Redis,
    [Scripting with Lua](https://redis.io/docs/latest/develop/interact/programmability/eval-intro/).
13. Redis, [Transactions](https://redis.io/docs/latest/develop/using-commands/transactions/).
14. Redis,
    [Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/).
15. Redis, [Pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/).
16. Redis, [Security](https://redis.io/docs/latest/operate/oss_and_stack/management/security/).
17. node-redis, [Guide](https://redis.io/docs/latest/develop/clients/nodejs/).
18. PostgreSQL,
    [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
19. PostgreSQL, [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
20. node-postgres, [Transactions](https://node-postgres.com/features/transactions).
21. Fastify,
    [Validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).
22. W3C, [WebRTC](https://www.w3.org/TR/webrtc/).
23. W3C, [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/).
24. W3C, [WebSocket API](https://websockets.spec.whatwg.org/).
25. MDN,
    [`bufferedAmount`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount).
26. mediasoup,
    [Client/server communication](https://mediasoup.org/documentation/v3/communication-between-client-and-server/).
27. mediasoup, [Scalability](https://mediasoup.org/documentation/v3/scalability/).
28. LiveKit, [Participant management](https://docs.livekit.io/home/server/managing-participants/).
29. LiveKit protocol,
    [Realtime protobuf](https://github.com/livekit/protocol/blob/main/protobufs/livekit_rtc.proto).
30. Jitsi, [FAQ moderator mute semantics](https://jitsi.github.io/handbook/docs/faq/).
31. Jitsi,
    [Configuration](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-configuration/).
32. YouTube, [Live chat moderation](https://support.google.com/youtube/answer/9826490).
33. ITU,
    [State of digital development in Africa 2025](https://www.itu.int/itu-d/reports/statistics/wp-content/uploads/sites/5/2025/04/2500037E_SDDT_2025_Africa_FINAL.pdf).
34. ITU,
    [Global Connectivity Report 2025](https://www.itu.int/itu-d/reports/statistics/global-connectivity-report-2025/).
35. GSMA, [State of Mobile Internet Connectivity 2025](https://www.gsma.com/r/somic/).
36. World Bank,
    [Digital transformation in Africa](https://www.worldbank.org/en/results/2023/06/26/from-connectivity-to-services-digital-transformation-in-africa).
37. IETF, [RFC 7519 - JWT](https://www.rfc-editor.org/rfc/rfc7519).
38. IETF, [RFC 8725 - JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725).
39. IETF, [RFC 9457 - Problem Details](https://www.rfc-editor.org/rfc/rfc9457).
40. OpenTelemetry, [Semantic conventions](https://opentelemetry.io/docs/specs/semconv/).

References locales obligatoires :

- `sfu-server/docs/10-phase-4-protocole-signaling.md` ;
- `sfu-server/docs/13-phase-6-souscriptions-simulcast-qos.md` ;
- `sfu-server/docs/17-phase-10-qualification-release.md` ;
- `sfu-server/tests/e2e/reference-client`.

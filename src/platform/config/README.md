# Plateforme `config`

Mission : convertir l'environnement non fiable en configuration immutable, strictement validee et
specifique au role.

Invariants :

- aucun acces libre a `process.env` hors bootstrap/config ;
- staging/production imposent HTTPS/WSS, region non locale et dependances ;
- secrets directs refuses, fichiers confines sous `SECRET_MOUNT_ROOT` ;
- fichier secret regulier, non symlink, taille bornee et permissions restrictives ;
- URLs parsees structurellement, jamais par concatenation ;
- valeurs numeriques bornees et defaults documentes ;
- configuration gelee recursivement avant injection.

Toute nouvelle variable est ajoutee dans le type, le schema, `.env.example`, la documentation du
module proprietaire, les tests positifs/negatifs et la redaction des logs lorsqu'elle peut contenir
un secret.

Les variables `REALTIME_*` bornent ticket, timeout d'authentification, heartbeat, TTL de presence,
taille de message, backpressure, file de commandes, debit et connexions. Les validations croisees
imposent un burst au moins egal au debit soutenu et un TTL de presence couvrant deux heartbeats.
L'URL publique doit cibler exactement `/v1/realtime`, sans query ni fragment.

Les variables `CHAT_*` bornent ciphertext, pages, quota, lease de voie rapide, polling des
watermarks, buffer de remise en ordre et retention. Leur validation croisee garantit que l'enveloppe
base64url tient dans `REALTIME_MAX_MESSAGE_BYTES` et que le lease depasse le timeout Redis avec
marge. Le worker chat exige PostgreSQL/Redis mais ne charge pas les keyrings reserves aux processus
HTTP/realtime.

Pannes : une configuration incoherente arrete le processus avant ouverture du port. Aucun fallback
production n'est invente.

References : [Node environment variables](https://nodejs.org/api/environment_variables.html),
[OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).

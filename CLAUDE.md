# Bulle

Widget flottant pour Windows 11. Une bulle ancrée au bord de l'écran s'anime à
chaque message WhatsApp entrant. Un clic l'entrouvre : nom, message, champ de
réponse. On répond, ça se referme. WhatsApp ne s'ouvre jamais.

Modèle mental : les *chat heads* d'Android, sur le bureau Windows.

## Ce que le projet n'est pas

Pas un client de messagerie. Pas d'historique, pas de liste de conversations,
pas de médias, pas de recherche, pas de stockage de messages. La bulle est une
**surface d'interaction**, pas une boîte de réception.

Deux opérations, c'est tout :
- entrée : « nouveau message de X dans le fil Y »
- sortie : « envoie ce texte dans le fil Y »

Cette contrainte est délibérée et structurante. Toute proposition qui ajoute
de l'état (base de données, cache de conversations, synchro d'historique) sort
du périmètre — la refuser plutôt que l'implémenter.

## Périmètre actuel

**WhatsApp uniquement.** Instagram et Snapchat viendront peut-être plus tard,
derrière la même interface de connecteur. Ne rien câbler pour eux maintenant.

## Décisions déjà prises, avec leurs raisons

Ne pas les rouvrir sans raison nouvelle.

**Baileys plutôt que l'automatisation du navigateur.** Baileys parle le
protocole multi-appareil en WebSocket direct. Pas de Chrome caché, pas de CDP,
pas de sélecteurs DOM qui cassent à chaque refonte de WhatsApp Web, pas de
throttling d'onglet en arrière-plan, ~60 Mo au lieu de ~600.

**Le téléphone est hors du montage.** L'utilisateur a un iPhone. iOS n'a aucun
équivalent au `NotificationListenerService` d'Android ; le seul canal est ANCS
en Bluetooth LE, qui ne transporte que des actions positive/négative — aucun
moyen de renvoyer du texte libre. C'est une limite du protocole. Phone Link de
Microsoft bute exactement dessus : il ne sait répondre que dans l'app Messages,
pas dans WhatsApp. Baileys contourne le problème en se liant directement au
compte, indépendamment de l'OS du téléphone.

**Le `remoteJid` est une clé opaque.** WhatsApp a migré vers un adressage LID
(`@lid`) en parallèle des JID classiques (`@s.whatsapp.net`), et la résolution
d'un LID vers un numéro n'est pas fiable. On répond toujours sur le JID reçu,
tel quel. **Ne jamais construire l'identité d'un fil à partir d'un numéro de
téléphone.**

**Le panneau ne s'ouvre pas tout seul.** La bulle signale (rebond, anneau,
compteur), l'utilisateur décide. S'ouvrir automatiquement à chaque message
devient invivable en une heure sur un groupe actif, et vole le focus pendant
qu'on travaille.

**Aucun accusé de lecture.** Ouvrir la bulle ne doit pas marquer la
conversation comme lue sur le téléphone, sinon on perd les messages qu'on
comptait traiter plus tard.

**`markOnlineOnConnect: false`.** Sinon WhatsApp cesse d'envoyer les push sur
le téléphone, qui reste l'appareil principal de l'utilisateur.

## Les pièges Baileys

Chacun coûte une soirée si on tombe dedans.

1. **Le déluge d'historique.** `messages.upsert` reçoit toute la synchro
   initiale. Filtrer sur `type !== 'notify'` — `'append'`, c'est l'historique.
   Sans ce filtre, la bulle reçoit des centaines de vieux messages au démarrage.
2. **`key.fromMe`.** Les messages envoyés depuis le téléphone remontent aussi.
3. **`status@broadcast`** et `@newsletter` : à écarter.
4. **La déconnexion 515 après le scan du QR** est normale et attendue.
   Reconnecter sur tout sauf `DisconnectReason.loggedOut` — sinon on boucle à
   l'infini sur un compte délié.
5. **Les messages sans texte** (média nu, réaction, appel, accusé) n'ont pas
   leur place dans une bulle de réponse rapide. Les ignorer.

## Sécurité

Le dossier `%APPDATA%/Bulle/auth` contient une **session active sur le
WhatsApp personnel de l'utilisateur**. Il n'est jamais dans le dépôt.
Volontairement hors de `connector/` : un sidecar tourne depuis un dossier
d'installation potentiellement en lecture seule (Program Files),
`%APPDATA%` est garanti inscriptible. Une session trouvée à l'ancien
emplacement (`connector/auth`) est migrée automatiquement au démarrage.

Chiffré au repos via DPAPI (`connector/authCrypt.js`) : à l'arrêt propre du
connecteur (SIGINT/SIGTERM), `auth/` est archivé, chiffré avec
`ProtectedData.Protect` (portée `CurrentUser`, via PowerShell — pas de
dépendance npm native), et le dossier en clair est effacé. Déchiffré
automatiquement au démarrage suivant. **Limite assumée : ça ne protège
qu'entre deux lancements.** Un arrêt brutal (crash, `taskkill /F`, coupure de
courant) laisse `auth/` en clair — les handlers `exit` de Node ne se déclenchent
jamais sur une terminaison forcée, sur aucun OS. `useMultiFileAuthState` n'a
volontairement pas été touché (le remplacer pour chiffrer à la volée aurait été
plus risqué pour une session bien réelle).

L'écosystème npm autour de Baileys est infesté de forks malveillants — certains
proposent d'aliaser `@whiskeysockets/baileys` vers leur propre paquet dans le
`package.json`. **N'installer que `baileys` ou `@whiskeysockets/baileys`.**
Verrouiller les versions, lire le diff avant chaque montée.

Le WebSocket écoute sur `127.0.0.1` uniquement. Ne jamais l'exposer sur `0.0.0.0`.

## État du code

```
overlay/       Interface. Tourne seule dans un navigateur (mode aperçu avec
               faux messages, connecteur non joignable — c'est attendu) ou
               sous Tauri, où elle découvre le connecteur via une commande
               Rust plutôt qu'un port fixe (voir plus bas).
connector/     Session Baileys + serveur WebSocket local.
src-tauri/     Fenêtre Tauri : bande transparente ancrée au bord droit,
               click-through natif, découverte du connecteur.
```

Le protocole entre les deux, volontairement minuscule :

| Sens | Message |
|---|---|
| connecteur → overlay | `{type:'message', jid, from, text, avatar, at, group}` |
| connecteur → overlay | `{type:'sent', ok, error?}` · `{type:'qr'}` · `{type:'status', state}` |
| overlay → connecteur | `{type:'auth', token}` (obligatoire en premier message) |
| overlay → connecteur | `{type:'reply', jid, text}` · `{type:'typing', jid}` |

Garder ce contrat stable : c'est lui qui permettra de brancher Instagram plus
tard sans toucher à l'overlay.

Le connecteur n'écoute plus sur un port fixe : il choisit un port libre et un
jeton à chaque lancement, et les dépose dans
`<tmp système>/bulle-connector.json`. L'overlay les lit via la commande Tauri
`read_connector_info` (voir `src-tauri/src/lib.rs`) et s'authentifie avec
`{type:'auth', token}` avant tout autre message — sinon le connecteur ferme la
connexion. Conséquence : l'aperçu navigateur nu (`overlay/index.html` ouvert
sans Tauri) ne peut plus parler au vrai connecteur, il n'a pas accès à cette
commande. C'est un renoncement assumé : ce mode n'a jamais été le chemin de
production, seulement un outil de réglage visuel.

## Ce qui reste à faire

1. ~~Empaqueter en Tauri~~ — fait. Bande transparente ancrée au bord droit,
   `decorations: false`, `transparent: true`, `alwaysOnTop: true`,
   `skipTaskbar: true`, `resizable: false`, `shadow: false`. `WS_EX_NOACTIVATE`
   posé *après* `show()` (tao réapplique ses propres styles pendant l'affichage
   initial et écraserait sinon ce qu'on pose avant). Click-through géré par un
   suivi global du curseur côté Rust (`GetCursorPos`), comparé à la zone
   cliquable que l'overlay signale via `sync_hit_region` — `set_ignore_cursor_events`
   coupe tous les événements souris de la fenêtre, pas juste une région, donc un
   mousemove JS ne peut pas détecter le retour du curseur une fois le
   passthrough actif.
2. **Déclarer le connecteur en sidecar** (`externalBin`) pour n'avoir qu'un
   installeur et un process qui meurt avec l'app. Compiler le Node en exe unique
   avec `bun build --compile`. C'est aussi ce qui donnera un vrai redémarrage
   automatique si le connecteur meurt (le process actuel survit à ses propres
   exceptions non interceptées, mais rien ne le relance s'il est tué de
   l'extérieur).
3. ~~Port aléatoire + token~~ — fait, voir ci-dessus.
4. ~~Indicateur de session expirée~~ — fait. La bulle grise
   (`data-connector="down"|"expired"` sur `.dock`) dès que le WS est injoignable
   ou que WhatsApp signale une déconnexion, visible sans ouvrir le panneau.
   Cliquer dessus sans message en attente affiche désormais le pourquoi au lieu
   de ne rien faire.
5. **`sendPresenceUpdate('composing')`** quand l'utilisateur clique dans le
   champ — le contact voit « en train d'écrire… ». Le connecteur gère déjà la
   commande, l'overlay ne l'émet pas encore.
6. **Écran de configuration** : afficher le QR dans l'interface plutôt que dans
   le terminal.
7. ~~Chiffrer `connector/auth/`~~ — fait, voir §Sécurité. Ne couvre que l'arrêt
   propre, pas un crash ou un kill forcé.

## Design

Le widget doit passer pour un élément de Windows 11, pas pour une app posée
dessus. Vocabulaire Fluent : acrylique sombre, contours à très faible opacité,
courbe `cubic-bezier(0.55, 0.55, 0, 1)`, Segoe UI Variable.

Le vert WhatsApp (`#25d366`) est le seul accent et n'apparaît qu'à deux
endroits : le compteur de non-lus, et le bouton d'envoi une fois qu'il y a
quelque chose à envoyer. Ne pas l'étendre ailleurs.

## Note sur les CGU

Baileys est une bibliothèque non officielle. L'utiliser sur son propre numéro,
pour répondre à des gens qui ont écrit en premier, à vitesse humaine, est le
profil d'usage le moins exposé — les bannissements frappent la prospection et
le volume. Le risque n'est pas nul pour autant. Ne jamais ajouter d'envoi en
masse, de réponse automatique ou de temporisation agressive à ce projet.

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
comptait traiter plus tard. L'inverse, en revanche, est câblé : quand un fil
est lu ou répondu depuis un autre appareil (téléphone, WhatsApp Web), le
connecteur émet `{type:'read', jid}` et l'overlay vide ce fil de sa file.
Bulle *réagit* à une lecture faite ailleurs, elle n'en *émet* jamais. Signaux
côté connecteur : `chats.update` dont le `unreadCount` retombe à 0 ; un accusé
`message-receipt.update` portant un `readTimestamp` dont le `userJid` est le
nôtre (`sameUser`, suffixe `:device` ignoré) ; et tout message `key.fromMe` en
`notify` (une réponse envoyée du téléphone). Lequel de ces signaux remonte
vraiment quand on *ouvre* un fil sur le téléphone sans y répondre n'est pas
tranché — chacun logue `[lecture?] …` pour être relevé sur appareil réel
(`npm start`, sortie visible), après quoi on garde le fiable et on retire
l'instrumentation. `messages.update` est écouté mais jamais câblé à
`signalRead` : son `status` concerne un destinataire lisant *notre* message,
pas l'inverse. Si le panneau est ouvert sur ce fil précis, la file n'est pas
touchée en direct — une mention « lu sur un autre appareil » s'affiche et la
purge attend la fermeture, pour ne pas couper une réponse en cours.

**`markOnlineOnConnect: false`.** Sinon WhatsApp cesse d'envoyer les push sur
le téléphone, qui reste l'appareil principal de l'utilisateur.

**Pas d'indicateur « en train d'écrire ».** Le connecteur sait déjà traiter
la commande `{type:'typing', jid}` (`sendPresenceUpdate('composing', jid)`,
correctement scopée par fil — plusieurs expéditeurs simultanés ne posent pas
de problème technique), mais l'overlay ne l'émet jamais et ce n'est pas un
oubli : valeur trop faible pour l'effort et la surface ajoutée.

## Les pièges Baileys

Chacun coûte une soirée si on tombe dedans.

1. **Le déluge d'historique.** `messages.upsert` reçoit toute la synchro
   initiale. Filtrer sur `type !== 'notify'` — `'append'`, c'est l'historique.
   Sans ce filtre, la bulle reçoit des centaines de vieux messages au démarrage.
2. **`key.fromMe`.** Les messages envoyés depuis le téléphone remontent aussi.
   Ils ne rentrent pas dans la bulle, mais servent de signal « fil traité
   ailleurs » (voir `{type:'read'}` plus bas) avant d'être ignorés.
3. **`status@broadcast`** et `@newsletter` : à écarter.
4. **La déconnexion 515 après le scan du QR** est normale et attendue.
   Reconnecter sur tout sauf `DisconnectReason.loggedOut` — sinon on boucle à
   l'infini sur un compte délié.
5. **Les messages sans texte** (média nu, réaction, appel, accusé) n'ont pas
   leur place dans une bulle de réponse rapide. Les ignorer.
6. **La génération du QR est asynchrone.** `QRCode.toDataURL(qr)` tourne en
   arrière-plan pendant que `connection.update` continue d'émettre — la
   déconnexion 515 (piège 4) crée une fenêtre où cette promesse peut se
   résoudre *après* que la connexion soit passée à `'open'`. Sans garde, son
   `.then()` réécrit alors `connectionState`/`latestQr` en `'pairing'` avec un
   QR périmé, et plus rien ne l'efface tant que le connecteur tourne — chaque
   nouveau client WebSocket se refait renvoyer un QR obsolète indéfiniment.
   Garder une variable (`pendingQr`) qui retient le QR en cours d'encodage et
   vérifier qu'elle n'a pas changé avant d'appliquer le résultat.
7. **Le mimetype audio contient un espace.** `audioMessage.mimetype` vaut
   `"audio/ogg; codecs=opus"` (constante Baileys elle-même). Injecté tel quel
   dans une data URL (`data:${mime};base64,...`), l'espace brut n'est pas un
   caractère valide dans une URL : le navigateur le pourcent-encode à la
   volée et le `<audio>` ne reconnaît plus le type, échec silencieux à la
   lecture. Les mimetypes image/sticker n'ont pas ce paramètre, d'où un bug
   qui ne touche que l'audio. Retirer les espaces du mimetype avant de
   construire la data URL.
8. **Les enveloppes `viewOnceMessage*` et `ephemeralMessage`.** Une photo à
   usage unique arrive sous `message.viewOnceMessageV2.message.imageMessage`
   (ou `viewOnceMessage`, `viewOnceMessageV2Extension`) ; un fil en messages
   éphémères enveloppe *tous* ses messages sous `message.ephemeralMessage.
   message.*`. Sans déballage, `extractText`/`mediaFor` renvoient `null` et le
   message est ignoré en silence — texte compris pour les fils éphémères. Les
   deux enveloppes peuvent s'imbriquer. `downloadMediaMessage` ne sait pas
   déballer : lui passer une copie du message dont `.message` est le contenu
   déballé. Voir `connector/messages.js` (`unwrapMessage`, `isViewOnce`) et
   `messages.test.mjs`.

## Analyse d'un message

`connector/messages.js` isole les fonctions pures — `unwrapMessage`,
`isViewOnce`, `extractText`, `mediaFor`, `contextInfoFor`, `resolveMentions`,
`sameUser`, `pickContactName` — pour qu'elles soient testables sans réseau ni
Baileys live (`node --test connector/messages.test.mjs`). `index.js` ne fait
plus que les câbler au flux et télécharger le média.

**Mentions de groupe.** Une mention arrive dans le texte sous la forme
`@<chiffres>` (partie utilisateur d'un numéro ou d'un LID) ; les JID visés
sont dans `contextInfo.mentionedJid`. `resolveMentions` remplace chaque
`@<chiffres>` par `@<nom>` quand la `Map contacts` connaît ce JID. Une
mention non résolue — LID absent du carnet, forme de JID qui ne correspond
pas — reste `@<chiffres>` : pas d'invention d'identité à partir d'un numéro
(voir « Le `remoteJid` est une clé opaque »).

Types de média reconnus : `image`, `sticker`, `audio`, `video`. Le champ
`media` du protocole porte `{kind, mime, dataUrl, viewOnce?}` — `viewOnce`
n'est présent (à `true`) que pour un média à usage unique, que l'overlay
affiche quand même (Bulle n'a pas de mémoire, il s'efface avec la file) mais
étiquette « vue unique » puisqu'il n'est déjà plus sur le téléphone.

**Nom affiché (`from`).** Pour un fil 1:1, on préfère le nom qu'*on* a
enregistré pour le contact (`pickContactName` sur le champ `name` du carnet
d'adresses propagé par le multi-appareils), à défaut le `pushName` que le
contact s'est donné, à défaut « Inconnu ». Baileys ne tient pas de store de
contacts : `index.js` garde une `Map` JID → nom (`contacts`, même forme que
`avatars` — RAM, non persistée, pas d'historique), alimentée par
`messaging-history.set`, `contacts.upsert` et `contacts.update`. En groupe le
sujet reste géré côté overlay ; on n'y résout pas encore l'expéditeur.

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
| connecteur → overlay | `{type:'message', jid, from, text, avatar, at, group, media?}` — `media` = `{kind:'image'\|'sticker'\|'audio'\|'video', mime, dataUrl, viewOnce?}` |
| connecteur → overlay | `{type:'sent', ok, error?}` · `{type:'qr'}` · `{type:'status', state}` |
| connecteur → overlay | `{type:'read', jid}` — ce fil a été lu ou répondu sur un autre appareil |
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

Un lien reçu et une image agrandie sortent de la bulle, jamais dans la
WebView : commandes Rust `open_url` (navigateur par défaut, http(s)
uniquement, revérifié côté Rust) et `open_media` (écrit le média dans
`<tmp>/bulle-media/`, l'ouvre dans la visionneuse du système ; dossier vidé à
chaque appel et à la sortie — un fichier encore verrouillé par la visionneuse
survit jusqu'au nettoyage suivant, limite assumée). Toute commande custom doit
être déclarée à la fois dans `build.rs` (`AppManifest::commands`) et dans
`capabilities/default.json` (`allow-<commande>`). Le repérage des liens dans le
texte est une fonction pure, `overlay/linkify.js` (`parseLinks`), testée
(`overlay/linkify.test.mjs`) ; l'overlay construit les nœuds `<a>` à partir des
jetons — jamais d'`innerHTML`. Le vert WhatsApp ne s'étend pas aux liens : ils
se distinguent par le soulignement.

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
   passthrough actif. `syncHitRegion` lit `getBoundingClientRect()` un rAF
   après `setState('open')`, alors que le panneau est encore en pleine
   transition `transform` : le rectangle capturé serait celui du panneau
   rétréci et décalé, avec une bande morte le long des bords (bouton emoji,
   moitié gauche du lecteur audio). D'où une resynchronisation sur le
   `transitionend` du `transform` du panneau, quand la géométrie est stable.
2. ~~Déclarer le connecteur en sidecar~~ — fait. `scripts/build-sidecar.mjs`
   compile `connector/index.js` en exécutable unique avec `bun build --compile`
   (nommé au triplet de cible Rust), lancé automatiquement avant
   `tauri dev`/`tauri build` et déclaré en `bundle.externalBin`. Rust spawne le
   sidecar via `tauri-plugin-shell` et le relance automatiquement s'il meurt
   (crash, tué de l'extérieur) — un seul `.exe`, un seul arbre de process.
   Limite assumée, identique à celle du chiffrement de `auth/` : un kill forcé
   de `bulle.exe` (`Stop-Process -Force`) laisse le connecteur orphelin, car
   aucun handler d'arrêt propre ne se déclenche sur une terminaison forcée.
   Garde-fou pour ce cas (et pour un `node connector` lancé à la main resté en
   fond) : un **verrou mono-instance** (`%APPDATA%/Bulle/connector.lock`,
   contenant le PID — voir `connector/lock.js`). Au démarrage, si le PID du
   verrou est encore vivant, la nouvelle instance ressort en code 0 sans rien
   toucher (ni `auth/`, ni le fichier de découverte). Deux connecteurs sur la
   même session Baileys se déconnectaient sinon mutuellement en boucle — c'est
   la bulle qui vire au gris puis au vert sans arrêt. Un verrou périmé (PID
   mort) est écrasé.
3. ~~Port aléatoire + token~~ — fait, voir ci-dessus.
4. ~~Indicateur de session expirée~~ — fait. La bulle grise
   (`data-connector="down"|"expired"` sur `.dock`) dès que le WS est injoignable
   ou que WhatsApp signale une déconnexion, visible sans ouvrir le panneau.
   Cliquer dessus sans message en attente affiche désormais le pourquoi au lieu
   de ne rien faire.
5. ~~Écran de configuration~~ — fait. Le QR s'affiche dans le panneau plutôt
   que dans le terminal (voir piège Baileys n°6 pour le bug de course qui
   pouvait le laisser affiché après connexion, corrigé).
6. ~~Chiffrer `connector/auth/`~~ — fait, voir §Sécurité. Ne couvre que l'arrêt
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

# Bulle — cahier du projet

> Ce dépôt contient trois documents, chacun avec un rôle distinct.
> **`PROJET.md`** (ce fichier) : l'intention, le périmètre et le plan d'exécution.
> **`CLAUDE.md`** : les décisions techniques et les pièges, écrit pour un agent.
> **`README.md`** : comment lancer le projet en deux minutes.

---

## 1. Le problème

Répondre à un message WhatsApp depuis un PC coûte bien plus que les cinq
secondes que prend la réponse elle-même.

Le trajet réel : la notification apparaît, on bascule sur WhatsApp Web ou
l'application, on cherche la conversation, on tape trois mots, on revient à ce
qu'on faisait. Trente à quarante secondes, et surtout une rupture d'attention
dont on ne revient pas immédiatement. Répété quinze fois dans une journée de
travail, c'est le vrai coût.

Les notifications push existantes ne règlent rien : elles **préviennent**, puis
renvoient vers l'application. L'alerte est résolue, l'interruption reste
entière.

## 2. L'idée

Une bulle ancrée au bord de l'écran, placée une fois puis oubliée.

Un message arrive : elle s'anime, affiche l'avatar de l'expéditeur et un
compteur. Un clic : elle s'entrouvre en un petit panneau — nom, message, champ
de réponse. On tape, on valide, elle se referme.

WhatsApp ne s'ouvre jamais. La bulle **est** l'endroit où l'échange se passe.

Modèle mental : les *chat heads* d'Android, portés sur le bureau Windows.

## 3. Périmètre

### Ce que le projet fait

- Signaler un message WhatsApp entrant, sans voler le focus
- Afficher l'expéditeur et le contenu du message
- Permettre d'y répondre en texte
- Se laisser positionner où l'utilisateur veut, et y rester

### Ce que le projet ne fait pas

Pas d'historique. Pas de liste de conversations. Pas de médias, pas de
recherche, pas de stockage de messages, pas d'envoi à froid vers un contact qui
n'a pas écrit en premier.

Cette limite n'est pas une étape intermédiaire, c'est la définition du produit.
La bulle est une **surface d'interaction**, pas une boîte de réception — ce qui
existe déjà et s'appelle WhatsApp.

Concrètement, deux opérations suffisent :

| | |
|---|---|
| entrée | nouveau message de X dans le fil Y |
| sortie | envoyer ce texte dans le fil Y |

Toute proposition qui ajoute de l'état persistant (base de données, cache de
conversations, synchronisation d'historique) sort du périmètre. La refuser.

### Périmètre de la version actuelle

**WhatsApp seul.** Instagram viendra peut-être plus tard, derrière la même
interface de connecteur. Snapchat probablement jamais — voir §7.

## 4. Pourquoi c'est réalisable

Trois voies ont été examinées. Une seule tient.

**Écouter les notifications de Windows.** L'API `UserNotificationListener`
permet de lire les notifications système d'autres applications. Elle fonctionne,
mais elle est **en lecture seule** : impossible de déclencher le champ de
réponse rapide d'une notification. Elle ne peut donc servir qu'à afficher.

**Passer par le téléphone.** Sur Android, `NotificationListenerService` capte
les notifications et `RemoteInput` renvoie la réponse — c'est la voie idéale,
et elle ne contrevient à rien. Mais l'utilisateur a un **iPhone**, et iOS n'a
aucun équivalent. Le seul canal est ANCS en Bluetooth LE, qui ne transporte que
des actions positive/négative : aucun moyen de renvoyer du texte libre. C'est
une limite du protocole, pas un manque d'effort — Phone Link de Microsoft bute
exactement dessus et ne sait répondre que dans l'app Messages.

**Se lier au compte directement.** Baileys implémente le protocole
multi-appareil de WhatsApp en WebSocket. Le PC devient un appareil lié, comme
WhatsApp Web, **indépendamment de l'OS du téléphone**. C'est la voie retenue :
elle donne un vrai flux d'événements et un vrai envoi, sans navigateur caché ni
sélecteurs DOM à recorriger.

## 5. Architecture

Deux processus, un contrat minuscule entre les deux.

```
┌─────────────────────┐         ┌──────────────────────┐
│  connecteur (Node)  │  ws://  │   overlay (Tauri)    │
│                     │ 127.0.0.1│                      │
│  session Baileys    │◄───────►│  bulle + panneau     │
│  filtres            │  :8787  │  aucune logique      │
│  envoi              │         │  WhatsApp            │
└─────────────────────┘         └──────────────────────┘
         │
    ./auth (session)
```

**Contrat WebSocket** — à garder stable, c'est lui qui permettra de brancher un
autre service plus tard sans toucher à l'interface :

| Sens | Message |
|---|---|
| connecteur → overlay | `{type:'message', jid, from, text, avatar, at, group}` |
| connecteur → overlay | `{type:'sent', ok, error?}` |
| connecteur → overlay | `{type:'qr'}` · `{type:'status', state}` |
| overlay → connecteur | `{type:'reply', jid, text}` |
| overlay → connecteur | `{type:'typing', jid}` |

L'overlay ne sait rien de WhatsApp. Il affiche des messages normalisés et émet
des commandes. C'est ce découplage qui rend le projet extensible sans dette.

## 6. Plan d'exécution

Cinq phases. **Ne pas commencer la suivante tant que la précédente n'est pas
réellement terminée** — chacune produit quelque chose d'utilisable, et c'est ce
qui empêche le projet de s'effondrer sous des demi-fonctionnalités.

### Phase 0 — Valider l'interface · *fait*

L'overlay tourne seul dans un navigateur, alimenté par de faux messages.

**Terminé quand** : la taille de la bulle, la vitesse d'ouverture, la hauteur
du panneau et la discrétion au repos ont été réglées et convainquent. Tout se
règle dans les variables en tête de `overlay/overlay.css`.

*Cette phase coûte zéro risque et zéro compte. La faire à fond avant de brancher
quoi que ce soit.*

### Phase 1 — Valider le flux réel · *code écrit, à éprouver*

Le connecteur se lie au compte, l'overlay bascule automatiquement.

**Terminé quand** : un message réellement envoyé par quelqu'un apparaît dans la
bulle, la réponse tapée dans le panneau lui parvient, et le tout survit à
plusieurs heures d'affilée sans déconnexion non gérée.

*Éprouver sur un numéro secondaire si possible.*

### Phase 2 — En faire une vraie fenêtre

Empaquetage Tauri. C'est ce qui transforme une page web en widget.

Scaffolder avec le CLI courant plutôt que de recopier une configuration figée.
Réglages nécessaires : `decorations: false`, `transparent: true`,
`alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`, `shadow: false`.
Côté Windows, ajouter `WS_EX_NOACTIVATE` pour que la bulle ne prenne jamais le
focus, et gérer le click-through en dehors de la bulle.

**Terminé quand** : la bulle flotte sans bordure au-dessus des autres fenêtres,
n'apparaît pas dans la barre des tâches, ne vole pas le focus au clavier, et
les clics à côté d'elle atteignent la fenêtre du dessous.

### Phase 3 — Le rendre fiable

C'est la phase qu'on est tenté de sauter et qui décide de tout. Un widget qui
échoue en silence est abandonné en une semaine.

- Indicateur de session expirée : la bulle passe en gris avec « Reconnecter »
- Redémarrage automatique du connecteur s'il meurt
- Port aléatoire et jeton d'authentification au lieu du 8787 en dur
- Chiffrement du dossier `auth/` (DPAPI ou plugin Stronghold de Tauri)

**Terminé quand** : on peut laisser tourner une semaine, et le widget soit
fonctionne, soit dit clairement pourquoi il ne fonctionne pas.

### Phase 4 — Le rendre installable

Déclarer le connecteur en sidecar (`externalBin`) : un seul installeur, un seul
arbre de processus qui meurt avec l'application. Compiler le Node en exécutable
unique avec `bun build --compile`. Ajouter le lancement au démarrage et
l'écran de configuration affichant le QR dans l'interface plutôt que dans un
terminal.

**Terminé quand** : sur une machine propre, on lance un installeur, on scanne
un QR, ça marche.

### Phase 5 — *optionnel* — Un deuxième service

Instagram, derrière la même interface de connecteur. À n'envisager qu'une fois
les phases 0 à 4 solides.

## 7. Risques et limites

**La session Instagram et Snapchat ne tiendra pas.** Si le projet s'étend un
jour, ces deux services n'ont pas d'API et n'offrent que du pilotage de client
web, avec des sélecteurs à recorriger en permanence. Snapchat détecte activement
l'automatisation. Ne pas promettre ce qu'on ne pourra pas maintenir.

**Baileys est une bibliothèque non officielle.** Son usage peut contrevenir aux
conditions d'utilisation de WhatsApp. Le profil d'usage ici — son propre numéro,
des réponses à des gens qui ont écrit en premier, à vitesse humaine, aucun envoi
en masse — est le moins exposé qui soit ; les suspensions frappent la
prospection et le volume. Le risque n'est pas nul pour autant. **Ne jamais
ajouter d'envoi en masse, de réponse automatique ou de temporisation agressive
à ce projet** : c'est précisément ce qui déclenche les bannissements.

**L'écosystème npm autour de Baileys contient des paquets malveillants.**
Plusieurs forks proposent d'aliaser `@whiskeysockets/baileys` vers leur propre
paquet. N'installer que `baileys` ou `@whiskeysockets/baileys`, verrouiller les
versions, lire le diff avant chaque montée.

**Le dossier `auth/` est une session active sur un compte personnel.** Il n'est
pas versionné et ne doit jamais l'être.

**Le protocole peut changer.** WhatsApp fait évoluer son protocole interne ; la
bibliothèque casse alors jusqu'à ce que les mainteneurs rattrapent. C'est un
projet personnel, pas une dépendance de production.

## 8. Règles de travail

1. **Une phase à la fois.** Ne pas ouvrir la suivante avant que la précédente
   fonctionne réellement, pas « en principe ».
2. **Le contrat WebSocket est figé.** Le modifier casse le découplage qui fait
   la valeur de l'architecture.
3. **Refuser l'élargissement du périmètre.** Chaque fois que l'envie vient
   d'ajouter l'historique, relire le §3.
4. **Le `remoteJid` est une clé opaque.** Ne jamais reconstruire l'identité
   d'un fil à partir d'un numéro de téléphone — voir la migration LID
   documentée dans `CLAUDE.md`.
5. **Rien ne s'ouvre tout seul.** La bulle signale, l'utilisateur décide.

## 9. Travailler avec Claude Code sur ce projet

Ouvrir le dossier et lancer `claude` dedans : `CLAUDE.md` est lu
automatiquement, donc les décisions déjà prises et les pièges déjà identifiés
n'ont pas besoin d'être réexpliqués.

Formuler les demandes **par phase**, pas par fonctionnalité isolée. Par exemple,
pour la phase 2 : « on est en phase 2 du plan dans PROJET.md, empaquette
l'overlay en Tauri avec les réglages listés, et vérifie que la fenêtre ne prend
pas le focus ». Le cadrage par phase évite l'accumulation de morceaux à moitié
finis, qui est le mode d'échec habituel de ce genre de projet.

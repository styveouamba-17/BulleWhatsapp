# Idées — une famille de mini-widgets

Notes d'exploration. Rien ici n'est décidé ni cadré. Bulle (WhatsApp) reste
le seul projet en cours ; ce fichier existe pour ne pas perdre une piste qui
plaît : **des mini-widgets « 1 widget, 1 objectif »**, ambiants, ancrés au
bord de l'écran, sur le modèle de Bulle.

## L'ADN, transposé

Ce qui fait marcher Bulle, généralisé :

1. **Une surface d'interaction, pas une app.** Au plus une entrée, au plus
   une sortie.
2. **Aucun état.** Pas d'historique, pas de liste au-delà de « ce qui attend
   maintenant », pas de base de données.
3. **Ne vole pas le focus.** Le widget signale, l'utilisateur décide.
4. **N'ouvre jamais l'app qu'il représente** comme action principale.
5. **Ressemble à un élément de Windows 11**, pas à une app posée dessus.

## Le filtre

Un widget entre dans la famille seulement si :

1. **une source** — il s'abonne à exactement un flux d'événements ;
2. **un verbe** — une seule action sortante, un seul appel (répondre, *ack*,
   rejoindre, ignorer). S'il en faut un deuxième, c'est deux widgets ;
3. **rien à retenir** — pas d'historique, pas de liste au-delà de « qui
   attend », pas d'écran de config au-delà de sourdine / position ;
4. **il n'ouvre jamais l'app source** comme action principale ;
5. **API sanctionnée si elle existe** — Baileys est l'exception déjà
   acceptée pour Bulle, pas le modèle à suivre pour les suivants.

## L'architecture qui rend la famille possible : l'hôte multi-source

Le protocole entre connecteur et overlay (voir `CLAUDE.md`) est déjà à ~90 %.
Il suffit d'ajouter un champ `source` :

| Sens | Message |
|---|---|
| hôte → widget | `{type:'message', source, …}` |
| hôte → widget | `{type:'status', source, …}` |

Le connecteur devient un **hôte** — un seul process en fond qui porte N
connecteurs (WhatsApp, météo, astreinte, …). La découverte / auth
(`bulle-connector.json`, port aléatoire + jeton) ne bouge pas. Chaque widget
est une fenêtre Tauri qui s'abonne à **une** source par son nom.

C'est le fait de ne s'abonner qu'à une source qui *impose* le « 1 widget
1 objectif » — ce n'est plus une règle de discipline, c'est structurel.

**Un seul signal inter-widgets, pas un moteur de règles :** un broadcast
« focus / DND » pour qu'une réunion en cours ou un incident fasse taire les
autres bulles. Au-delà de cette règle unique, il faudrait un écran de config
pour définir les règles — et là on casse le « rien à retenir ».

## Candidats

Une par domaine. Chacun passe le filtre.

### Jauge d'attention — *discipline / focus*
La bulle **enfle** dans la périphérie au fil du temps passé aujourd'hui dans
une app-poison (navigateur sur un site précis, jeu…). Source : le suivi de
fenêtre active de l'OS, 100 % local. Verbe unique : « bloquer 30 min » →
coupe l'accès (hosts / pare-feu). Aucun historique affiché, juste la taille
et la couleur.

Intérêt : aucune dépendance externe (pas de clé, pas de CGU, pas de
pourrissement), le verbe colle exactement à la philosophie, et c'est le cas
où la forme « bulle ambiante » fait ce qu'une app ne peut pas — une app de
temps d'écran, il faut l'ouvrir pour culpabiliser.

### Fenêtre pour sortir — *plein air / santé*
Répond à **une** question : « quand puis-je sortir sans pluie aujourd'hui ».
La bulle affiche « fenêtre sèche 14 h–16 h », vire à l'ambre quand elle
approche. Source : API météo. Pas de verbe.

### Colis en approche — *vie quotidienne*
S'allume quand un colis passe en « en cours de livraison » ou « à 2 arrêts ».
Source : API de suivi transporteur. Ne montre **jamais** qu'un seul colis,
le plus proche d'arriver. Verbe : aucun, ou « je ne suis pas là » si le
transporteur le gère.

### Prochain passage — *mobilité*
« Ligne 8 dans 6 min », pour **un** arrêt configuré, point. Source : API
transit temps réel. Pas de verbe. Remplace les allers-retours dans l'app
transport pendant qu'on se prépare.

### Prod à terre — *projets perso*
Rouge quand ton site / service ne répond plus. Source : un pinger d'uptime
(webhook). Verbe optionnel : « ouvrir le statut ». Le petit cousin d'une
bulle d'astreinte.

### Autres domaines évoqués, non détaillés
Astreinte / incident (PagerDuty, *ack* seul) · e-mail VIP (liste blanche
stricte, réponse rapide) · prochain rendez-vous (« réunion dans 8 min » +
rejoindre) · prompt de standup (à heure fixe, un champ, poste dans un canal).

### Candidats qui dérivent — prudence
File de PR à relire, statut CI, seuils de cours de bourse : tout ce qui veut
une **liste** ou un **historique** retourne vers l'app.

## Design détaillé — le widget météo

Retenu comme premier candidat à creuser. Le point de départ : **la météo
n'est pas un flux d'événements** comme WhatsApp, c'est un état continu. Le
widget doit donc *fabriquer* des événements à partir de ce qui change.

### Au repos
La bulle porte une icône condition + température (`☁️ 14°`), teinte très
discrète selon le temps. Mise à jour silencieuse toutes les ~15 min. Aucune
animation, aucun bruit.

### Quand quelque chose bascule
Elle fait le même *aperçu éclair* que la bulle WhatsApp, avec une phrase :

- « Pluie dans ~40 min, jusqu'à 16 h »
- « Ça se dégage vers 15 h »
- « −6° cette nuit, première gelée »
- « Rafales 60 km/h attendues à 18 h »

Le peek se rétracte seul. Pas de rebond agressif — c'est de l'info, pas une
sommation. En mode « Ne pas déranger », l'icône change sans peek.

### Au clic
Petit panneau : condition actuelle en grand, puis une bande des **6–12
prochaines heures** (icône + temp + proba de pluie par tranche). Pas de
semaine, pas de carte, pas de radar animé — même discipline que « au plus
les 2 messages précédents » dans Bulle. Se referme au clic ailleurs.

### Le verbe
**Aucune action sortante.** Premier widget de la famille dont l'objectif est
*savoir*, pas *agir* — et ça montre que « 1 widget 1 objectif » l'inclut. Au
plus un verbe léger : « tais-toi jusqu'à demain » pour couper les peeks
d'une journée.

### Ce qui déclenche un peek (4 règles, en dur, zéro config)
1. pluie / neige qui commence ou s'arrête dans les 60 min ;
2. alerte officielle du service météo (vent, orage, canicule, verglas) ;
3. première gelée / passage sous 0° ;
4. écart > ~8° par rapport à la même heure la veille.

### État & source
En mémoire : uniquement la prévision courante, re-fetchée sur timer. Aucun
historique, pas de « météo de mardi dernier ». Source : **Open-Meteo** —
gratuit, sans clé, CGU permissives, données horaires + alertes. Position
saisie une fois (nom de ville) ou géoloc IP grossière. Pas de GPS.

### Branchement
Un connecteur `weather` dans l'hôte multi-source qui émet
`{type:'message', source:'weather', text:'Pluie dans ~40 min'}` sur les
transitions et `{type:'status', source:'weather', glyph, temp}` à chaque
refresh. L'overlay du widget météo s'abonne à `source:'weather'` uniquement.
Peek, dormant, panneau : ré-usage direct de l'overlay existant.

### Question de caractère restée ouverte
La bulle au repos porte-t-elle en permanence le temps actuel (valeur de
coup d'œil, visage toujours affiché — plus « widget Windows »), ou
reste-t-elle une bulle neutre qui ne s'anime qu'aux changements (plus
« Bulle », plus silencieuse) ?

## Fragilités connexes à garder en tête (héritées de Bulle)

Si la famille se construit sur l'hôte multi-source, deux limites de Bulle se
propagent et méritent d'être traitées à ce niveau :

1. **Sidecar orphelin** après un kill forcé de l'app. Fix propre :
   auto-arrêt du connecteur quand plus aucun client overlay n'est connecté
   depuis ~20 s (fenêtre de grâce au démarrage), + `ws.ping()` périodique.
2. **`auth/` en clair** après un kill forcé. Mitigation sans risque : le
   process parent (Rust) rescelle `auth/` dès qu'il voit le connecteur
   mourir. Le cas « toute l'app tuée d'un coup » reste non couvert sans
   chiffrement à la volée — à assumer explicitement.

## Retour sur Bulle — se mettre à jour quand un message est lu ailleurs

> **Implémenté, partiellement vérifié.** Voir `CLAUDE.md` (protocole +
> §« Aucun accusé de lecture »), `connector/index.js` (`signalRead`,
> `chats.update`, branche `key.fromMe`), `overlay/overlay.js`
> (`readElsewhere`, `pendingReadJids`).
>
> **Observé :** ouvrir un fil sur le téléphone ne fait rien remonter —
> `chats.update` avec `unreadCount === 0` n'est pas (ou pas toujours) émis
> dans ce cas. À reprendre en instrumentant les événements Baileys bruts
> (`chats.update`, `messages.update`, `message-receipt.update` avec
> `userJid` = soi + `readTimestamp`) connecteur lancé en `npm start`
> (sous Tauri, sa sortie stdout n'est pas relayée par Rust — angle mort).
> La branche `key.fromMe` (réponse depuis un autre appareil) n'a pas été
> testée. Le `console.log` de `signalRead` reste en place pour ça.

Feature pour Bulle (WhatsApp), pas pour la famille de widgets. Quand
l'utilisateur lit vraiment un message sur un autre appareil (téléphone,
WhatsApp Web, Desktop), la bulle doit s'en apercevoir et se nettoyer : le
compteur baisse, le fil sort de la file.

**Ne contredit pas « Aucun accusé de lecture » du `CLAUDE.md`.** Cette
décision interdit à Bulle de *marquer* la conversation comme lue sur le
téléphone (sens Bulle → téléphone). Ici c'est l'inverse : Bulle *réagit* à
une lecture que l'utilisateur a faite lui-même, délibérément, ailleurs
(sens téléphone → Bulle). Les deux sens sont indépendants.

### Signal en entrée
Le connecteur écoute, en plus de `messages.upsert`, le signal « ce fil a été
lu ailleurs » que le multi-appareils propage. Piste Baileys : `chats.update`
avec `unreadCount` qui retombe à 0. **À confirmer par un test** — plusieurs
événements Baileys touchent au sujet, il faut le plus fiable.

Cas voisin, quasi gratuit : si l'utilisateur **répond depuis son téléphone**,
Bulle reçoit déjà ce message (`key.fromMe`, aujourd'hui ignoré — piège n°2).
On le traite comme « fil traité » et on vide ce fil de la file. Souvent plus
fiable que l'état de lecture.

### Protocole
Nouveau message additif, connecteur → overlay :

| Sens | Message |
|---|---|
| connecteur → overlay | `{type:'read', jid}` |

Pas de champ `at` : sur WhatsApp, ouvrir un fil le marque lu en entier, donc
la sémantique correcte est « vide ce fil », pas « vide jusqu'à telle date ».
Un message arrivé *après* l'événement `read` entre dans la file plus tard et
y reste (la fenêtre de course se limite à la latence réseau — acceptable
pour une file éphémère).

### Comportement overlay
À réception d'un `read` pour un `jid` : retirer de la `queue` tous les
messages de ce fil, puis re-rendu (compteur, peek, bande d'expéditeurs).
Un `read` en écho de notre propre envoi (`lastReply`) est ignoré pendant
~6 s.

**Zéro état ajouté** — ça ne fait que *retirer* de la file en RAM
(`pendingReadJids` mis à part : un Set transitoire vidé à la fermeture du
panneau).

### Cas panneau ouvert sur ce fil, avec un brouillon en cours
Le `read` **n'interrompt rien**. Il affiche une petite mention discrète
« lu sur un autre appareil » dans le panneau et laisse l'utilisateur finir
sa réponse. Le nettoyage de la file se fait à la fermeture du panneau.

### Fiabilité
La synchro multi-appareils n'est pas instantanée et peut occasionnellement
manquer un événement. Acceptable : la file de Bulle est déjà éphémère et non
autoritaire. Ne pas sur-concevoir.

# Bulle

Une bulle flottante sur le bureau Windows. Un message WhatsApp arrive, elle
s'anime. Un clic, elle s'entrouvre : nom, message, champ de réponse. WhatsApp
ne s'ouvre jamais.

## Voir l'interface tout de suite

Aucune installation, aucun compte.

```
overlay/index.html   ← ouvrir dans un navigateur
```

La bulle apparaît en bas à droite sur un faux bureau. Le bouton **Simuler un
message** en bas à gauche déclenche l'animation d'arrivée. Cliquer la bulle
l'entrouvre, on peut taper une réponse, l'envoi est simulé.

C'est là qu'on arbitre les vraies questions : taille de la bulle, vitesse de
l'ouverture, hauteur du panneau, discrétion au repos. Tout se règle dans les
variables en haut de `overlay/overlay.css`.

**Ce mode ne parle plus au vrai connecteur** depuis que celui-ci écoute sur un
port choisi au hasard (voir plus bas) : la découverte du port passe par une
commande Tauri, indisponible dans un onglet de navigateur nu. Pour tester avec
de vrais messages, il faut lancer l'app Tauri (§ suivant).

## Lancer l'app pour de vrai

Node 20+, et la chaîne Rust + outils de build C++ (voir
[tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)).

```bash
npm install
cd connector && npm install && cd ..
npm run tauri dev
```

La fenêtre Bulle s'ouvre, ancrée au bord droit de l'écran. Dans un second
terminal :

```bash
cd connector
npm start
```

Un QR code s'affiche dans ce terminal. Sur le téléphone :
**WhatsApp › Réglages › Appareils liés › Lier un appareil**. Une fois scanné,
la bulle se met à jour toute seule — aucune bascule manuelle.

Le connecteur choisit un port libre et un jeton à chaque lancement (plus de
8787 fixe) et dépose les deux dans un fichier du dossier temp système ; c'est
comme ça que l'app Tauri le retrouve. Si la bulle reste grise, c'est que ce
fichier n'existe pas encore ou que le connecteur n'a pas démarré.

La session est conservée dans `connector/auth/`. Pour repartir de zéro et
réappairer :

```bash
npm run reset
```

## Où en est le projet

- **Phase 0 — Interface** : faite.
- **Phase 1 — Flux réel** : faite.
- **Phase 2 — Vraie fenêtre (Tauri)** : faite — bande transparente ancrée au
  bord droit, toujours au-dessus, hors barre des tâches, focus bloqué,
  clic-through natif en dehors de la bulle.
- **Phase 3 — Fiabilité** : quasi complète. Fait : indicateur visuel de panne
  (bulle grisée quand le connecteur est injoignable ou la session WhatsApp
  révoquée), le connecteur ne meurt plus sur une exception isolée, port
  aléatoire + jeton à la place du 8787 en dur, chiffrement au repos de
  `connector/auth/` (DPAPI, entre deux lancements). Pas fait : redémarrage
  automatique si le process connecteur meurt entièrement — reporté à la
  phase 4, plus naturel une fois le connecteur en sidecar supervisé par
  Tauri.
- **Phase 4 — Installable** : pas commencée.

En bonus, hors plan initial : possibilité de choisir à qui répondre quand
plusieurs expéditeurs sont en attente (rangée d'avatars dans le panneau).

La liste complète, les décisions déjà prises et les pièges à ne pas
retraverser sont dans `CLAUDE.md`.

## Avertissement

`connector/auth/` contient une session active sur un compte WhatsApp personnel.
Ce dossier n'est pas versionné et ne doit jamais l'être.

Baileys est une bibliothèque non officielle : son usage peut contrevenir aux
conditions d'utilisation de WhatsApp et exposer le compte à une suspension.

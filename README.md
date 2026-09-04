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

## Brancher le vrai WhatsApp

Node 20 ou plus.

```bash
cd connector
npm install
npm start
```

Un QR code s'affiche dans le terminal. Sur le téléphone :
**WhatsApp › Réglages › Appareils liés › Lier un appareil**.

Une fois connecté, rouvrir `overlay/index.html` : il détecte le connecteur tout
seul et bascule sur le vrai flux. Le bandeau en bas à gauche passe au vert.

La session est conservée dans `connector/auth/`. Pour repartir de zéro et
réappairer :

```bash
npm run reset
```

## Ce qui n'est pas encore fait

Le projet est aux deux tiers : l'interface et le connecteur fonctionnent, mais
l'empaquetage Tauri reste à faire — c'est lui qui transformera la page web en
vraie fenêtre flottante sans bordure, toujours au-dessus, sans icône dans la
barre des tâches.

La liste complète est dans `CLAUDE.md`, avec les décisions déjà prises et les
pièges à ne pas retraverser.

## Avertissement

`connector/auth/` contient une session active sur un compte WhatsApp personnel.
Ce dossier n'est pas versionné et ne doit jamais l'être.

Baileys est une bibliothèque non officielle : son usage peut contrevenir aux
conditions d'utilisation de WhatsApp et exposer le compte à une suspension.

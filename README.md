# HermesBot

A desktop app (Electron, macOS) to run and follow your [Hermes Agent](https://github.com/NousResearch/hermes-agent) bots from one window: live chats, who is working right now, what each bot is doing, a secure credential prompt and approvals. The interface is currently in French.

Application de bureau pour piloter ses bots Hermes Agent depuis une seule fenêtre.

![Mode démo de HermesBot](docs/screenshot.png)

Projet indépendant, sans lien avec Nous Research.

## Fonctions

- Roster par groupes, ou liste unique avec l'activité la plus récente en premier.
- Qui travaille, d'un coup d'œil, avec un résumé de ce que fait chaque bot, rafraîchi en continu et assemblé sans appel de modèle.
- Bot Chat en streaming, Markdown, images envoyées, recherche, arrêt du tour.
- Médias des bots (`MEDIA:/chemin`) : galeries, vidéo, audio, visionneuse.
- Coffre d'identifiants : quand un bot doit se connecter à un site, une fenêtre montre le site et demande les identifiants ou un code. Tout va dans le coffre local de Hermes.
- Accords : une action soumise à approbation ouvre une fenêtre (une fois, session, toujours, refuser).
- Carte de mail : un brouillon à faire approuver s'affiche dans le fil, modifiable avant envoi. Voir `skills/mail-approval/`.
- Choix du modèle par conversation, contexte et débit.
- Routines en lecture seule, activité technique à part, thèmes clair et sombre.
- Bouton de reconnexion à la gateway.

## Prérequis

- macOS, Node.js 22 ou plus.
- Hermes Agent avec sa gateway Webapp sur `http://127.0.0.1:9120` et un compte à mot de passe.
- Des profils Hermes avec un bloc `ui_meta["hermes-bots"]` : seuls ceux-là apparaissent comme bots.

## Démarrer

```bash
npm ci
npm run dev
```

L'interface s'ouvre sur http://127.0.0.1:4330. Pour la voir sans Hermes : http://127.0.0.1:4330/?demo=1

Application de bureau :

```bash
npm run desktop
npm run pack
```

`npm run pack` produit une app non signée dans `release/`.

## Réglages

Tous sont facultatifs.

| Variable | Clé de `config.json` | Défaut | Rôle |
|---|---|---|---|
| `HERMES_ORIGIN` | `gatewayOrigin` | `http://127.0.0.1:9120` | Adresse de la gateway |
| `HERMES_BROWSER_ORIGIN` | `browserOrigin` | même valeur | `Origin` envoyé à la gateway, si elle n'accepte qu'une adresse publique |
| `HERMES_SSH_HOST` | `sshHost` | vide | Hôte SSH pour ouvrir un tunnel quand la gateway ne répond pas |

`config.json` se place dans `~/Library/Application Support/HermesBot/` et ne sert qu'à l'application de bureau.

## Carte de mail

Copie `skills/mail-approval/` dans `skills/email/` du profil Hermes concerné (il lui faut [himalaya](https://github.com/pimalaya/himalaya)). Le bot affiche alors un brouillon modifiable. Envoyer lance un tour du bot, avec le contenu validé et son empreinte ; le script de la skill refuse d'envoyer un mail qui n'y correspond plus, ou le même mail deux fois.

## Animations facultatives

Pour qu'un bot s'anime, ajoute `public/animations/<slug>-working.webp` et `<slug>-done.webp`, puis son slug dans `src/lib/animations.ts`.

## Sécurité

- Le serveur local écoute seulement sur `127.0.0.1:4330` et vérifie `Host` et `Origin`.
- Les cookies et tickets Hermes restent côté serveur. Le navigateur reçoit un identifiant opaque.
- Dans l'application de bureau, les sessions sont chiffrées avec `safeStorage` et le Trousseau. Sans lui, rien n'est conservé.
- Les réponses des bots passent par une CSP stricte. Aucune image distante n'est chargée.
- Les identifiants saisis dans le coffre ne sont ni affichés, ni journalisés, ni gardés par l'app.

À savoir :

- Tout processus local qui écoute sur le port de la gateway reçoit le mot de passe de connexion.
- Envoyer un message lance le modèle du profil : cela peut être payant.
- Il n'y a pas encore de bouton de déconnexion. Une session dure 30 jours.
- L'application n'est pas signée.
- Le tunnel SSH n'est pas relancé s'il tombe : il faut relancer l'application.

## Tests

```bash
npm run check
npm run test:e2e
```

Le test de bout en bout utilise une gateway simulée, sans appel de modèle. Il lui faut Google Chrome.

## Crédits et licence

Licence MIT, voir [LICENSE](LICENSE). Certaines règles, dont les balises `MEDIA:`, suivent le comportement de Hermes Desktop (Nous Research, MIT).

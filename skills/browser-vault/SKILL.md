---
name: coffre-chrome
description: Use when a site in the shared bots Chrome (CDP 127.0.0.1:9222) asks you to log in, or asks for a verification code. Never type or read a password yourself.
---

# Se connecter dans le Chrome partagé avec le coffre HermesBot

Le coffre HermesBot garde les identifiants dans le trousseau de session macOS de la machine des bots. Il tape lui-même le mot de passe dans TON onglet : tu ne vois jamais le mot de passe, il ne passe ni par le chat, ni par tes outils, ni par les journaux.

Commande, depuis n’importe quel dossier :

```bash
node ~/projects/hermes-bot/scripts/browser-vault.mjs <list|save|fill|code> --bot <ton profil> [--target <targetId>]
```

`targetId` est l’id de TON onglet : celui renvoyé par `PUT /json/new?<url>` (ou `cdp.mjs new`). Jamais un onglet que tu n’as pas ouvert.

## Règles

- Prendre le tour du Chrome avant, comme pour tout accès à 9222 (`browser-turn prendre`), et le rendre après.
- Ne jamais taper, lire, copier ni afficher un mot de passe : pas de `eval` sur un champ `password`, pas de `.value`, pas de capture d’un formulaire rempli envoyée dans un message.
- Ne jamais demander un mot de passe à l’utilisateur dans le chat : le coffre lui ouvre une fenêtre sécurisée dans HermesBot.
- Dans le Chrome partagé, utiliser ce coffre, pas l’outil `browser_vault` de Hermes : celui-ci range les mots de passe ailleurs.
- Seulement les quatre commandes ci-dessus. Ne jamais appeler l’API `/admin` du coffre, lire son jeton, ni chercher un mot de passe dans le trousseau (`security`) : c’est réservé à l’utilisateur et à l’app HermesBot.
- En tâche planifiée (cron) : jamais `save` ni `code`, personne n’est là pour répondre. Si `fill` ne suffit pas, s’arrêter et le signaler.

## Déroulé

1. `list --bot <profil>` : les sites auxquels tu as droit (origine et identifiant, jamais de mot de passe).
2. Ouvrir la page de connexion dans ton onglet et vérifier `location.origin`.
3. Si l’origine est listée : `fill --bot <profil> --target <targetId>`. Réponse `{"status":"filled","fields":["identifier","password"]}`. Cliquer ensuite toi-même sur le bouton de connexion.
4. Sinon : `save --bot <profil> --target <targetId>`. l’utilisateur reçoit « <bot> a besoin de tes identifiants » dans HermesBot. La commande attend jusqu’à 6 minutes.
   - `{"status":"saved"}` : refaire `fill`.
   - `{"status":"cancelled"}` : l’utilisateur a répondu « Plus tard ». Ne pas redemander pendant ce tour ; le dire dans ta réponse.
5. Code de vérification :
   - reçu par mail : le lire dans ta boîte et le taper toi-même (un code à usage unique n’est pas un mot de passe) ;
   - sinon : `code --bot <profil> --target <targetId>`. l’utilisateur tape le code dans HermesBot et le coffre l’injecte dans la page.

## Erreurs

- `origin_not_found` : aucun identifiant pour ce site. Faire `save`.
- `bot_not_allowed` : l’identifiant est réservé à d’autres bots. Demander à l’utilisateur de t’autoriser (HermesBot, Réglages, Coffre). Ne pas contourner avec `save`.
- `origin_mismatch` : la page a changé de site pendant l’appel. Vérifier l’URL, puis recommencer.
- `login_fields_not_found` ou `code_field_not_found` : aucun champ reconnu. Afficher le bon formulaire (étape « Se connecter », champ du mot de passe), puis recommencer.
- `target_required` : il manque `--target`.
- `vault_unavailable`, `vault_service_unavailable`, `request_timeout`, `cdp_unavailable` : s’arrêter et prévenir.

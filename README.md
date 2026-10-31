# Bot anti-raid mono-serveur

Bot Discord personnel configuré pour **un seul serveur**, avec détection des vagues d'arrivées, du spam/répétition de messages, et des actions massives (création/suppression de salons ou rôles, bans, kicks et timeouts). Les alertes/commandes liées à la blacklist et aux alertes du projet source ne sont pas reprises. Les journaux de détection sont des logs opérationnels dans le salon configuré.

## Installation

1. Installer Node.js 18.17+ puis lancer `npm ci` (ou `npm install` si le lockfile n'est pas disponible).
2. Éditer `config.json` : renseigner le token du bot, l'ID du serveur, les IDs de salons/rôle, les listes d'exemption, seuils et actions.
3. Dans le Developer Portal Discord, activer **Server Members Intent** et **Message Content Intent**. Donner au bot les permissions nécessaires : voir les salons, lire/modérer les messages, gérer les messages, gérer les rôles et modérer les membres (timeout). Pour détecter actions via les journaux d'audit, lui accorder **View Audit Log**. Placer son rôle au-dessus du rôle de quarantaine et des rôles des membres qu'il doit modérer.
4. Démarrer avec `npm start`.

## Configuration

- `guildId` limite strictement le traitement à ce serveur.
- `whitelist.userIds` et `whitelist.roleIds` désignent les comptes/rôles exemptés (le propriétaire et les bots sont automatiquement ignorés pour les sanctions).
- `limits` définit les fenêtres en millisecondes et seuils de détection.
- `actions.onRaidJoin` : `quarantine` applique le rôle si `quarantineRoleId` est défini. Autre valeur : pas de rôle automatique.
- `actions.onSpam` : `timeout` applique un timeout; `spamTimeoutMs` règle sa durée.
- `actions.onDestructiveRaid` : `removeRoles` retire les rôles modifiables et applique un timeout. Cette sanction ne restaure pas automatiquement les salons/rôles supprimés.
- `logChannelId` peut rester vide; les erreurs restent visibles dans la console.

**Sécurité :** ne partagez jamais le token. `config.json` est ignoré par Git; gardez le token uniquement dans votre copie locale. Réinitialisez-le immédiatement s'il a été exposé. Le bot n'est pas un remplacement de sauvegardes ni des protections natives Discord.

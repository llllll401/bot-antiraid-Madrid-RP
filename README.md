# Gestion des absences Discord

Bot pour un seul serveur Discord : gestion des demandes d’absence et des sanctions Warn 1, Warn 2 et mise à pied de trois jours. Les permissions d’accès aux salons définissent qui peut demander une absence ou créer une sanction ; aucun rôle spécial d’autorisation n’est codé en dur.

## Installation rapide

1. Utiliser Node.js 18 ou plus récent, puis lancer `npm ci`.
2. Compléter `config.json` : token du bot, ID du serveur, IDs des cinq salons et IDs des trois rôles de sanction.
3. Inviter le bot avec le scope `bot` et les permissions nécessaires pour voir les salons, envoyer des messages, intégrer des liens, gérer les rôles de sanction et mentionner les rôles choisis (permission `Mention Everyone` si les rôles ne sont pas eux-mêmes mentionnables). Son rôle doit être au-dessus des trois rôles de sanction. Active **Server Members Intent** dans le Developer Portal pour vérifier les membres et synchroniser les rôles.
4. Lancer `npm start`.

Au démarrage, le bot supprime les anciennes commandes slash enregistrées pour son application (globales et propres au serveur), puis poste/récupère les panneaux et restaure les demandes en attente. Il n’utilise plus l’antiraid ni la whitelist.

## Salons et sanctions dans `config.json`

- `sanctionPanelChannelId` : salon du panneau persistant « Créer une sanction ».
- `sanctionLogChannelId` : journal des sanctions et de leurs expirations. Les rôles choisis dans le sélecteur sont réellement mentionnés/pingés à la création.
- `sanctionRoles.warn1`, `sanctionRoles.warn2`, `sanctionRoles.suspension3Days` : IDs des trois rôles de sanction.
- `sanctionDurationsDays` : durées configurables ; par défaut Warn 1 = 7 jours, Warn 2 = 7 jours après l’expiration du Warn 1 lié (son rôle est ajouté dès l’application), et mise à pied = 3 jours.

Le bouton du panneau ouvre un sélecteur éphémère : membre et niveau de sanction disponible. Le bouton Continuer ouvre le modal du motif ; ensuite, un sélecteur permet de choisir jusqu’à cinq rôles à mentionner avant l’application. Warn 2 n’est proposé que si Warn 1 est encore actif. La mise à pied n’est proposée que si Warn 1 et Warn 2 sont actifs. Pendant une mise à pied, les deux rôles d’avertissement sont conservés ; à son expiration, les trois rôles sont retirés. Chaque sanction et chaque échéance sont sauvegardées dans `absences.json` et réconciliées au démarrage puis toutes les 30 secondes.

## Salons d’absence dans `config.json`

- `absenceBoardChannelId` : panneau actualisé chaque minute avec les absences **acceptées et en cours**. Les demandes futures et les absences terminées n’y figurent pas.
- `absenceRequestChannelId` : panneau avec bouton ouvrant le formulaire de demande.
- `absenceReviewChannelId` : demandes avec boutons Accepter/Refuser. Le refus ouvre un formulaire de motif ; le bot envoie ce motif en MP à la personne ayant fait la demande.
- `timezone` : fuseau des heures entrées et affichées, par défaut `Europe/Paris`.

Entrer les dates au format `JJ/MM/AAAA HH:MM`, par exemple `05/11/2026 14:30`. Le bot vérifie le format, la validité des dates et que le retour suit le départ. La date de départ peut être dans le passé (par exemple, pour déclarer une absence déjà commencée). Les horaires inexistants lors du changement d’heure sont refusés.

## Stockage et panneaux

Les absences, sanctions, échéances et IDs des messages de panneau (dont le panneau de sanctions) sont stockés dans `absences.json` à côté du bot (créé automatiquement, ignoré par Git). Le tableau des absences utilise cet ID et édite le message chaque minute. Si le message a été supprimé ou n’est plus accessible, le bot en crée un nouveau et sauvegarde son ID. Les panneaux de demande et de sanctions sont également vérifiés chaque minute et recréés si leur message manque. Les demandes en attente et les échéances de sanctions sont conservées au redémarrage.

Configure les permissions Discord des salons pour contrôler l’accès : les personnes pouvant voir le salon des demandes peuvent soumettre une demande ; celles pouvant voir le salon de validation peuvent traiter les boutons. Une personne doit autoriser les messages privés du bot pour recevoir le motif d’un refus.

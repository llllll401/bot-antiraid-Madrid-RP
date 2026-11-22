# Gestion des absences Discord

Bot pour un seul serveur Discord : gestion des demandes d’absence et des sanctions Warn 1, Warn 2 et mise à pied de trois jours. Les permissions d’accès aux salons définissent qui peut demander une absence ou créer une sanction ; aucun rôle spécial d’autorisation n’est codé en dur.

## Installation rapide

1. Utiliser Node.js 18 ou plus récent, puis lancer `npm ci`.
2. Compléter `config.json` : token du bot, ID du serveur, IDs des cinq salons et IDs des trois rôles de sanction.
3. Inviter le bot avec le scope `bot` et les permissions nécessaires pour voir les salons, envoyer des messages, intégrer des liens, gérer les rôles de sanction et mentionner les rôles choisis (permission `Mention Everyone` si les rôles ne sont pas eux-mêmes mentionnables). Son rôle doit être au-dessus des trois rôles de sanction. Active **Server Members Intent** dans le Developer Portal pour vérifier les membres et synchroniser les rôles.
4. Lancer `npm start`.

Au démarrage, le bot enregistre ou met à jour uniquement la commande slash `/sanctions-auto-role` sur le serveur configuré sans supprimer les autres commandes slash, puis poste/récupère les panneaux et restaure les demandes en attente. Il n’utilise plus l’antiraid ni la whitelist.

## Salons et sanctions dans `config.json`

- `sanctionPanelChannelId` : salon du panneau persistant « Créer une sanction ».
- `sanctionLogChannelId` : journal des sanctions et de leurs expirations. Les rôles choisis dans le sélecteur sont réellement mentionnés/pingés à la création.
- `sanctionRoles.warn1`, `sanctionRoles.warn2`, `sanctionRoles.suspension3Days` : IDs des trois rôles de sanction.
- `sanctionDurationsDays` : durées configurables ; par défaut Warn 1 = 7 jours, Warn 2 = 7 jours après l’expiration du Warn 1 lié (son rôle est ajouté dès l’application), et mise à pied = 3 jours.

Le panneau propose **Mise à pied 3 jours** pour lancer directement le parcours de mise à pied (sélection du membre, vérification des Warn 1 et 2 actifs, motif, mentions et application), ainsi que **Enlever une sanction** : le staff sélectionne un membre puis un niveau actif. Le niveau choisi est retiré et les sanctions supérieures descendent d’un rang (Warn 2 devient Warn 1 ; la mise à pied devient Warn 2), en conservant leur motif et leur échéance. Retirer la mise à pied ne retire qu’elle. Les retraits sont persistés et journalisés avec le membre du staff. Pour créer une sanction, le bouton ouvre un parcours éphémère : le staff sélectionne le membre, puis le niveau applicable (Warn 1, Warn 2 ou mise à pied) est déterminé automatiquement d’après les sanctions actives enregistrées et affiché avant de continuer. Si une mise à pied est déjà enregistrée comme active, le parcours indique sa date de fin, même si son rôle est absent. Le bouton Continuer ouvre le modal du motif ; ensuite, un sélecteur permet de choisir jusqu’à cinq rôles à mentionner avant l’application. Warn 2 n’est proposé que si Warn 1 est encore actif. La mise à pied n’est proposée que si Warn 1 et Warn 2 sont actifs. Pendant une mise à pied, les deux rôles d’avertissement sont conservés ; à son expiration, les trois rôles sont retirés. Chaque sanction et chaque échéance sont sauvegardées dans `absences.json` et réconciliées au démarrage puis toutes les 30 secondes. À l’expiration du Warn 1, le Warn 2 devient Warn 1 avec son motif et le compte à rebours restant ; un message est publié dans le journal. À l’expiration d’une mise à pied de trois jours, tous les avertissements et rôles associés sont réinitialisés, avec journalisation. Les rôles sont synchronisés automatiquement à chaque échéance. La commande `/sanctions-auto-role actif:<oui/non>`, réservée à l’utilisateur `1239641924407660604`, permet d’activer ou désactiver la remise automatique des rôles manquants ; un rôle constaté absent pendant la désactivation ne sera pas remis même après réactivation. Les sanctions expirées sont supprimées de la base après synchronisation des rôles et journalisation ; les absences refusées sont supprimées lors de la prochaine actualisation du tableau, et les absences acceptées après leur date de retour.

## Salons d’absence dans `config.json`

- `absenceBoardChannelId` : panneau actualisé chaque minute avec les absences **acceptées et en cours**. Les demandes futures et les absences terminées n’y figurent pas.
- `absenceRequestChannelId` : panneau avec boutons pour créer une demande et retirer ses propres demandes en attente ou absences acceptées à venir/en cours. La suppression ouvre une liste privée limitée aux absences de la personne connectée.
- `absenceReviewChannelId` : demandes avec boutons Accepter/Refuser. Le refus ouvre un formulaire de motif ; le bot envoie ce motif en MP à la personne ayant fait la demande.
- `timezone` : fuseau des heures entrées et affichées, par défaut `Europe/Paris`.

Entrer les dates au format `JJ/MM/AAAA HH:MM`, par exemple `05/11/2026 14:30`. Le bot vérifie le format, la validité des dates et que le retour suit le départ. La date de départ peut être dans le passé (par exemple, pour déclarer une absence déjà commencée). Les horaires inexistants lors du changement d’heure sont refusés.

## Stockage et panneaux

Les absences, sanctions, échéances et IDs des messages de panneau (dont le panneau de sanctions) sont stockés dans `absences.json` à côté du bot (créé automatiquement, ignoré par Git). Le tableau des absences utilise cet ID et édite le message chaque minute. Si le message a été supprimé ou n’est plus accessible, le bot en crée un nouveau et sauvegarde son ID. Les panneaux de demande et de sanctions sont également vérifiés chaque minute et recréés si leur message manque. Les demandes en attente, annulations, historique des décisions et échéances de sanctions sont conservés au redémarrage.

Configure les permissions Discord des salons pour contrôler l’accès : les personnes pouvant voir le salon des demandes peuvent soumettre une demande ; celles pouvant voir le salon de validation peuvent traiter les boutons. Une personne doit autoriser les messages privés du bot pour recevoir le motif d’un refus.

# Gestion des absences Discord

Bot pour un seul serveur Discord : panneau de demandes avec formulaire, validation/refus via le salon réservé, et panneau public des absences actuellement en cours. Les permissions d’accès aux trois salons définissent qui peut demander et traiter une absence : le bot n’impose aucun rôle spécial.

## Installation rapide

1. Utiliser Node.js 18 ou plus récent, puis lancer `npm ci`.
2. Compléter `config.json` : token du bot, ID du serveur et IDs des trois salons.
3. Inviter le bot avec le scope `bot` et les permissions nécessaires pour voir et envoyer des messages, intégrer des liens, gérer ses propres messages et envoyer des messages privés. Il doit pouvoir accéder aux trois salons. Aucun intent privilégié n’est nécessaire.
4. Lancer `npm start`.

Au démarrage, le bot supprime les anciennes commandes slash enregistrées pour son application (globales et propres au serveur), puis poste/récupère les panneaux et restaure les demandes en attente. Il n’utilise plus l’antiraid ni la whitelist.

## Salons dans `config.json`

- `absenceBoardChannelId` : panneau actualisé chaque minute avec les absences **acceptées et en cours**. Les demandes futures et les absences terminées n’y figurent pas.
- `absenceRequestChannelId` : panneau avec bouton ouvrant le formulaire de demande.
- `absenceReviewChannelId` : demandes avec boutons Accepter/Refuser. Le refus ouvre un formulaire de motif ; le bot envoie ce motif en MP à la personne ayant fait la demande.
- `timezone` : fuseau des heures entrées et affichées, par défaut `Europe/Paris`.

Entrer les dates au format `JJ/MM/AAAA HH:MM`, par exemple `05/11/2026 14:30`. Le bot vérifie le format, la validité des dates et que le retour suit le départ. La date de départ peut être dans le passé (par exemple, pour déclarer une absence déjà commencée). Les horaires inexistants lors du changement d’heure sont refusés.

## Stockage et panneaux

Les absences, leur statut, ainsi que les IDs des messages de panneau sont stockés dans `absences.json` à côté du bot (créé automatiquement, ignoré par Git). Le tableau des absences utilise cet ID et édite le message chaque minute. Si le message a été supprimé ou n’est plus accessible, le bot en crée un nouveau et sauvegarde son ID. Le panneau de demande est récupéré/recréé de la même manière. Les demandes en attente sont conservées au redémarrage.

Configure les permissions Discord des salons pour contrôler l’accès : les personnes pouvant voir le salon des demandes peuvent soumettre une demande ; celles pouvant voir le salon de validation peuvent traiter les boutons. Une personne doit autoriser les messages privés du bot pour recevoir le motif d’un refus.

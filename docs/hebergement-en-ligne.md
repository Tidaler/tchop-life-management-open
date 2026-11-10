# Serveur en ligne TidalEx Resto

Référence des commandes du serveur en ligne : une base de pilotage, et **une base neuve et séparée pour chaque établissement**. Le plan d'ensemble est dans [TidalEx Resto en ligne](architecture/06-plan-en-ligne.md). Cette page couvre l'étape 1 : la plateforme et la création des établissements. Les établissements continuent pour l'instant de fonctionner avec leur serveur local ; la synchronisation viendra aux étapes suivantes.

## Ce qu'il faut avant de commencer

| Élément | Détail |
|---|---|
| Serveur | Un serveur virtuel (VPS) sous **Ubuntu 24.04**, 2 processeurs, 4 Go de mémoire, 80 Go de disque pour démarrer |
| Nom de domaine | Par exemple `app.tidalex.cm`, avec un enregistrement **A** qui pointe sur l'adresse du serveur |
| Accès GitHub | Pouvoir ajouter une clé de déploiement au dépôt `Tidaler/tchop-life-management` |

## 1. Installer le serveur

Sur le serveur, en administrateur, depuis une copie du dossier `infra/cloud` du dépôt :

```bash
sudo bash installer-serveur.sh app.tidalex.cm v1.1.0
```

Le script installe Node.js, pnpm, PostgreSQL 17 et Caddy, ouvre seulement les ports 22, 80 et 443, crée la base de pilotage et génère les secrets dans `/etc/tidalex/cloud.env` (jamais affichés). Il affiche une clé publique à ajouter dans GitHub (**Settings > Deploy keys**, lecture seule), puis télécharge, compile et démarre l'application. Le certificat HTTPS est obtenu tout seul.

À la fin, `https://app.tidalex.cm/api/health` doit répondre.

## 2. Créer un établissement

```bash
sudo /opt/tidalex/app/infra/cloud/tidalex.sh cloud:new-establishment --code baobab --name "Restaurant Le Baobab" --owner-name "Nom du propriétaire"
```

- `--code` : court, en minuscules sans accent (lettres, chiffres, tirets). Il donne le nom de la base : `etab_baobab`.
- Le mot de passe du propriétaire est demandé au clavier (12 caractères au moins, lettres et chiffres).
- La commande crée la base vide, ses tables, l'établissement avec son plan de départ (T1 à T11, deux salons VIP), le compte `proprietaire`, puis affiche un **code d'activation** à usage unique. Il servira à relier le relais local de l'établissement (étape 6 du plan) ; le noter, il ne s'affiche qu'une fois.
- En cas d'échec, la base créée est supprimée : rien ne reste à moitié fait.

Liste des établissements :

```bash
sudo /opt/tidalex/app/infra/cloud/tidalex.sh cloud:establishments
```

## Exploitation

| Action | Commande |
|---|---|
| État de l'API | `systemctl status tidalex-cloud` et `journalctl -u tidalex-cloud -n 100` |
| Sauvegarde immédiate | `sudo /opt/tidalex/app/infra/cloud/sauvegarde.sh` (une copie par base, dans `/var/backups/tidalex`) |
| Restaurer un établissement | `sudo -u postgres pg_restore --clean --if-exists -d etab_baobab /var/backups/tidalex/etab_baobab-AAAA-MM-JJ_HHMM.dump` |
| Mise à jour | `sudo /opt/tidalex/app/infra/cloud/mise-a-jour.sh v1.1.1` (les tables sont mises à jour dans **chaque** base) |

Sauvegardes : chaque jour à 2 h UTC, une copie par base, gardées 30 jours. Copier régulièrement `/var/backups/tidalex` hors du serveur.

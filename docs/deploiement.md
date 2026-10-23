# Installation sur le serveur local

Référence des commandes pour installer TCHOP LIFE MANAGEMENT sur le serveur de l'établissement (Ubuntu Desktop 24.04 LTS : le serveur sert aussi de poste de caisse). Le guide détaillé, pas à pas, est remis à part au format Word.

## Ce qu'on obtient

| Élément | Adresse | Rôle |
|---|---|---|
| Routeur | `ROUTEUR` (ex. 192.168.0.1) | Réseau local et Wi-Fi du personnel |
| Serveur local | `SERVER_IP` (ex. 192.168.0.10, fixe) | Base de données, API, application |
| Caisse (sur le serveur) | `https://localhost` | Fonctionne même si le routeur ou le Wi-Fi tombe en panne |
| Application du personnel | `https://SERVER_IP` | Tablettes, cuisine, gestion (PWA installable) |
| Menu client | `https://SERVER_IP:8443` | Menu QR (réservé au relais cloud pour les téléphones des clients) |
| Certificat local | `http://SERVER_IP/tchop-ca.crt` | À installer une fois sur chaque tablette |
| Imprimante | réseau (ex. 192.168.0.20) port 9100, ou USB sur la caisse (`127.0.0.1:9100`, service `tchop-usb-printer`) | Tickets et reçus (ESC/POS). **Une ligne active par rôle** dans Imprimantes : Caisse (reçus, rapport Z), Cuisine, Grill, Bar |

**Choisir les adresses d'après le routeur** : `SERVER_IP` reprend les trois premiers nombres de l'adresse du routeur (écrite sous le routeur, ou « passerelle » dans les réglages Wi-Fi d'un téléphone), suivis de `.10`.

## 1. Système et adresse fixe

Ubuntu Desktop 24.04, compte administrateur `tchop-admin`, câble réseau sur une prise LAN du routeur. Adresse fixe : Paramètres, Réseau, Filaire, IPv4 **Manuel** : `SERVER_IP`, masque `255.255.255.0`, passerelle `ROUTEUR`, DNS `ROUTEUR, 8.8.8.8`.

```bash
hostname -I                      # doit afficher SERVER_IP
ping -c 3 ROUTEUR                # 3 réponses
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone Africa/Douala
sudo apt install -y git curl ca-certificates gnupg ufw unattended-upgrades openssh-server
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
sudo ufw allow 80,443,8443/tcp
sudo ufw enable
sudo ufw status                  # État : actif, avec 80,443,8443/tcp
```

## 2. Outils

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm@12.11.2
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
node -v && pnpm -v && psql --version && caddy version
```

## 3. Base de données

```bash
DB_PASSWORD=$(openssl rand -hex 24)
echo "$DB_PASSWORD"   # à garder pour l'étape 5
sudo -u postgres psql -c "CREATE ROLE tchop LOGIN PASSWORD '$DB_PASSWORD';"
sudo -u postgres createdb -O tchop tchop
```

## 4. Application

```bash
sudo useradd --system --create-home --home-dir /opt/tchop --shell /bin/bash tchop
# Ubuntu 24.04 crée ce dossier en 750 : Caddy ne pourrait pas lire l'application ni le certificat.
# 711 : traversable, mais son contenu ne peut pas être listé (les secrets sont dans /etc/tchop).
sudo chmod 711 /opt/tchop
sudo mkdir -p /var/lib/tchop/media /etc/tchop /opt/tchop/public /var/backups/tchop
sudo chmod 755 /etc/tchop
sudo chown -R tchop:tchop /var/lib/tchop
# Clé de déploiement (lecture seule) : ajouter la clé publique dans GitHub > Settings > Deploy keys.
sudo -u tchop mkdir -m 700 -p /opt/tchop/.ssh
sudo -u tchop ssh-keygen -t ed25519 -N '' -f /opt/tchop/.ssh/id_ed25519
sudo cat /opt/tchop/.ssh/id_ed25519.pub
sudo -u tchop git clone git@github.com:Tidaler/tchop-life-management.git /opt/tchop/app
cd /opt/tchop/app
sudo -u tchop git fetch --tags        # indispensable si le dépôt a été cloné avant la publication de la version
sudo -u tchop git checkout v1.0.7
sudo -u tchop pnpm install --frozen-lockfile
sudo -u tchop pnpm build
```

## 5. Configuration

```bash
sudo cp /opt/tchop/app/infra/site/tchop.env.example /etc/tchop/tchop.env
sudo chown root:tchop /etc/tchop/tchop.env && sudo chmod 640 /etc/tchop/tchop.env
openssl rand -hex 48   # valeur de JWT_SECRET (hexadécimal : jamais refusé au démarrage)
sudo nano /etc/tchop/tchop.env   # DATABASE_URL (mot de passe de l'étape 3) et JWT_SECRET
cd /opt/tchop/app && sudo -u tchop bash -c 'set -a && source /etc/tchop/tchop.env && set +a && pnpm --filter @tchop/db exec prisma migrate deploy'
sudo /opt/tchop/app/infra/site/tchop.sh site:setup --name "TCHOP LIFE"   # recopier SITE_ID ; crée aussi T1 à T11 et 2 salons VIP
sudo /opt/tchop/app/infra/site/tchop.sh catalog:import   # boissons (avec photos des bouteilles) et menu
sudo /opt/tchop/app/infra/site/tchop.sh user:add --username proprietaire --name "Nom du propriétaire" --role owner
```

`PUBLIC_MENU_URL` est rempli par `set-ip.sh` (étape 6). Rôles de `user:add` : owner, manager, cashier, waiter, kitchen, storekeeper, accountant. Le mot de passe (propriétaire, gérant, comptable) et le PIN (gérant, personnel) sont demandés au clavier, jamais en argument. `--reset` change les accès d'un compte et ferme ses sessions.

**Ne jamais lancer le seed de démonstration (`pnpm db:seed`, `pnpm db:reset`) sur le serveur** : ses comptes ont des mots de passe publics.

## 6. Services, adresse et caisse

```bash
sudo cp /opt/tchop/app/infra/site/tchop-api.service /opt/tchop/app/infra/site/tchop-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tchop-api tchop-backup.timer
# Caddyfile, configuration et certificat avec l'adresse du serveur, en une commande :
sudo /opt/tchop/app/infra/site/set-ip.sh SERVER_IP
# Poste de caisse sur le serveur (ajouter --usb-printer si l'imprimante de caisse est en USB) :
sudo /opt/tchop/app/infra/site/setup-caisse.sh
sudo systemctl reboot -i
```

Après le redémarrage, la session caisse s'ouvre seule et l'application s'affiche en plein écran sur `https://localhost`. Enregistrer la caisse : le gérant crée un code (fenêtre privée **Ctrl+Maj+N**, `https://localhost/login/password`, menu Appareils), type **Ordinateur**.

## 7. Contrôle complet

```bash
sudo /opt/tchop/app/infra/site/check.sh
```

Chaque ligne dit `OK` ou ce qu'il faut faire. À relancer après chaque correction, après une mise à jour, ou dès qu'une tablette ne fonctionne plus.

## 8. Tablettes

1. Chrome **111 ou plus récent** (Play Store : mettre à jour Chrome et Android System WebView).
2. Wi-Fi du personnel, sur le routeur du serveur (jamais le Wi-Fi invités). Adresse de la tablette dans la même plage que `SERVER_IP`.
3. Ouvrir `http://SERVER_IP/tchop-ca.crt`, installer le certificat (nom : `TCHOP LIFE`). Android : Paramètres, « Certificat CA » ; iPad : profil, puis Réglages > Général > Informations > Réglages des certificats.
4. Ouvrir `https://SERVER_IP`, menu, « Installer l'application ».
5. Le gérant crée un code dans « Appareils » ; la tablette l'utilise pour s'enregistrer ; connexion par PIN ensuite.

## Exploitation

| Action | Commande |
|---|---|
| Contrôle complet | `sudo /opt/tchop/app/infra/site/check.sh` |
| État de l'API | `systemctl status tchop-api` et `journalctl -u tchop-api -n 100` |
| Changement de routeur ou d'adresse | Nouvelle adresse fixe (Paramètres, Réseau), puis `sudo /opt/tchop/app/infra/site/set-ip.sh NOUVELLE_ADRESSE` |
| Sauvegarde immédiate | `sudo /opt/tchop/app/infra/site/backup.sh` |
| Restauration | `sudo -u postgres pg_restore --clean --if-exists -d tchop /var/backups/tchop/tchop-AAAA-MM-JJ_HHMM.dump` puis redémarrer `tchop-api` |
| Mise à jour | `sudo /opt/tchop/app/infra/site/update.sh v1.1.0` |
| Nouveau compte | `sudo /opt/tchop/app/infra/site/tchop.sh user:add …` |
| Menu des clients sans connexion | Application, Plan de salle, **Menu sans connexion**, Imprimer (à refaire après un changement de prix) |

Sauvegardes : chaque jour à 7 h dans `/var/backups/tchop` (30 jours), copiées sur le disque USB monté sur `/mnt/sauvegarde` (90 jours).

### Passer un serveur existant en v1.0.7

Depuis un serveur en **v1.0.5**, une seule commande :

```bash
sudo /opt/tchop/app/infra/site/update.sh v1.0.7
```

Depuis un serveur en **v1.0.4** (l'ancien script ne se relance pas sur la nouvelle version), une fois :

```bash
cd /opt/tchop/app && sudo -u tchop git fetch --tags && sudo -u tchop git checkout v1.0.7
sudo /opt/tchop/app/infra/site/update.sh v1.0.7
sudo /opt/tchop/app/infra/site/setup-caisse.sh --usb-printer   # sans --usb-printer si l'imprimante est en réseau
```

La caisse passe sur `https://localhost` : l'enregistrer de nouveau une fois (code du gérant, type Ordinateur).

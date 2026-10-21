# Installation sur le serveur local

Référence des commandes pour installer TCHOP LIFE MANAGEMENT sur le serveur de l'établissement (Ubuntu 24.04 LTS : Desktop si le serveur sert aussi de poste de caisse, sinon Server). Le guide détaillé, pas à pas, est remis à part au format Word.

## Ce qu'on obtient

| Élément | Adresse | Rôle |
|---|---|---|
| Serveur local | `SERVER_IP` (ex. 192.168.1.10, fixe) | Base de données, API, application |
| Application du personnel | `https://SERVER_IP` | Tablettes, caisse, cuisine, gestion (PWA installable) |
| Menu client | `https://SERVER_IP:8443` | Menu QR (réservé au relais cloud pour les téléphones des clients) |
| Certificat local | `http://SERVER_IP/tchop-ca.crt` | À installer une fois sur chaque tablette |
| Imprimante | IP fixe, port 9100 | Tickets et reçus (ESC/POS) |

HTTPS est obligatoire (application installable, sessions sécurisées). Sans Internet, Caddy émet lui-même les certificats ; chaque tablette fait confiance à cette autorité locale après installation de son certificat.

## 1. Système

```bash
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone Africa/Douala
sudo apt install -y git curl ca-certificates gnupg ufw unattended-upgrades
sudo ufw allow from 192.168.0.0/16 to any port 22 proto tcp
sudo ufw allow 80,443,8443/tcp
sudo ufw enable
```

## 2. Outils

```bash
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm@12.11.2

# PostgreSQL 17
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 3. Base de données

```bash
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
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
sudo chown -R tchop:tchop /var/lib/tchop
# Clé de déploiement (lecture seule) : ajouter la clé publique dans GitHub > Settings > Deploy keys.
sudo -u tchop mkdir -m 700 -p /opt/tchop/.ssh
sudo -u tchop ssh-keygen -t ed25519 -N '' -f /opt/tchop/.ssh/id_ed25519
sudo cat /opt/tchop/.ssh/id_ed25519.pub
sudo -u tchop git clone git@github.com:Tidaler/tchop-life-management.git /opt/tchop/app
cd /opt/tchop/app && sudo -u tchop git checkout v1.0.2
sudo -u tchop pnpm install --frozen-lockfile
sudo -u tchop pnpm build
```

## 5. Configuration

```bash
sudo cp /opt/tchop/app/infra/site/tchop.env.example /etc/tchop/tchop.env
sudo chown root:tchop /etc/tchop/tchop.env && sudo chmod 640 /etc/tchop/tchop.env
openssl rand -hex 48   # valeur de JWT_SECRET (hexadécimal : jamais refusé au démarrage)
sudo nano /etc/tchop/tchop.env   # DATABASE_URL, JWT_SECRET, SERVER_IP
cd /opt/tchop/app && sudo -u tchop bash -c 'set -a; source /etc/tchop/tchop.env; set +a; pnpm --filter @tchop/db exec prisma migrate deploy'
sudo /opt/tchop/app/infra/site/tchop.sh site:setup --name "TCHOP LIFE"   # recopier SITE_ID dans tchop.env
sudo /opt/tchop/app/infra/site/tchop.sh catalog:import
sudo /opt/tchop/app/infra/site/tchop.sh user:add --username proprietaire --name "Nom du propriétaire" --role owner
```

Rôles de `user:add` : owner, manager, cashier, waiter, kitchen, storekeeper, accountant. Le mot de passe (propriétaire, gérant, comptable) et le PIN (gérant, personnel) sont demandés au clavier, jamais en argument. `--reset` change les accès d'un compte et ferme ses sessions.

**Ne jamais lancer le seed de démonstration (`pnpm db:seed`, `pnpm db:reset`) sur le serveur** : ses comptes ont des mots de passe publics.

## 6. Services

```bash
sudo cp /opt/tchop/app/infra/site/tchop-api.service /opt/tchop/app/infra/site/tchop-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tchop-api tchop-backup.timer
sudo cp /opt/tchop/app/infra/site/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/SERVER_IP/192.168.1.10/g' /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo cp /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt /opt/tchop/public/tchop-ca.crt
sudo chmod 644 /opt/tchop/public/tchop-ca.crt
curl -fsS http://127.0.0.1:3000/api/health
```

## 7. Tablettes

1. Wi-Fi du personnel (jamais celui des clients).
2. Ouvrir `http://SERVER_IP/tchop-ca.crt`, installer le certificat (Android : « Certificat CA » ; iPad : profil, puis Réglages > Général > Informations > Réglages des certificats).
3. Ouvrir `https://SERVER_IP` dans Chrome (Safari sur iPad), « Installer l'application ».
4. Le gérant crée un code dans « Appareils » ; la tablette l'utilise pour s'enregistrer ; connexion par PIN ensuite.

## 8. Poste de caisse sur le serveur (facultatif)

Le serveur peut servir de poste de caisse (Ubuntu Desktop, écran, clavier, souris). **Il ne s'éteint jamais** : en fin de journée, on clôture la caisse et on clique sur « Verrouiller ».

```bash
# Ni veille ni hibernation ; le bouton d'alimentation ne fait rien (effet au prochain démarrage)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]
HandlePowerKey=ignore
' | sudo tee /etc/systemd/logind.conf.d/tchop.conf
# Google Chrome et l'outil de certificats
wget -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y /tmp/chrome.deb libnss3-tools
# Session « caisse » sans droits d'administration (jamais dans le groupe sudo)
sudo adduser --comment "Caisse" caisse
# La session caisse ne peut ni éteindre, ni redémarrer, ni mettre en veille le serveur
sudo cp /opt/tchop/app/infra/site/50-tchop-caisse.rules /etc/polkit-1/rules.d/
```

Ensuite : connexion automatique de « caisse » (Paramètres > Système > Utilisateurs), puis dans la session caisse, après avoir ouvert Chrome une fois :

```bash
wget -O ~/tchop-ca.crt http://SERVER_IP/tchop-ca.crt
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "TCHOP LIFE" -i ~/tchop-ca.crt
mkdir -p ~/.config/autostart
cp /opt/tchop/app/infra/site/tchop-caisse.desktop ~/.config/autostart/
sed -i 's/SERVER_IP/192.168.1.10/' ~/.config/autostart/tchop-caisse.desktop
```

Le poste s'enregistre comme une tablette (type « Ordinateur »). Adresse : toujours `https://SERVER_IP`, jamais `localhost`.

## Exploitation

| Action | Commande |
|---|---|
| État de l'API | `systemctl status tchop-api` et `journalctl -u tchop-api -n 100` |
| Sauvegarde immédiate | `sudo /opt/tchop/app/infra/site/backup.sh` |
| Restauration | `sudo -u postgres pg_restore --clean --if-exists -d tchop /var/backups/tchop/tchop-AAAA-MM-JJ_HHMM.dump` puis redémarrer `tchop-api` |
| Mise à jour | `sudo /opt/tchop/app/infra/site/update.sh v1.1.0` |
| Nouveau compte | `sudo /opt/tchop/app/infra/site/tchop.sh user:add …` |

Sauvegardes : chaque jour à 7 h dans `/var/backups/tchop` (30 jours), copiées sur le disque USB monté sur `/mnt/sauvegarde` (90 jours).

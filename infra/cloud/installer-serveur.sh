#!/usr/bin/env bash
# Installation du serveur en ligne TidalEx Resto sur un serveur Ubuntu 24.04 neuf (VPS), en root :
#   curl -fsSLO https://raw.githubusercontent.com/... (ou copie du dépôt), puis
#   sudo bash installer-serveur.sh app.tidalex.cm v1.1.0
# Avant : le nom de domaine doit pointer sur l'adresse du serveur (enregistrement DNS de type A).
# Les secrets (mot de passe de la base, JWT_SECRET) sont générés ici et écrits seulement dans
# /etc/tidalex/cloud.env ; ils ne sont jamais affichés ni passés en argument.
set -euo pipefail
DOMAINE=${1:?Usage : sudo bash $0 <nom de domaine> <version, ex. v1.1.0>}
VERSION=${2:?Usage : sudo bash $0 <nom de domaine> <version, ex. v1.1.0>}
DEPOT=git@github.com:Tidaler/tchop-life-management.git
APP=/opt/tidalex/app
ENV=/etc/tidalex/cloud.env

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en administrateur : sudo bash $0 $DOMAINE $VERSION" >&2
  exit 1
fi
if ! [[ $DOMAINE =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "Nom de domaine invalide : « $DOMAINE »" >&2
  exit 1
fi

echo "1/9 Système et pare-feu"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get full-upgrade -y -qq
apt-get install -y -qq git curl ca-certificates gnupg ufw unattended-upgrades debian-keyring \
  debian-archive-keyring apt-transport-https openssl
ufw allow 22/tcp > /dev/null
ufw allow 80,443/tcp > /dev/null
ufw --force enable > /dev/null

echo "2/9 Node.js, pnpm, PostgreSQL 17, Caddy"
if ! command -v node > /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - > /dev/null
  apt-get install -y -qq nodejs
fi
npm install -g --silent pnpm@12.11.2
if ! command -v psql > /dev/null; then
  apt-get install -y -qq postgresql-common
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y > /dev/null
  apt-get install -y -qq postgresql-17
fi
if ! command -v caddy > /dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "3/9 Utilisateur et dossiers"
id tidalex > /dev/null 2>&1 || useradd --system --create-home --home-dir /opt/tidalex --shell /bin/bash tidalex
chmod 711 /opt/tidalex
install -d -m 755 /etc/tidalex
install -d -o tidalex -g tidalex /var/lib/tidalex/media
install -d -m 700 /var/backups/tidalex

echo "4/9 Base de pilotage"
if [ ! -f "$ENV" ]; then
  MOT_DE_PASSE=$(openssl rand -hex 24)
  runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE tidalex LOGIN CREATEDB PASSWORD '$MOT_DE_PASSE';" \
    -c "CREATE DATABASE tidalex_pilotage OWNER tidalex;"
  sed -e "s#MOT_DE_PASSE_BASE#$MOT_DE_PASSE#" -e "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 48)#" \
    -e "s#https://DOMAINE#https://$DOMAINE#" "$(dirname "$0")/cloud.env.example" > "$ENV"
  unset MOT_DE_PASSE
  chown root:tidalex "$ENV"
  chmod 640 "$ENV"
fi

echo "5/9 Application (clé de déploiement GitHub)"
if [ ! -d "$APP/.git" ]; then
  if [ ! -f /opt/tidalex/.ssh/id_ed25519 ]; then
    sudo -u tidalex mkdir -m 700 -p /opt/tidalex/.ssh
    sudo -u tidalex ssh-keygen -q -t ed25519 -N '' -f /opt/tidalex/.ssh/id_ed25519
  fi
  echo "   Ajoutez cette clé publique dans GitHub > dépôt > Settings > Deploy keys (lecture seule) :"
  echo
  cat /opt/tidalex/.ssh/id_ed25519.pub
  echo
  read -r -p "   Appuyez sur Entrée une fois la clé ajoutée... " _
  sudo -u tidalex env GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' git clone --quiet "$DEPOT" "$APP"
fi
sudo -u tidalex bash -c "cd $APP && git fetch --tags --quiet && git checkout --quiet '$VERSION'"

echo "6/9 Compilation"
sudo -u tidalex bash -c "cd $APP && pnpm install --frozen-lockfile > /dev/null && pnpm build > /dev/null"

echo "7/9 Tables de la base de pilotage"
sudo -u tidalex bash -c "cd $APP && set -a && source $ENV && set +a && pnpm --silent --filter @tchop/db exec prisma migrate deploy > /dev/null"

echo "8/9 Services, sauvegardes et HTTPS"
cp "$APP/infra/cloud/tidalex-cloud.service" "$APP/infra/cloud/tidalex-sauvegarde."* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tidalex-cloud tidalex-sauvegarde.timer > /dev/null 2>&1
sed "s/DOMAINE/$DOMAINE/g" "$APP/infra/cloud/Caddyfile" > /etc/caddy/Caddyfile.new
caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile > /dev/null
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl restart caddy

echo "9/9 Vérification"
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "https://$DOMAINE/api/health" 2> /dev/null && break
  sleep 3
done
if curl -fsS -o /dev/null "https://$DOMAINE/api/health"; then
  echo "Serveur en ligne prêt : https://$DOMAINE"
  echo "Nouvel établissement : sudo $APP/infra/cloud/tidalex.sh cloud:new-establishment --code ... --name \"...\" --owner-name \"...\""
else
  echo "https://$DOMAINE ne répond pas encore. Vérifiez que le domaine pointe sur ce serveur, puis :" >&2
  echo "  journalctl -u caddy -n 30 ; journalctl -u tidalex-cloud -n 30" >&2
  exit 1
fi

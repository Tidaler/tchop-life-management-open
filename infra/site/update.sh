#!/usr/bin/env bash
# Mise à jour du serveur local vers une version publiée (étiquette Git), sauvegarde comprise.
#   sudo /opt/tchop/app/infra/site/update.sh v1.1.0
set -euo pipefail
VERSION=${1:?Usage : sudo $0 <version, ex. v1.1.0>}
APP=/opt/tchop/app
as_tchop() { sudo -u tchop bash -c "cd $APP && $*"; }

echo "1/6 Sauvegarde avant mise à jour"
"$APP/infra/site/backup.sh"

echo "2/6 Récupération de la version $VERSION"
as_tchop "git fetch --tags --quiet && git checkout --quiet '$VERSION'"

echo "3/6 Dépendances"
as_tchop "pnpm install --frozen-lockfile"

echo "4/6 Compilation"
as_tchop "pnpm build"

echo "5/6 Base de données"
as_tchop "set -a; source /etc/tchop/tchop.env; set +a; pnpm --filter @tchop/db exec prisma migrate deploy"

echo "6/6 Redémarrage"
systemctl restart tchop-api
systemctl reload caddy
sleep 3
curl -fsS http://127.0.0.1:3000/api/health && echo && echo "Mise à jour terminée : $VERSION"

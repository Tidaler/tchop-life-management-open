#!/usr/bin/env bash
# Mise à jour du serveur en ligne vers une version publiée (étiquette Git), sauvegarde comprise.
#   sudo /opt/tidalex/app/infra/cloud/mise-a-jour.sh v1.1.0
# Les nouvelles tables sont appliquées à la base de pilotage ET à la base de chaque établissement.
# Le script se relance sur la nouvelle version juste après le changement de version.
set -euo pipefail
APP=/opt/tidalex/app
as_tidalex() { sudo -u tidalex bash -c "cd $APP && $*"; }

main() {
  local version=${1:?Usage : sudo $0 <version, ex. v1.1.0>}
  if [ "$(id -u)" -ne 0 ]; then
    echo "À lancer en administrateur : sudo $0 $version" >&2
    exit 1
  fi

  if [ "${2:-}" != "--suite" ]; then
    echo "1/6 Sauvegarde avant mise à jour"
    "$APP/infra/cloud/sauvegarde.sh"
    echo "2/6 Récupération de la version $version"
    as_tidalex "git fetch --tags --quiet && git checkout --quiet '$version'"
    exec "$APP/infra/cloud/mise-a-jour.sh" "$version" --suite
  fi

  echo "3/6 Dépendances"
  as_tidalex "pnpm install --frozen-lockfile"
  echo "4/6 Compilation"
  as_tidalex "pnpm build"

  echo "5/6 Tables de chaque base"
  # Adresse de la base de pilotage ; les autres bases ont la même adresse, avec leur nom.
  local pilot
  pilot=$(sed -n 's/^DATABASE_URL=//p' /etc/tidalex/cloud.env | head -1)
  local bases
  bases=$(runuser -u postgres -- psql -Atc \
    "SELECT datname FROM pg_database WHERE datname = 'tidalex_pilotage' OR datname LIKE 'etab\_%' ORDER BY 1")
  for base in $bases; do
    echo "   $base"
    sudo -u tidalex env DATABASE_URL="${pilot%/*}/$base" \
      bash -c "cd $APP && pnpm --silent --filter @tchop/db exec prisma migrate deploy > /dev/null"
  done

  echo "6/6 Redémarrage"
  cp "$APP/infra/cloud/tidalex-cloud.service" "$APP/infra/cloud/tidalex-sauvegarde."* /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart tidalex-cloud
  sleep 3
  if curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
    echo "Mise à jour terminée : $(as_tidalex 'git describe --tags')"
  else
    echo "L'API ne répond pas : journalctl -u tidalex-cloud -n 50" >&2
    exit 1
  fi
}

main "$@"

#!/usr/bin/env bash
# Mise à jour du serveur local vers une version publiée (étiquette Git), sauvegarde comprise.
#   sudo /opt/tchop/app/infra/site/update.sh v1.0.5
# Le script se relance sur la nouvelle version juste après le changement de version : les étapes
# suivantes sont toujours celles de la version installée.
set -euo pipefail
APP=/opt/tchop/app
as_tchop() { sudo -u tchop bash -c "cd $APP && $*"; }

main() {
  local version=${1:?Usage : sudo $0 <version, ex. v1.0.5>}
  if [ "$(id -u)" -ne 0 ]; then
    echo "À lancer en administrateur : sudo $0 $version" >&2
    exit 1
  fi

  if [ "${2:-}" != "--suite" ]; then
    echo "1/7 Sauvegarde avant mise à jour"
    "$APP/infra/site/backup.sh"
    echo "2/7 Récupération de la version $version"
    as_tchop "git fetch --tags --quiet && git checkout --quiet '$version'"
    exec "$APP/infra/site/update.sh" "$version" --suite
  fi

  echo "3/7 Dépendances"
  as_tchop "pnpm install --frozen-lockfile"

  echo "4/7 Compilation"
  as_tchop "pnpm build"

  echo "5/7 Base de données"
  as_tchop "set -a; source /etc/tchop/tchop.env; set +a; pnpm --filter @tchop/db exec prisma migrate deploy"

  echo "6/7 Serveur web et poste de caisse"
  # Caddyfile de cette version, avec l'adresse actuelle du serveur (et la caisse locale https://localhost).
  "$APP/infra/site/set-ip.sh" > /dev/null
  if id caisse > /dev/null 2>&1; then
    install -o caisse -g caisse -m 644 "$APP/infra/site/tchop-caisse.desktop" \
      /home/caisse/.config/autostart/tchop-caisse.desktop
  fi

  echo "7/7 Redémarrage et contrôle"
  systemctl restart tchop-api
  sleep 3
  curl -fsS http://127.0.0.1:3000/api/health > /dev/null && echo "Mise à jour terminée : $version"
  "$APP/infra/site/check.sh" || true
}

# Tout le script est lu avant de commencer : le changement de version ne peut pas le modifier en cours de route.
main "$@"
exit $?

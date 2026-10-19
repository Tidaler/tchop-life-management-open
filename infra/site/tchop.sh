#!/usr/bin/env bash
# Lance une commande d'administration de l'API avec la configuration du serveur, sous l'utilisateur tchop.
# Exemples (en administrateur) :
#   sudo /opt/tchop/app/infra/site/tchop.sh site:setup --name "TCHOP LIFE"
#   sudo /opt/tchop/app/infra/site/tchop.sh user:add --username mireille --name "Mireille" --role cashier
#   sudo /opt/tchop/app/infra/site/tchop.sh catalog:import
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "Usage : sudo $0 <site:setup|user:add|catalog:import|cloud:register-site> [options]" >&2
  exit 1
fi
cd /opt/tchop/app/apps/api
exec sudo -u tchop bash -c 'set -a; source /etc/tchop/tchop.env; set +a; exec pnpm --silent run "$@"' _ "$@"

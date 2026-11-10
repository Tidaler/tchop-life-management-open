#!/usr/bin/env bash
# Lance une commande d'administration de l'API avec la configuration du serveur en ligne, sous
# l'utilisateur tidalex. Exemples (en administrateur) :
#   sudo /opt/tidalex/app/infra/cloud/tidalex.sh cloud:new-establishment --code baobab \
#     --name "Restaurant Le Baobab" --owner-name "Nom du propriétaire"
#   sudo /opt/tidalex/app/infra/cloud/tidalex.sh cloud:establishments
# Le mot de passe du propriétaire est demandé au clavier, jamais en argument.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "Usage : sudo $0 <cloud:new-establishment|cloud:establishments> [options]" >&2
  exit 1
fi
cd /opt/tidalex/app/apps/api
exec sudo -u tidalex bash -c 'set -a; source /etc/tidalex/cloud.env; set +a; exec pnpm --silent run "$@"' _ "$@"

#!/usr/bin/env bash
# Remet tout le stock à zéro (tous les magasins), par des inventaires : chaque écart est enregistré dans le
# journal du stock (qui, quand, pourquoi) et rien n'est effacé. Avec un compte gérant ou propriétaire :
#   sudo /opt/tchop/app/infra/site/stock-zero.sh gerant
# Le mot de passe est demandé au clavier, jamais en argument.
set -euo pipefail
ACCOUNT=${1:?Usage : sudo $0 <identifiant du gérant ou du propriétaire>}

if ! curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
  echo "L'application ne répond pas : sudo systemctl restart tchop-api, puis relancez." >&2
  exit 1
fi
read -r -s -p "Mot de passe de $ACCOUNT : " PASSWORD
echo
read -r -p "Remettre TOUT le stock à zéro, dans tous les magasins ? Tapez OUI pour confirmer : " ANSWER
if [ "$ANSWER" != "OUI" ]; then
  echo "Annulé : rien n'a été modifié."
  exit 1
fi
TCHOP_USER="$ACCOUNT" TCHOP_PASSWORD="$PASSWORD" node "$(dirname "$0")/stock-zero.mjs"

#!/usr/bin/env bash
# Adresse fixe du serveur : l'applique partout (serveur web, configuration, certificat), puis redémarre.
#   sudo /opt/tchop/app/infra/site/set-ip.sh 192.168.0.10   nouvelle adresse (après un changement de routeur)
#   sudo /opt/tchop/app/infra/site/set-ip.sh                 même adresse : remet le Caddyfile à jour
# La machine doit déjà avoir cette adresse (Paramètres, Réseau, IPv4 Manuel) : sinon rien n'est modifié.
set -euo pipefail
APP=/opt/tchop/app
ENV=/etc/tchop/tchop.env
CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en administrateur : sudo $0 $*" >&2
  exit 1
fi
current=$(sed -nE 's#^PUBLIC_MENU_URL=https://([0-9.]+):8443.*#\1#p' "$ENV" | head -1)
IP=${1:-$current}
if ! [[ $IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Adresse invalide : « $IP ». Exemple : sudo $0 192.168.0.10" >&2
  exit 1
fi
if ! hostname -I | tr ' ' '\n' | grep -qx "$IP"; then
  echo "La machine n'a pas l'adresse $IP (adresses actuelles : $(hostname -I))." >&2
  echo "Donnez-lui d'abord cette adresse fixe (Paramètres, Réseau, IPv4 Manuel), puis relancez." >&2
  exit 1
fi

echo "1/4 Serveur web (Caddy) : https://$IP, https://localhost et le menu client"
sed "s/SERVER_IP/$IP/g" "$APP/infra/site/Caddyfile" > /etc/caddy/Caddyfile.new
caddy adapt --config /etc/caddy/Caddyfile.new --adapter caddyfile > /dev/null
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
systemctl restart caddy

echo "2/4 Configuration de l'application"
if grep -q '^PUBLIC_MENU_URL=' "$ENV"; then
  sed -i "s#^PUBLIC_MENU_URL=.*#PUBLIC_MENU_URL=https://$IP:8443#" "$ENV"
else
  echo "PUBLIC_MENU_URL=https://$IP:8443" >> "$ENV"
fi
systemctl restart tchop-api

echo "3/4 Certificat pour les tablettes"
for _ in $(seq 1 15); do [ -f "$CA" ] && break; sleep 1; done
mkdir -p /opt/tchop/public
cp "$CA" /opt/tchop/public/tchop-ca.crt
chmod 644 /opt/tchop/public/tchop-ca.crt

echo "4/4 Vérification"
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' "http://$IP/tchop-ca.crt" || true)
health=$(curl -fsS http://127.0.0.1:3000/api/health || true)
if [ "$code" = 200 ] && [[ $health == *'"status":"ok"'* ]]; then
  echo "Terminé. Tablettes : http://$IP/tchop-ca.crt puis https://$IP ; caisse : https://localhost"
else
  echo "Problème : certificat HTTP $code, API « $health ». Lancez $APP/infra/site/check.sh" >&2
  exit 1
fi

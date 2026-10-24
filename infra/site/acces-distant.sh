#!/usr/bin/env bash
# Accès à distance au serveur par Tailscale : un réseau privé chiffré entre le serveur et vos propres
# téléphones ou ordinateurs. Aucun nom de domaine à acheter, aucun port ouvert sur le routeur (fonctionne
# aussi derrière une box 4G), et un vrai certificat HTTPS : rien à installer sur le téléphone à part Tailscale.
#   sudo /opt/tchop/app/infra/site/acces-distant.sh            installer ou remettre en place
#   sudo /opt/tchop/app/infra/site/acces-distant.sh --arreter  couper l'accès à distance
# La connexion au compte Tailscale se fait dans le navigateur (lien affiché) : aucun secret en argument.
set -euo pipefail
# shellcheck source=infra/site/lib-tailscale.sh
. "$(dirname "$0")/lib-tailscale.sh"
SITE=/etc/caddy/acces-distant.caddy
HOST=tchop-serveur

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en administrateur : sudo $0 $*" >&2
  exit 1
fi

reload_caddy() {
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
  systemctl reload caddy
}

if [ "${1:-}" = "--arreter" ]; then
  rm -f "$SITE"
  reload_caddy
  if command -v tailscale > /dev/null; then tailscale down; fi
  echo "Accès à distance coupé. Pour le rétablir : sudo $0"
  exit 0
fi

echo "1/5 Tailscale"
if ! command -v tailscale > /dev/null; then
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$codename.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/$codename.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y -qq tailscale
fi
# Caddy (utilisateur caddy) peut demander à Tailscale le certificat HTTPS du serveur.
if ! grep -q '^TS_PERMIT_CERT_UID=caddy$' /etc/default/tailscaled 2> /dev/null; then
  sed -i '/^TS_PERMIT_CERT_UID=/d' /etc/default/tailscaled 2> /dev/null || true
  echo 'TS_PERMIT_CERT_UID=caddy' >> /etc/default/tailscaled
fi
systemctl enable --now tailscaled > /dev/null 2>&1
systemctl restart tailscaled

echo "2/5 Connexion au compte Tailscale"
if ! tailscale status > /dev/null 2>&1; then
  echo "    Ouvrez le lien affiché (sur votre téléphone ou un ordinateur) et connectez-vous à votre compte."
fi
# Pas de SSH Tailscale ni de partage de route : le serveur est seulement joignable par vos appareils.
tailscale up --reset --hostname="$HOST" --ssh=false --accept-routes=false

echo "3/5 Adresse du serveur dans le réseau privé"
NAME=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
if [[ $NAME != *.ts.net ]]; then
  echo "Nom privé indisponible (« $NAME »). Dans la console Tailscale (login.tailscale.com/admin/dns)," >&2
  echo "activez MagicDNS et « HTTPS Certificates », puis relancez : sudo $0" >&2
  exit 1
fi

echo "4/5 Certificat HTTPS et serveur web (Caddy) : https://$NAME"
# Le certificat doit être délivré avant de publier l'adresse (juste après « Enable HTTPS », il faut
# parfois patienter un peu). Sinon le navigateur afficherait « connexion non sécurisée ».
for attempt in $(seq 1 12); do
  problem=$(ts_cert_problem "$NAME") && break
  [ "$attempt" -lt 12 ] && sleep 10
done
if [ -n "${problem:-}" ]; then
  echo "$problem" >&2
  echo "Puis relancez : sudo $0" >&2
  exit 1
fi
cat > "$SITE" << EOF
# Accès à distance par Tailscale (écrit par infra/site/acces-distant.sh). Certificat fourni par Tailscale.
https://$NAME {
	tls {
		get_certificate tailscale
	}
	import personnel
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null
# Un ancien certificat local pour cette adresse (essais précédents) ne doit plus jamais être servi.
rm -rf "/var/lib/caddy/.local/share/caddy/certificates/local/$NAME"
systemctl restart caddy
# SSH d'administration aussi par le réseau privé (le pare-feu le limitait au réseau local).
if command -v ufw > /dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
  ufw allow in on tailscale0 to any port 22 proto tcp comment 'TCHOP acces distant' > /dev/null
  ufw allow in on tailscale0 to any port 443 proto tcp comment 'TCHOP acces distant' > /dev/null
fi

echo "5/5 Vérification"
# Comme un appareil distant : par l'adresse privée du serveur, avec le certificat reconnu partout.
probe() { curl -fsS -o /dev/null --resolve "$NAME:443:$(tailscale ip -4)" "https://$NAME/api/health"; }
for _ in $(seq 1 20); do
  probe 2> /dev/null && break
  sleep 2
done
if probe; then
  echo "Terminé. Sur votre téléphone ou ordinateur : application Tailscale, même compte, puis https://$NAME"
  echo "Administration : ssh tchop-admin@$HOST"
else
  echo "Le certificat est délivré mais l'application ne répond pas sur https://$NAME." >&2
  echo "Détail : journalctl -u caddy -n 30 ; puis relancez : sudo $0" >&2
  exit 1
fi

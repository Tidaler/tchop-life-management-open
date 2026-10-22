#!/usr/bin/env bash
# Vérification complète du serveur local, sans rien modifier. À lancer à la fin de l'installation,
# après une mise à jour, ou dès qu'une tablette ne fonctionne plus :
#   sudo /opt/tchop/app/infra/site/check.sh
# Chaque ligne dit OK ou ce qu'il faut faire.
set -uo pipefail
APP=/opt/tchop/app
ENV=/etc/tchop/tchop.env
CA=/opt/tchop/public/tchop-ca.crt
errors=0
ok() { printf '  OK      %s\n' "$1"; }
ko() { printf '  ERREUR  %s\n          -> %s\n' "$1" "$2"; errors=$((errors + 1)); }
info() { printf '  INFO    %s\n' "$1"; }
check() { if eval "$2" > /dev/null 2>&1; then ok "$1"; else ko "$1" "$3"; fi; }

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en administrateur : sudo $0" >&2
  exit 1
fi
IP=$(sed -nE 's#^PUBLIC_MENU_URL=https://([0-9.]+):8443.*#\1#p' "$ENV" 2> /dev/null | head -1)

echo "Version"
info "Application : $(sudo -u tchop git -C "$APP" describe --tags 2> /dev/null || echo inconnue)"

echo "Réseau"
info "Adresses de la machine : $(hostname -I)"
info "Routeur : $(ip route | awk '/^default/ {print $3; exit}')"
if [ -z "$IP" ]; then
  ko "Adresse du serveur dans $ENV" "ligne PUBLIC_MENU_URL=https://ADRESSE:8443 absente ou mal écrite : sudo $APP/infra/site/set-ip.sh ADRESSE"
else
  check "La machine a l'adresse $IP" "hostname -I | tr ' ' '\n' | grep -qx '$IP'" \
    "adresse fixe à configurer (Paramètres, Réseau, IPv4 Manuel), ou changement de routeur : sudo $APP/infra/site/set-ip.sh NOUVELLE_ADRESSE"
  check "Le routeur répond" "ping -c 1 -W 2 \$(ip route | awk '/^default/ {print \$3; exit}')" \
    "câble réseau, prise LAN du routeur, routeur allumé"
fi

echo "Services"
for s in postgresql tchop-api caddy tchop-backup.timer; do
  check "Service $s actif" "systemctl is-active --quiet $s" "sudo systemctl restart $s, puis journalctl -u $s -n 50"
done
check "Démarrage automatique de l'application" "systemctl is-enabled --quiet tchop-api" "sudo systemctl enable tchop-api"

echo "Configuration"
check "Dossier /etc/tchop lisible (755)" "[ \"\$(stat -c %a /etc/tchop)\" = 755 ]" "sudo chmod 755 /etc/tchop"
check "Fichier tchop.env protégé (640, root:tchop)" "[ \"\$(stat -c '%a %U:%G' $ENV)\" = '640 root:tchop' ]" \
  "sudo chown root:tchop $ENV && sudo chmod 640 $ENV"
check "L'utilisateur tchop lit sa configuration" "sudo -u tchop test -r $ENV" "sudo chown root:tchop $ENV && sudo chmod 640 $ENV"
check "SITE_ID renseigné" "grep -Eq '^SITE_ID=[0-9a-f-]{36}$' $ENV" "relancer tchop.sh site:setup et recopier la ligne SITE_ID=..."
check "JWT_SECRET de 48 caractères au moins" "[ \$(sed -n 's/^JWT_SECRET=//p' $ENV | tr -d '\r' | wc -c) -gt 48 ]" \
  "openssl rand -hex 48, puis coller la valeur après JWT_SECRET="
check "Aucune valeur d'exemple restante" "! grep -Eq 'MOT_DE_PASSE_BASE|SERVER_IP' $ENV" "remplacer MOT_DE_PASSE_BASE ou SERVER_IP dans $ENV"
check "Dossier /opt/tchop traversable (711)" "[ \"\$(stat -c %a /opt/tchop)\" = 711 ]" "sudo chmod 711 /opt/tchop && sudo systemctl restart caddy"

echo "Application et pages"
check "API en bonne santé" "curl -fsS http://127.0.0.1:3000/api/health | grep -q '\"db\":\"ok\"'" "journalctl -u tchop-api -n 50 (le message dit quelle ligne de $ENV corriger)"
check "Caddyfile à jour (adresse et caisse locale)" "grep -q 'https://$IP' /etc/caddy/Caddyfile && grep -q 'https://localhost' /etc/caddy/Caddyfile && ! grep -q SERVER_IP /etc/caddy/Caddyfile" \
  "sudo $APP/infra/site/set-ip.sh"
check "Certificat publié pour les tablettes" "[ -s $CA ]" "sudo $APP/infra/site/set-ip.sh"
check "Page du certificat (http://$IP/tchop-ca.crt)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://$IP/tchop-ca.crt)\" = 200 ]" "sudo $APP/infra/site/set-ip.sh"
check "Application en HTTPS (https://$IP)" "curl -fsSL --cacert $CA -o /dev/null https://$IP/" "sudo $APP/infra/site/set-ip.sh"
check "Caisse locale (https://localhost)" "curl -fsSL --cacert $CA -o /dev/null https://localhost/" "sudo $APP/infra/site/set-ip.sh"

echo "Pare-feu"
check "Pare-feu actif" "ufw status | grep -q 'Status: active\|État : actif'" "sudo ufw enable"
check "Ports 80, 443 et 8443 ouverts aux tablettes" "ufw status | grep -q '80,443,8443/tcp'" "sudo ufw allow 80,443,8443/tcp"

echo "Poste de caisse"
if id caisse > /dev/null 2>&1; then
  check "Session caisse sans droits d'administration" "! id -nG caisse | tr ' ' '\n' | grep -qx sudo" "sudo gpasswd -d caisse sudo"
  check "Ouverture automatique de la session caisse" "grep -q '^AutomaticLogin = caisse' /etc/gdm3/custom.conf" "sudo $APP/infra/site/setup-caisse.sh"
  check "Application de caisse au démarrage (https://localhost)" "grep -q 'https://localhost' /home/caisse/.config/autostart/tchop-caisse.desktop" \
    "sudo $APP/infra/site/setup-caisse.sh"
  check "Certificat installé dans la session caisse" "sudo -u caisse certutil -L -d sql:/home/caisse/.pki/nssdb | grep -q 'TCHOP LIFE'" \
    "sudo $APP/infra/site/setup-caisse.sh"
  check "Pas de mise en veille" "[ \"\$(systemctl is-enabled sleep.target 2> /dev/null)\" = masked ]" "sudo $APP/infra/site/setup-caisse.sh"
  check "La caisse ne peut pas éteindre le serveur" "[ -f /etc/polkit-1/rules.d/50-tchop-caisse.rules ]" "sudo $APP/infra/site/setup-caisse.sh"
else
  info "Pas de session caisse sur ce serveur (caisse sur une tablette ou un autre poste)."
fi
if systemctl list-unit-files p910nd.service > /dev/null 2>&1 && systemctl is-enabled --quiet p910nd 2> /dev/null; then
  check "Imprimante USB détectée" "[ -e /dev/usb/lp0 ]" "brancher et allumer l'imprimante, puis sudo systemctl restart p910nd"
  check "Passerelle d'impression USB (127.0.0.1:9100)" "ss -ltn | grep -q '127.0.0.1:9100'" "sudo systemctl restart p910nd"
fi

echo "Sauvegardes"
last=$(ls -t /var/backups/tchop/*.dump 2> /dev/null | head -1)
if [ -n "$last" ]; then
  info "Dernière sauvegarde : $(basename "$last") ($(du -h "$last" | cut -f1))"
  check "Sauvegarde de moins de 2 jours" "[ \$(find '$last' -mtime -2 | wc -l) -eq 1 ]" "sudo $APP/infra/site/backup.sh"
else
  ko "Aucune sauvegarde dans /var/backups/tchop" "sudo $APP/infra/site/backup.sh"
fi

echo
if [ "$errors" -eq 0 ]; then
  echo "Tout est en ordre."
else
  echo "$errors point(s) à corriger : suivez les flèches ci-dessus, puis relancez ce contrôle."
  exit 1
fi

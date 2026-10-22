#!/usr/bin/env bash
# Poste de caisse sur le serveur (Ubuntu Desktop), en une fois. Rejouable sans risque.
#   sudo /opt/tchop/app/infra/site/setup-caisse.sh              caisse seule (imprimante réseau)
#   sudo /opt/tchop/app/infra/site/setup-caisse.sh --usb-printer imprimante de caisse branchée en USB
# Ce que fait le script :
#   1. le serveur ne se met jamais en veille, le bouton d'alimentation ne l'éteint pas ;
#   2. Google Chrome et l'outil de certificats ;
#   3. la session « caisse », sans droits d'administration, ouverte automatiquement au démarrage ;
#   4. le certificat du serveur dans la session caisse ;
#   5. l'application ouverte en plein écran sur https://localhost (fonctionne même sans réseau) ;
#   6. avec --usb-printer : passerelle p910nd, l'imprimante USB devient 127.0.0.1 port 9100.
# Internet est nécessaire pour les installations (Chrome, paquets).
set -euo pipefail
APP=/opt/tchop/app
USER_CAISSE=caisse
HOME_CAISSE=/home/$USER_CAISSE
USB=false
[ "${1:-}" = "--usb-printer" ] && USB=true

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer en administrateur : sudo $0 $*" >&2
  exit 1
fi

echo "1/6 Toujours allumé"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target > /dev/null
mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandlePowerKey=ignore\n' > /etc/systemd/logind.conf.d/tchop.conf
cp "$APP/infra/site/50-tchop-caisse.rules" /etc/polkit-1/rules.d/50-tchop-caisse.rules

echo "2/6 Google Chrome et outil de certificats"
if ! command -v google-chrome > /dev/null; then
  wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -q /tmp/google-chrome.deb > /dev/null
  rm -f /tmp/google-chrome.deb
fi
apt-get install -y -q libnss3-tools > /dev/null

echo "3/6 Session « caisse »"
if ! id "$USER_CAISSE" > /dev/null 2>&1; then
  echo "    Choisissez le mot de passe de la session caisse (gardé par le gérant) :"
  adduser --comment "Caisse" "$USER_CAISSE"
fi
if id -nG "$USER_CAISSE" | tr ' ' '\n' | grep -qx sudo; then
  echo "    La session caisse ne doit pas être administratrice : retrait du groupe sudo."
  gpasswd -d "$USER_CAISSE" sudo > /dev/null
fi
GDM=/etc/gdm3/custom.conf
if [ -f "$GDM" ]; then
  sed -i -E "s/^#?[[:space:]]*AutomaticLoginEnable[[:space:]]*=.*/AutomaticLoginEnable = true/; s/^#?[[:space:]]*AutomaticLogin[[:space:]]*=.*/AutomaticLogin = $USER_CAISSE/" "$GDM"
  grep -q '^AutomaticLoginEnable = true' "$GDM" || sed -i "/^\[daemon\]/a AutomaticLoginEnable = true\nAutomaticLogin = $USER_CAISSE" "$GDM"
fi

echo "4/6 Certificat du serveur dans la session caisse"
NSS=$HOME_CAISSE/.pki/nssdb
sudo -u "$USER_CAISSE" mkdir -p "$NSS"
chmod 700 "$HOME_CAISSE/.pki" "$NSS"
[ -f "$NSS/cert9.db" ] || sudo -u "$USER_CAISSE" certutil -N -d "sql:$NSS" --empty-password
sudo -u "$USER_CAISSE" certutil -D -d "sql:$NSS" -n "TCHOP LIFE" > /dev/null 2>&1 || true
install -o "$USER_CAISSE" -g "$USER_CAISSE" -m 644 /opt/tchop/public/tchop-ca.crt "$HOME_CAISSE/tchop-ca.crt"
sudo -u "$USER_CAISSE" certutil -A -d "sql:$NSS" -t "C,," -n "TCHOP LIFE" -i "$HOME_CAISSE/tchop-ca.crt"

echo "5/6 Ouverture automatique en plein écran (https://localhost)"
sudo -u "$USER_CAISSE" mkdir -p "$HOME_CAISSE/.config/autostart"
install -o "$USER_CAISSE" -g "$USER_CAISSE" -m 644 "$APP/infra/site/tchop-caisse.desktop" \
  "$HOME_CAISSE/.config/autostart/tchop-caisse.desktop"

echo "6/6 Imprimante de caisse"
if $USB; then
  apt-get install -y -q p910nd > /dev/null
  cat > /etc/default/p910nd << 'EOF'
# Imprimante de caisse branchée en USB, rendue joignable par l'application sur 127.0.0.1 port 9100.
P910ND_NUM=""
P910ND_OPTS="-f /dev/usb/lp0 -i 127.0.0.1"
P910ND_START=1
EOF
  systemctl enable --now p910nd > /dev/null 2>&1 || true
  systemctl restart p910nd
  [ -e /dev/usb/lp0 ] || echo "    Attention : aucune imprimante USB détectée (/dev/usb/lp0). Branchez-la, allumez-la, puis : sudo systemctl restart p910nd"
  echo "    Dans l'application : Imprimantes, adresse 127.0.0.1, port 9100, rôle Caisse."
else
  echo "    Imprimante réseau : rien à installer ici (adresse fixe, puis menu Imprimantes)."
fi

echo
echo "Terminé. Redémarrez le serveur (sudo systemctl reboot -i) : la session caisse s'ouvre seule,"
echo "puis l'application en plein écran. Enregistrez alors la caisse (code du gérant, type Ordinateur)."

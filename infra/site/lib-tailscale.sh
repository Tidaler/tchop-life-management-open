# Fonctions partagées par acces-distant.sh et check.sh (fichier chargé avec « source », pas lancé).
# shellcheck shell=bash

# Demande le certificat HTTPS à Tailscale exactement comme Caddy le fait (utilisateur caddy).
# Rien n'est affiché s'il est délivré ; sinon la cause et ce qu'il faut faire, avec le code 1.
ts_cert_problem() {
  local name=$1 dir out
  dir=$(mktemp -d)
  chown caddy "$dir"
  if out=$(runuser -u caddy -- tailscale cert --cert-file "$dir/cert.pem" --key-file "$dir/key.pem" "$name" 2>&1); then
    rm -rf "$dir"
    return 0
  fi
  rm -rf "$dir"
  case "$out" in
    *[Dd]enied* | *"not allowed"* | *[Pp]ermission* | *403*)
      echo "Caddy n'a pas le droit de demander le certificat à Tailscale : sudo /opt/tchop/app/infra/site/acces-distant.sh"
      ;;
    *[Hh][Tt][Tt][Pp][Ss]* | *"does not support"* | *"not enabled"*)
      echo "Tailscale ne délivre pas encore le certificat : console login.tailscale.com/admin/dns, section HTTPS Certificates, bouton Enable HTTPS, puis attendre une minute"
      ;;
  esac
  echo "Réponse de Tailscale : $(printf '%s\n' "$out" | tail -1)"
  return 1
}

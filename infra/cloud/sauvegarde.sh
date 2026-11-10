#!/usr/bin/env bash
# Sauvegarde du serveur en ligne : la base de pilotage et la base de CHAQUE établissement, séparément,
# plus les fichiers. Garde 30 jours. Lancée chaque jour par tidalex-sauvegarde.timer ; à la main :
#   sudo /opt/tidalex/app/infra/cloud/sauvegarde.sh
set -euo pipefail
DEST=${TIDALEX_BACKUP_DIR:-/var/backups/tidalex}
STAMP=$(date +%Y-%m-%d_%H%M)
umask 077
mkdir -p "$DEST"

bases=$(runuser -u postgres -- psql -Atc \
  "SELECT datname FROM pg_database WHERE datname = 'tidalex_pilotage' OR datname LIKE 'etab\_%' ORDER BY 1")
count=0
for base in $bases; do
  runuser -u postgres -- pg_dump --format=custom --dbname="$base" > "$DEST/$base-$STAMP.dump"
  count=$((count + 1))
done
tar -czf "$DEST/fichiers-$STAMP.tar.gz" -C /var/lib/tidalex media

find "$DEST" -type f -mtime +30 -delete
echo "Sauvegarde terminée : $count base(s) dans $DEST"

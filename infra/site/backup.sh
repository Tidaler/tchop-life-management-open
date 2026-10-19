#!/usr/bin/env bash
# Sauvegarde du serveur local : base de données + photos et justificatifs. Garde 30 jours.
# Copie aussi sur le disque USB s'il est branché et monté sur /mnt/sauvegarde.
# Lancée chaque jour par tchop-backup.timer ; à la main : sudo /opt/tchop/app/infra/site/backup.sh
set -euo pipefail
DEST=${TCHOP_BACKUP_DIR:-/var/backups/tchop}
STAMP=$(date +%Y-%m-%d_%H%M)
umask 077
mkdir -p "$DEST"

runuser -u postgres -- pg_dump --format=custom --dbname=tchop > "$DEST/tchop-$STAMP.dump"
tar -czf "$DEST/fichiers-$STAMP.tar.gz" -C /var/lib/tchop media

if mountpoint -q /mnt/sauvegarde; then
  mkdir -p /mnt/sauvegarde/tchop
  cp "$DEST/tchop-$STAMP.dump" "$DEST/fichiers-$STAMP.tar.gz" /mnt/sauvegarde/tchop/
  find /mnt/sauvegarde/tchop -type f -mtime +90 -delete
fi

find "$DEST" -type f -mtime +30 -delete
echo "Sauvegarde terminée : $DEST/tchop-$STAMP.dump"

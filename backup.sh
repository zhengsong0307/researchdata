#!/bin/bash
# ScholarOS 每日自动备份：保留 30 天
set -e
DB=/var/lib/scholaros/scholaros.db
DIR=/var/lib/scholaros/backups
STAMP=$(date +%Y%m%d_%H%M)
sqlite3 "$DB" ".backup '$DIR/auto_$STAMP.db'"
gzip -9 "$DIR/auto_$STAMP.db"
# 简历文件每周日也备一次（平时变化少，不用天天备）
if [ "$(date +%u)" = "7" ]; then
  tar -czf "$DIR/resumes_$STAMP.tar.gz" -C /var/lib/scholaros resumes
fi
# 清理 30 天前的自动备份（手动备份不动）
find "$DIR" -name "auto_*.db.gz" -mtime +30 -delete
find "$DIR" -name "resumes_*.tar.gz" -mtime +60 -delete
echo "$(date '+%F %T') 备份完成: auto_$STAMP.db.gz"

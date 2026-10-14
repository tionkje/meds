#!/bin/sh
# Replaces the local db with a snapshot of production. Stop `pnpm start` first.
# Usage: PROD_SSH=<ssh host running the meds container> pnpm pull-prod
set -eu

: "${PROD_SSH:?set PROD_SSH to the ssh host running the meds container}"
dest=${DATABASE_PATH:-./data/meds.db}
tmp="$dest.download"

mkdir -p "$(dirname "$dest")"

# ponytail: VACUUM INTO gives a consistent snapshot of the live WAL-mode db; copying meds.db alone would miss the -wal contents.
ssh "$PROD_SSH" docker exec -i meds node --input-type=module - > "$tmp" <<'EOF'
import fs from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
const snapshot = '/tmp/meds-snapshot.db';
await fs.rm(snapshot, { force: true });
new DatabaseSync(process.env.DATABASE_PATH).exec(`VACUUM INTO '${snapshot}'`);
process.stdout.write(await fs.readFile(snapshot));
await fs.rm(snapshot);
EOF

rm -f "$dest-wal" "$dest-shm"
mv "$tmp" "$dest"
echo "copied $PROD_SSH:meds -> $dest"

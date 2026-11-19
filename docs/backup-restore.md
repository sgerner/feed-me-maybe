# Backup & Restore

Feed Me Maybe stores all data in a single SQLite database file. Backup and restore are straightforward file operations.

## Database Location

| Deployment            | Path                                              |
| --------------------- | ------------------------------------------------- |
| Local development     | `./data/feed-me-maybe.db`                         |
| Docker (named volume) | `/app/data/feed-me-maybe.db` inside the container |
| Docker (bind mount)   | The host path you specified                       |

## SQLite WAL Mode

The database runs in WAL (Write-Ahead Logging) mode, which creates two additional files alongside the main database:

- `feed-me-maybe.db` — the main database file
- `feed-me-maybe.db-wal` — the write-ahead log
- `feed-me-maybe.db-shm` — shared memory file

**Always back up all three files together**, or use the SQLite backup API to ensure consistency.

## Backup Methods

### Method 1: File Copy (Docker Named Volume)

```bash
# Stop the container to ensure the database and WAL files form a consistent snapshot.
docker stop feed-me-maybe

# Copy the mounted volume contents without adding a nested source directory.
backup_dir="$(pwd)/backups/feed-me-maybe-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker run --rm \
  -v feed-me-maybe-data:/source:ro \
  -v "$backup_dir:/backup" \
  alpine cp -a /source/. /backup/

docker start feed-me-maybe
```

### Method 2: File Copy (Bind Mount)

```bash
# Stop the container first to ensure a consistent snapshot.
docker stop feed-me-maybe
backup_dir="/path/to/backups/feed-me-maybe-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -a /path/on/host/data/. "$backup_dir/"
docker start feed-me-maybe
```

### Method 3: SQLite Online Backup (No Downtime)

Use the SQLite backup API through the app's installed `better-sqlite3` package
to perform an online backup without stopping the container. The runtime image
does not include the `sqlite3` command-line program.

```bash
# Perform the online backup inside the running container
docker exec feed-me-maybe node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/feed-me-maybe.db', { readonly: true }); await db.backup('/app/data/feed-me-maybe.backup.db'); db.close();"

# Copy the backup out of the container
docker cp feed-me-maybe:/app/data/feed-me-maybe.backup.db ./feed-me-maybe-$(date +%Y%m%d).db
```

### Method 4: Automated Cron Backup

Add a cron job to back up the database daily:

```bash
# Edit crontab
crontab -e

# Add this line (daily backup at 2 AM)
0 2 * * * docker exec feed-me-maybe node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/feed-me-maybe.db', { readonly: true }); await db.backup('/app/data/feed-me-maybe.backup.db'); db.close();" && docker cp feed-me-maybe:/app/data/feed-me-maybe.backup.db /backups/feed-me-maybe-$(date +\%Y\%m\%d).db && find /backups -name "feed-me-maybe-*.db" -mtime +30 -delete
```

This keeps 30 days of backups and removes older ones automatically.

## Restore Procedure

Stop every process using the destination database and keep it stopped until
the restore completes. Keep a separate copy of the current database and any
matching WAL file before replacing them. A WAL is part of its original
database snapshot and must never be reused with a standalone backup.

### From File Copy

```bash
# Stop the container
docker stop feed-me-maybe

# Copy the backup into the volume
docker run --rm \
  -v feed-me-maybe-data:/data \
  -v "$(pwd)/backups/feed-me-maybe-20250101:/source:ro" \
  alpine sh -ec 'test -s /source/feed-me-maybe.db
    cp /source/feed-me-maybe.db /data/feed-me-maybe.db.restore
    rm -f /data/feed-me-maybe.db-wal /data/feed-me-maybe.db-shm
    mv /data/feed-me-maybe.db.restore /data/feed-me-maybe.db
    if [ -f /source/feed-me-maybe.db-wal ]; then
      cp /source/feed-me-maybe.db-wal /data/feed-me-maybe.db-wal
    fi'

# Start the container
docker start feed-me-maybe
```

### From SQLite Backup File

```bash
# Stop the container
docker stop feed-me-maybe

# Restore using a helper container while the application stays stopped.
docker run --rm \
  -v feed-me-maybe-data:/data \
  -v "$(pwd)/feed-me-maybe-20250101.db:/backup.db:ro" \
  alpine sh -ec 'test -s /backup.db
    cp /backup.db /data/feed-me-maybe.db.restore
    rm -f /data/feed-me-maybe.db-wal /data/feed-me-maybe.db-shm
    mv /data/feed-me-maybe.db.restore /data/feed-me-maybe.db'

# Start the container
docker start feed-me-maybe
```

The database backup does not contain `APP_SECRET`. Restore the same `APP_SECRET`
used when the database was backed up so encrypted AI provider and webhook
credentials remain readable.

### From Local Development

```bash
# Stop the dev server (Ctrl+C)

# Restore from backup
cp /path/to/backup/feed-me-maybe-20250101.db ./data/feed-me-maybe.db

# Remove stale WAL/SHM files
rm -f ./data/feed-me-maybe.db-wal ./data/feed-me-maybe.db-shm

# Restart the dev server
npm run dev
```

## Verifying a Backup

After restoring, verify the database is intact:

```bash
# Check database integrity
docker exec feed-me-maybe node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/feed-me-maybe.db', { readonly: true }); console.log(db.pragma('integrity_check')); db.close();"
# Expected result: [{ integrity_check: 'ok' }]

# Check table counts
docker exec feed-me-maybe node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database('/app/data/feed-me-maybe.db', { readonly: true }); for (const table of ['feeds', 'articles', 'sessions']) console.log(table + ': ' + db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count); db.close();"
```

## Backup Best Practices

1. **Back up all three files** (`.db`, `.db-wal`, `.db-shm`) or use the SQLite `.backup` command
2. **Test restores periodically** — a backup you haven't tested is not a backup
3. **Store backups off-host** — copy to a separate machine or cloud storage
4. **Encrypt backups** — the database contains your feed URLs and reading history
5. **Keep multiple generations** — retain at least 7 days of daily backups

The poller retains 30 days of app errors, finished feed fetch logs, and
finished feed and article-enrichment jobs. Each feed keeps its latest
fetch log and latest successful fetch for diagnostics. Reader history,
active jobs, and ranking jobs are excluded from this cleanup.

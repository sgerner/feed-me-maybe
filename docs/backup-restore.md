# Backup & Restore

Feed Me Maybe stores all data in a single SQLite database file. Backup and restore are straightforward file operations.

## Database Location

| Deployment | Path |
|------------|------|
| Local development | `./data/feed-me-maybe.db` |
| Docker (named volume) | Inside the volume at `/data/feed-me-maybe.db` |
| Docker (bind mount) | The host path you specified |

## SQLite WAL Mode

The database runs in WAL (Write-Ahead Logging) mode, which creates two additional files alongside the main database:

- `feed-me-maybe.db` — the main database file
- `feed-me-maybe.db-wal` — the write-ahead log
- `feed-me-maybe.db-shm` — shared memory file

**Always back up all three files together**, or use the SQLite backup API to ensure consistency.

## Backup Methods

### Method 1: File Copy (Docker Named Volume)

```bash
# Stop the container to ensure a consistent snapshot
docker stop feed-me-maybe

# Copy the database files from the volume
docker run --rm \
  -v feed-me-maybe-data:/source:ro \
  -v $(pwd)/backups:/backup \
  alpine cp -r /source /backup/feed-me-maybe-$(date +%Y%m%d)

# Restart the container
docker start feed-me-maybe
```

### Method 2: File Copy (Bind Mount)

```bash
# Stop the container
docker stop feed-me-maybe

# Copy the database directory
cp -r /path/on/host/data /path/to/backups/feed-me-maybe-$(date +%Y%m%d)

# Restart
docker start feed-me-maybe
```

### Method 3: SQLite Online Backup (No Downtime)

Use the `sqlite3` CLI to perform an online backup without stopping the container:

```bash
# Enter the running container
docker exec -it feed-me-maybe sh

# Perform online backup
sqlite3 /data/feed-me-maybe.db ".backup '/data/feed-me-maybe.backup.db'"

# Exit the container
exit

# Copy the backup out of the container
docker cp feed-me-maybe:/data/feed-me-maybe.backup.db ./feed-me-maybe-$(date +%Y%m%d).db
```

### Method 4: Automated Cron Backup

Add a cron job to back up the database daily:

```bash
# Edit crontab
crontab -e

# Add this line (daily backup at 2 AM)
0 2 * * * docker exec feed-me-maybe sqlite3 /data/feed-me-maybe.db ".backup '/data/feed-me-maybe.backup.db'" && docker cp feed-me-maybe:/data/feed-me-maybe.backup.db /backups/feed-me-maybe-$(date +\%Y\%m\%d).db && find /backups -name "feed-me-maybe-*.db" -mtime +30 -delete
```

This keeps 30 days of backups and removes older ones automatically.

## Restore Procedure

### From File Copy

```bash
# Stop the container
docker stop feed-me-maybe

# Remove the current database (optional — overwrite instead)
docker run --rm -v feed-me-maybe-data:/data alpine rm -f /data/feed-me-maybe.db*

# Copy the backup into the volume
docker run --rm \
  -v feed-me-maybe-data:/data \
  -v $(pwd)/backups/feed-me-maybe-20250101:/source:ro \
  alpine cp -r /source/* /data/

# Start the container
docker start feed-me-maybe
```

### From SQLite Backup File

```bash
# Stop the container
docker stop feed-me-maybe

# Copy the backup file into the container
docker cp feed-me-maybe-20250101.db feed-me-maybe:/data/feed-me-maybe.db

# Remove any stale WAL/SHM files
docker exec feed-me-maybe rm -f /data/feed-me-maybe.db-wal /data/feed-me-maybe.db-shm

# Start the container
docker start feed-me-maybe
```

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
docker exec feed-me-maybe sqlite3 /data/feed-me-maybe.db "PRAGMA integrity_check;"
# Expected output: "ok"

# Check table counts
docker exec feed-me-maybe sqlite3 /data/feed-me-maybe.db \
  "SELECT 'feeds: ' || COUNT(*) FROM feeds;
   SELECT 'articles: ' || COUNT(*) FROM articles;
   SELECT 'sessions: ' || COUNT(*) FROM sessions;"
```

## Backup Best Practices

1. **Back up all three files** (`.db`, `.db-wal`, `.db-shm`) or use the SQLite `.backup` command
2. **Test restores periodically** — a backup you haven't tested is not a backup
3. **Store backups off-host** — copy to a separate machine or cloud storage
4. **Encrypt backups** — the database contains your feed URLs and reading history
5. **Keep multiple generations** — retain at least 7 days of daily backups

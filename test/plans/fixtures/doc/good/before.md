## Pruning

Every night at 03:00, cron runs `prune.sh` on each host. The script lists the snapshots in the repository, keeps the last 30 daily and 8 weekly ones, and deletes the rest.

If the upload at 02:00 is still running when cron starts, the prune waits for the repository lock and then runs anyway, even when the upload failed and the newest snapshot is incomplete.

Check the prune log in the morning.

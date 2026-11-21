## Pruning

The backup agent prunes the repository itself, right after each upload succeeds. It keeps the last 14 daily and 8 weekly snapshots, and deletes the rest.

A failed upload never triggers a prune.

Check the agent log in the morning. A line that reads `prune: kept 22, deleted 1` means the night went well.

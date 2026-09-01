# PR #11 evidence - slice 5 of #6 (docs, cron honesty, gripe resolver)

- PR head SHA: `757f7fe141ab404902192475dd64a09b7ddc5b95`
- Pre-flip capture SHA (GRIPE_SHA the live installs were staged from): `2f36b47b6452a1d2c331cf9429af206d19cd172a`
- Date: 2026-09-01. Versions: codex-cli 0.152.0, claude-code 2.1.252, node v26.7.0.
- Host skew at capture time: Claude registry gripe@jakub 0.2.0, Codex cache holds 0.2.1 and the staged 0.3.0.
- Secret sweep: clean. No credentials in any capture; `config.toml` was never dumped (only the gripe table line and the gripe registration were read).

## Live captures (authorize the role: gripe-cli flip, decision 45)

The pre-flip 0.3.0 tree was staged into `~/.codex/plugins/cache/jakub/gripe/0.3.0` by a byte-for-byte copy of `plugins/gripe/` at `2f36b47b6452a1d2c331cf9429af206d19cd172a` (an install is such a copy), verified equal to that SHA before and after the sessions (`capture-provenance.txt`). The new shim was published through the epoch ratchet; the old on-disk shim carried no marker, so the ratchet returned `written` (the flap fix in action).

- `capture-gripe-codex.txt` / `capture-gripe-codex-dump.txt` - a real Codex session (`codex exec`, danger-full-access) ran `gripe doctor`, `gripe add`, `gripe dump`. doctor reports `plugin_root` = `/home/jakub/.codex/plugins/cache/jakub/gripe/0.3.0` at `plugin_version` 0.3.0; add exits 0; the row (`slice5-live-codex-2f36b47b6452a1d2c331cf9429af206d19cd172a-20260901T174026Z`, id 118) is shown by the dump. This is the Codex-resolves-and-files proof.
- `capture-gripe-claude.txt` - a real Claude session (`claude -p --plugin-dir <worktree>/plugins/gripe`, so the session's 0.3.0 SessionStart ratchet holds the new shim) with the Claude registry still at 0.2.0. `gripe doctor` resolves the **Codex** 0.3.0 cache root: cross-harness newest-wins under skew.
- `capture-shim-flap-probe.txt` - a plain `claude -p` (no --plugin-dir) on the 0.2.0 install clobbers the shim back to the marker-less old one and its old doctor lacks the identity fields. This is why decision 40 requires re-registering both harnesses in one sitting, and why the Claude capture uses the feature plugin dir.

## Committed-surface smokes (reproduce with `node <path>` at 757f7fe141ab404902192475dd64a09b7ddc5b95)

capture-smoke-smoke-shim.txt (116), -label-contract (10, incl. 4 red fixtures), -charter-conformance (22), -bundle-drift (byte-identical), -stage-conformance (29), -seat-contract (13), -plugin-manifests, -hooks, -collision-test (20/20).

## install-cron shapes

`capture-install-cron-shapes.txt` - four shapes against throwaway HOME (fake systemctl, stub claude on the launcher's runtime PATH, env -i): claude-off -> exit 1, nothing armed; unregistered -> exit 1, nothing armed; valid -> exit 0, launcher is a regular file, 2 timers enabled, cron.env written; directory-at-launcher -> exit 1, the directory is left untouched and nothing is armed (the mv -T + fatal-rename fix).

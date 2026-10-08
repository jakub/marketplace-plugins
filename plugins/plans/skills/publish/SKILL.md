---
name: publish
description: Publish, verify, and delete artifacts (HTML plans, images, video) through the installed Plans CLI against a self-hosted Plans server, turning a file or stdin into a viewable URL with a TTL or permanent retention. Use for "artifact", "upload a plan", "publish this page", "host this", "share this screenshot", "upload the recording". Not claude.ai Artifacts.
---

# Artifacts (Plans client)

Use the installed `plans` CLI as the supported client for a self-hosted Plans server (`plansd`, from the same repository as the CLI). Treat publishing as an external write and each returned viewer URL as a sensitive read capability.

## Check prerequisites

1. Run `command -v plans` when client availability is uncertain. If it is missing, tell the user to run `go install github.com/jakub/plans/cmd/plans@latest`. Do not run it yourself. The server it talks to is `plansd`, built from the same repository.
2. Run `plans version` when version evidence matters.
3. The CLI has no default endpoint. It takes the API URL from the first of these that is set:
   - the `--api-url` flag
   - `$PLANS_API_URL`
   - the one-line file `$XDG_CONFIG_HOME/plans/api-url`, or `~/.config/plans/api-url` when `XDG_CONFIG_HOME` is unset

   With none of the three set, the CLI exits with an error naming all of them before it sends a request. When that happens, stop and tell the user to configure one. Never guess, invent, or borrow an endpoint: the CLI sends the bearer token and the artifact to whatever origin it is given.
4. The token comes from `$PLANS_TOKEN`, then `--token-file` (which defaults to `$PLANS_TOKEN_FILE`), then `$XDG_CONFIG_HOME/plans/token` or `~/.config/plans/token`. Rely on this resolution unless the user requests an override.
5. Never print, inspect, copy, or return the raw bearer token. Do not regenerate or replace it without explicit authorization.

## Choose the artifact type

Each upload is one file, and the CLI infers its media type from the extension. Anything outside this table fails before the network is touched, and the server rejects an unlisted type with `415`:

| Extension | Content type |
|---|---|
| `.html`, `.htm` | `text/html` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.webp` | `image/webp` |
| `.gif` | `image/gif` |
| `.svg` | `image/svg+xml` |
| `.mp4` | `video/mp4` |
| `.webm` | `video/webm` |

Publish an image or a video directly when the user just wants a screenshot or recording hosted. Publish HTML when the deliverable is a plan, report, or visualization. Stdin (`-`) is always treated as HTML.

## Prepare an HTML plan

Inline the plan's own code, because the viewer's CSP blocks external network access:

- Inline CSS and JavaScript; inline fonts as data URIs.
- Images, video, and audio may instead reference sibling artifacts — `img-src` and `media-src` are `'self'`, so a media element resolves against the viewer origin. Every other external request is denied.
- Do not include credentials, private keys, bearer tokens, or unnecessary sensitive data.
- Keep the file non-empty and no larger than the server's upload limit (100 MiB by default).
- Prefer a saved source file when the user may want to review or revise the artifact later.
- Verify responsive layout when the artifact is intended for phone viewing.

Inline scripts work, but the sandbox omits `allow-same-origin`, blocks outbound connections, blocks forms and embedding, and prevents the artifact from escaping its origin.

## Embedded local media

Publishing an HTML **file** auto-publishes the local media it references. The CLI scans `src` attributes on `img`, `video`, `audio`, and `source` for relative paths (`./shot.png`, `assets/clip.webm`), publishes each referenced file as its own artifact with the plan's TTL, splices the capability URLs into the document, and publishes the plan last, naming those artifacts as its bundled attachments.

Write plans that use this rather than embedding large media as base64:

- Keep referenced files in the plan's own directory. A `..` path or a symlink out of that directory is rejected — the CLI will not upload a file from elsewhere on disk.
- Use literal `src` attributes only. `srcset`, `poster`, CSS `url()`, and anything JavaScript builds pass through untouched; inline those as `data:` URIs or point them at already-published artifact URLs.
- Query strings and fragments are fine (`shot.png?v=2`), and percent-escapes are decoded when locating the file. The whole reference is replaced by the capability URL.
- Every referenced file is opened and checked before the first upload. A local reference the CLI cannot read, a path that escapes the directory, or an unsupported extension aborts the publish with nothing uploaded — a published plan is immutable, so a stale filesystem path could never be repaired. Visibly remote values (a scheme, or protocol-relative `//`) pass through.
- A `src` naming a local `.html` file is rejected; no media element renders HTML.
- Stdin input is published verbatim and never scanned. Pass a real file path whenever the plan embeds media.

Each attachment is an ordinary artifact with its own key and the plan's TTL, but the plan bundles it: they share the plan's lifetime settings, and deleting the plan deletes them. Human output lists the attachments on stderr (capability URL first, then the reference as written) while stdout stays the single plan URL. `--json` lists them under `attachments`, each entry a full artifact response plus the `path` as written in the document.

If an attachment upload, the splice, or the plan upload fails, the CLI deletes what it already published and names anything it could not delete. Run `plans delete` on those keys.

## Choose retention

Select retention from the user's intent:

- Use the default seven days when the user merely says to publish or share.
- Use `--ttl 12h`, `--ttl 7d`, or `--ttl 2w` when a lifetime is specified. Durations may use hours, whole days, or whole weeks and cannot exceed 365 days.
- Use `--keep` only when the user explicitly requests permanence or the artifact is clearly durable documentation intended to remain available.
- Never combine `--ttl` and `--keep`.

Attachments inherit the plan's retention, so `--keep` on a plan makes its media permanent too.

## Publish

Publishing is authorized when the user explicitly asks to publish, upload, host, or share through Plans. If the request only asks to create or preview HTML, prepare and validate the file but ask before publishing.

Prefer JSON output so the result can be checked precisely:

```bash
plans publish --json report.html
plans publish --ttl 2w --json report.html
plans publish --keep --json handbook.html
plans publish --json shot.png
plans publish --json recording.mp4
plans publish --json -
```

The response contains `key`, `url`, `content_type`, `created_at`, `size`, and `sha256`, plus `expires_at` unless the artifact was published with `--keep`, plus an `attachments` array when an HTML publish carried media. Redirect the JSON to a file and parse it afterwards: a parse failure on a piped response loses the keys of artifacts that were already created. Do not expose keys separately when returning full URLs.

## Verify publication

After publishing, verify the live artifact unless the user explicitly asks for upload only:

1. Fetch the returned URL without sending the bearer token.
2. Require `200 OK` and a `Content-Type` matching the artifact: `text/html; charset=utf-8` for a plan, the verbatim allowlisted type (`image/png`, `video/mp4`, …) for media.
3. Check that `Cache-Control` includes `no-store` and that a sandboxed `Content-Security-Policy` is present.
4. When a local source file exists, compare its SHA-256 and size with the publish response or downloaded bytes. For a plan whose media was spliced, the published bytes differ from the local file by design — compare the attachments instead, and confirm the plan body contains the returned capability URLs.
5. For video, confirm `Accept-Ranges: bytes` and that a `Range` request returns `206` — seeking depends on it. A `HEAD` is enough to check headers without pulling the whole file.
6. For a visually important page, render the live page at desktop and phone dimensions when browser tooling is available, and confirm embedded media actually loads from its capability URL.

Use a temporary file for downloaded verification bytes. Do not commit capability URLs, put them in logs, or post them to broader channels. Returning the URL directly to the requesting user is expected.

## Report the result

Lead with the clickable viewer URL. Then state:

- Retention or expiration
- Source file path, if one exists
- Attachment URLs when a plan auto-published media, with the note that deleting the plan deletes them too
- Verification performed
- Any material sandbox limitation

Do not include the bearer token, its digest, or internal artifact storage paths.

## Delete an artifact

Delete only with explicit user intent because deletion is destructive:

```bash
plans delete --json <key-or-full-viewer-url>
```

The client accepts either the capability key or the full viewer URL. Deleting a plan deletes the plan and then every attachment it bundled, so one key in can be several keys out:

- Human output is one `deleted <key>` line per removed key, plan first.
- `--json` prints `{"deleted":["<plan-key>","<attachment-key>", ...]}`.
- Deleting an attachment directly is allowed and leaves its plan in place, with that media broken.
- A partial failure still prints what was deleted, in either format, then exits `1`. The server reports it in one of two forms:
  - The cascade started but did not finish. `--json` adds `"failed":[...]` and `"error"`, and stderr ends with `still present, delete each directly: <keys>`. Run `plans delete` on each of those keys.
  - The plan's metadata could not be read. The plan is deleted, but its attachments were never attempted, and their keys are unknown to the server. `--json` has `"error"` and no `"failed"`. Delete the attachment keys you already know from the original publish result. If you have none, tell the user that attachment cleanup is unresolved. Do not guess keys.

The plan's metadata was the only server-side record of its attachments, so keep the publish result and the delete output until cleanup is confirmed.

Verify a subsequent viewer request returns `404` when confirmation matters.

## Handle failures

API errors print as `plans: plans API returned HTTP <code>: <message>`.

- `plans: command not found`: report the missing client and give the user the install command (`go install github.com/jakub/plans/cmd/plans@latest`); check whether Go's bin directory (`$(go env GOPATH)/bin`) is on `PATH` first. Do not install it yourself.
- `no plans API URL configured`: stop and tell the user to pass `--api-url`, set `PLANS_API_URL`, or write the URL to the file path the error names (`$XDG_CONFIG_HOME/plans/api-url`, or `~/.config/plans/api-url` when `XDG_CONFIG_HOME` is unset). Do not guess an endpoint.
- Unsupported extension: the CLI refuses before uploading. Convert to an allowlisted type rather than renaming the file.
- Token-file read error: report the configured path problem without displaying file contents.
- HTTP `401` (`unauthorized`): treat the local token and the server's stored digest as out of sync; do not rotate credentials automatically.
- DNS, TLS, or connection failure: report the configured API origin and ask the user to confirm the server is up and reachable from this machine (VPN or private network, if the deployment uses one).
- HTTP `413` (`artifact exceeds the upload limit`): reduce the artifact below the server's upload limit — re-encode video, or drop resolution rather than splitting the file.
- HTTP `415` (`unsupported artifact content type`): the declared type is outside the eight-type allowlist.
- Missing or escaping media reference: nothing was published; fix the path or the reference and re-run.
- `404 Not Found` when viewing: treat the key as unknown, expired, or deleted; do not try to enumerate alternatives.

## Client reference

```text
plans publish [--ttl 12h|7d|2w | --keep] [--json] [--api-url URL] [--token-file FILE] FILE|-
plans delete [--json] [--api-url URL] [--token-file FILE] KEY|URL
plans token [--json | --write FILE]
plans version
```

`plans token` generates a new upload token and the digest the server stores. It is a server-setup command: do not run it during normal publishing, and never show its output.

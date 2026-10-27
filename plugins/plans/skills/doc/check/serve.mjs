// The viewer double: the loopback server build.mjs's browser check loads the candidate from. For
// now this module holds only the MEDIA table, which smoke/build.mjs checks against the table in
// skills/publish/SKILL.md. The server itself is not written yet.
//
// MEDIA maps each extension the plans CLI uploads to the content type it infers. It is the
// publish table as written, `.html` and `.htm` included, so the two can be compared whole. The
// server admits media by this table but never serves an HTML sibling, because the CLI rejects a
// `src` that names a local `.html` file.

export const MEDIA = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
})

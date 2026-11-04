# Frozen static visit

`export-static-visit.mjs` copies one saved visitor snapshot into a folder of
plain files: the visitor page, its exact modules, the pinned Three.js files and
the snapshot's own images, scene data and audio. Any static file server can
show the folder. It needs no application server, Node.js, Python, models or
account at view time; only a static HTTP file server is required. Opening
`index.html` from disk does not work, because browsers block module and data
requests on `file:` pages.

## What this copy is not

The page opens with an **Offline snapshot** notice, and the notice is part of
the contract. The folder is a copy made on the export date. It is not connected
to the app, so later revocation of the link, withdrawal of a memory or a change
to a source's permitted uses does **not** change or stop it. In the live app
those actions stop the views that depend on them. To take a published copy
down, remove the folder from the file server and any cache that holds it.

## Export

Run the app with the visitor listener, issue a visit link for a snapshot that
holds only public or synthetic material, and keep the link's capability (the
`rhv_...` part after `#/visit/`) out of shell history and files. See
[visitor-only ingress](VISITOR-INGRESS.md). Then, from `app/`:

```sh
read -rs REHERE_VISIT_TOKEN && export REHERE_VISIT_TOKEN
node export-static-visit.mjs --origin http://localhost:4318 \
  --out ../demo-site --confirm-public-material
```

`--confirm-public-material` is required: it records that the snapshot was
reviewed and that its sources allow public display. The command prints the
snapshot title, whether it is marked synthetic, and every contributor label
that visitors will see. Review those and the folder before publishing.

Add `--credit-file <path>` to show a reviewed source and rights line under the
page. It must be plain ASCII text with https links only, and it states the
rights for the photograph in the snapshot, so use a file written for that
photograph; for example [the credit for HABS AZ-135-A photograph 26](demo/habs-az-135-a-26.credit.txt)
belongs only to a snapshot made from that photograph. Without it, the page
shows only the credit recorded in the snapshot.

Preview locally with any file server, for example
`python3 -m http.server 8080 --bind 127.0.0.1 --directory ../demo-site`.
The page uses relative paths, so it also works from a sub-path.

## What is written

Only these are written, and the export stops with an error otherwise:

- `index.html`, `style.css`, `offline.css` and the visitor modules the live visitor listener
  serves (checked against `server.mjs` by a test), with root-absolute vendor
  imports made relative. The offline notice and credit footer are styled by
  `offline.css`, not by inline styles, so a host that forbids inline styles
  still shows them.
- `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`: the exported JavaScript is
  Rehere code distributed under the project's Apache-2.0 license, so the
  license and notices travel with it.
- `vendor/`: the pinned Three.js files used for viewing, with their MIT notice.
- `data/manifest.json` and exactly the files the visitor page reads to draw
  the snapshot: the start view's surface and texture (both textures of a
  two-photo composition), the pinned object and outline of a full-object scene
  (their sizes and hashes must match the manifest), the contributor photos the
  manifest lists, and the story and recording audio it lists. Every one of
  these is required: a missing file stops the export instead of producing a
  page that cannot be drawn.
- `EXPORT.json`: the export date, snapshot ID, and a SHA-256 for every file.

Each file is read through a hard byte limit: a longer body is cancelled, not
buffered. The manifest is read again at the end and must be unchanged, so a
link revoked or a snapshot edited during the export cannot yield a mixed copy.
File paths and links to local addresses inside the manifest text stop the
export; other web links are printed for review.

The capability is sent only as an `Authorization` header. The export stops if
any file contains it, the source origin or a local path, if the page or data
reference an API route, if an HTML or JSON file contains an email address, if
a JPEG carries an Exif block, or if a file or the total exceeds the size limits.
Owner, contributor and editing routes are never requested, and the exported page
cannot call them.

The unchanged visitor modules still contain their live-visit code paths; the
static entry never uses them because it supplies its own read-only source.

## Judge entry page

`--entry app/entry --entry-photos <folder>` puts a hand-written entry page in
front of the snapshot. The page shows three public HABS photographs with their
verbatim captions, source links and rights line, one sentence on what Rehere has
and has not done with each, and a "See the change" route into the snapshot. The
snapshot page moves to `snapshot.html`; `snapshot.html?version=<exact version
button text>` opens it on that version, and it links back to the entry.

- The entry files are `app/entry/index.html`, `app/entry/entry.css` and
  `app/entry/photos.json`. The export refuses an entry page that has inline
  styles, scripts, event handlers, a link outside the listed sources, an image
  without alt text, or a missing caption or source link.
- The gate reads every tag's attributes whatever the quoting or letter case,
  refuses a meta refresh, a form, a frame, an SVG, `mailto:` and protocol-relative
  links, and refuses an `entry.css` that imports or loads anything.
- The export checks the entry against the snapshot it is built with: every
  `snapshot.html?version=` link must name exactly one saved view, and the change
  the copy describes (the turn of one object, recorded as an owner-approved
  arrangement) must be recorded in that view. Otherwise the export fails instead
  of shipping a link that opens the wrong view or a claim the data does not back.
- The photographs are never committed. `node app/fetch-entry-photos.mjs <new
  folder>` downloads each pinned Commons JPEG derivative of the Library of
  Congress scan, checks its SHA-256, removes the Exif block without touching the
  image data, checks the result against its pinned hash and writes it. Nothing is
  written if any check fails.
- `--from-export <earlier export folder>` rebuilds a site from an earlier export
  instead of a running visitor listener, for when the live snapshot is gone, for
  example after a withdrawal. Every file of the earlier export must match its
  `EXPORT.json` hash and nothing unlisted may be present; the snapshot data is
  reproduced byte for byte.

## Publishing as a release artifact

The exported folder holds images and audio, which the repository guard rejects,
so it is never committed. Publish it as a release asset: zip the folder, record
the zip's SHA-256, and attach the zip to a release. A manually started
publication workflow downloads that asset, checks its SHA-256 and every file
hash listed in `EXPORT.json`, refuses any unlisted file, and only then deploys
the folder to GitHub Pages.

## Limits

- A snapshot's rights are the owner's to confirm. The export does not decide
  whether a photograph or memory may be shown publicly.
- Browsers may require a secure context or correct MIME types from the file
  server for audio and modules; common static hosts provide both.
- Use `npm test` to run the exporter tests, which use a fake visitor server and
  synthetic files only.

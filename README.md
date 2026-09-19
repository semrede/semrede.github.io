# SemRede

Offgrid Communications, Communities & People.

Static website for [https://semrede.com](https://semrede.com), hosted on GitHub Pages.

## Structure

- `index.html`: single-page site
- `chat/index.html`, `js/chat.js`, `css/chat.css`: the chat room, served at /chat
- `forum/index.html`, `js/forum.js`, `css/forum.css`: the forum, served at /forum
- `js/nostr-config.js`: relays, admin key, room id, forum categories
- `js/nostr-login.js`, `js/identity-ui.js`, `js/nostr-common.js`: login and the shared relay, profile and mute-list code
- `js/vendor/nostr.bundle.js`: nostr-tools 2.25.2, vendored so the site has no runtime CDN dependency
- `tools/nostr-admin.mjs`: room and moderation tool (node, run by hand)
- `css/styles.css`: styles and theme variables
- `img/`: logo (`logo.svg`, also the favicon) and illustrations cropped from the 2026 flyer
- `CNAME`: custom domain for GitHub Pages (do not delete)

## Run locally

Open `index.html` in a browser, or serve the folder with any static web server:

```bash
python3 -m http.server 8000
```

## Chat

`/chat` is a chat room that runs entirely in the browser, on public NOSTR
relays. There is no backend and nothing to host. Visitors log in with a NIP-07
browser extension (Alby, nos2x) or create a key in one click; created keys are
kept in that browser's localStorage.

Messages are NIP-28 channel messages (kind 42) tagged to the room:

| | |
|---|---|
| Room (channel id) | `e80c52b1d568d735530c5461d2386d2a28fcaa619f183101af66c973697ad7eb` |
| Admin pubkey | `npub14xxh46m4mxwpp229e507xzzyvs6rgnqwlxe438t5lpav692s7npsu4xweq` |
| Admin secret key | `~/.config/semrede/nostr-admin.nsec`, never in git |
| Relays | primal.net, damus.io, snort.social, nostr-pub.wellorder.net, purplerelay.com, relay.piazza.today |

The relay list matters: many public relays reject unknown keys, which would
block everyone who creates an account on the site. Every relay above was
checked to accept a brand-new key. The same list appears in `js/chat.js` and in
`tools/nostr-admin.mjs`, and both must be changed together.

## Forum

`/forum` uses the same login and the same relays as the chat. Threads are
NIP-7D events (kind 11) carrying a `title` tag, the `semrede` tag and one
category tag such as `semrede-mesh`. Replies are NIP-22 comments (kind 1111)
that point at the thread with an uppercase `E` tag and at their parent with a
lowercase `e` tag, which is how the reply tree is rebuilt.

Nothing is created in advance, so the categories carry over from year to year.
They are listed in `js/nostr-config.js`; adding one is a line in `CATEGORIES`,
and old threads keep working because each thread stores its own category tag.

Routes are hash based: `#/` categories, `#/c/<slug>` one category, `#/t/<id>`
one thread. A thread link can be shared and opens straight from the relays.

### Moderation

Accounts on the admin mute list (NIP-51, kind 10000) are hidden on semrede.com,
in the chat and in the forum.
They are not deleted from the relays, and other NOSTR clients still show them.

```bash
cd tools && npm install
node nostr-admin.mjs mute npub1...     # hide an account
node nostr-admin.mjs unmute npub1...
node nostr-admin.mjs list
node nostr-admin.mjs sync <channel id> # copy the room onto every relay in the list
```

Importing the admin nsec into Amethyst, Damus or an extension works too: the
mute list of that account is what the site reads.

`node nostr-admin.mjs create` is a one-time command. Running it again with the
key file in place republishes the profile and creates a **second** room, so do
not run it unless you want a new room id.

## Deploy

The site is hosted on GitHub Pages from the repository
[semrede/semrede.github.io](https://github.com/semrede/semrede.github.io),
branch `main`, folder `/` (root). Every push to `main` publishes the site
within a minute or two:

```bash
git push origin main
```

- Live at https://semrede.com (HTTPS enforced, `www.semrede.com` and
  `semrede.github.io` redirect there).
- The TLS certificate is issued and renewed by GitHub (Let's Encrypt).
- Build status: repository Settings > Pages, or
  `gh api repos/semrede/semrede.github.io/pages/builds/latest`.

### DNS (Namecheap, Advanced DNS)

| Type  | Host                              | Value                                      |
|-------|-----------------------------------|--------------------------------------------|
| A     | @                                 | 185.199.108.153, .109.153, .110.153, .111.153 |
| AAAA  | @                                 | 2606:50c0:8000::153 to 2606:50c0:8003::153 |
| CNAME | www                               | semrede.github.io.                         |
| TXT   | _github-pages-challenge-semrede   | domain verification for the `semrede` org  |

Keep the TXT record: it keeps `semrede.com` verified for the organization, so
no other GitHub account can publish a Pages site on it. The email forwarding
MX and SPF records are managed by Namecheap and are unrelated to the site.

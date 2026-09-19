# SemRede

Offgrid Communications, Communities & People.

Static website for [https://semrede.com](https://semrede.com), hosted on GitHub Pages.

## Structure

- `index.html`: single-page site
- `css/styles.css`: styles and theme variables
- `img/`: logo (`logo.svg`, also the favicon) and illustrations cropped from the 2026 flyer
- `CNAME`: custom domain for GitHub Pages (do not delete)

## Run locally

Open `index.html` in a browser, or serve the folder with any static web server:

```bash
python3 -m http.server 8000
```

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

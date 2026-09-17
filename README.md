# SemRede

Offgrid Communications, Communities & People.

Static website for [https://semrede.com](https://semrede.com), hosted on GitHub Pages.

## Structure

- `index.html` — single-page site
- `css/styles.css` — styles and theme variables
- `CNAME` — custom domain for GitHub Pages

## Run locally

Open `index.html` in a browser, or serve the folder with any static web server:

```bash
python3 -m http.server 8000
```

## Deploy

Push to the `main` branch of the GitHub repository. GitHub Pages serves the site automatically at `https://<org>.github.io/<repo>/`, and `CNAME` routes `semrede.com` to it.
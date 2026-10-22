# LOGINA — Waitlist Landing Page

A static, responsive landing page for the LOGINA demo waitlist. Signups are stored in a private Google Sheet through a Cloudflare Worker, and the site is hosted on GitHub Pages.

> Core message: *Don't just look at the answer. See how students think.*

## Project structure

```
index.html                 # The full landing page (HTML + CSS + JS in one file)
google-apps-script.gs      # Backend that receives signups and writes to a Google Sheet
cloudflare-worker/         # Gateway Worker that holds the secret and filters spam
assets/
  design-tokens.json       # Colors, typography, radii, breakpoints (Figma reference)
  preview-*.png            # Layout preview images
CNAME                      # Custom domain for GitHub Pages
.nojekyll                  # Serve static files as-is on GitHub Pages
```

## Run locally

No build step, no dependencies. Open `index.html` in a browser, or run a static server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

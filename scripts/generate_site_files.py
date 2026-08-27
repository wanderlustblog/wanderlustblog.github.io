#!/usr/bin/env python3
"""
Auto-generates sitemap.xml, sidemap.html, llms.txt, and robots.txt for
wanderlustblog.github.io by scanning the repo's HTML files. Also injects
the Google Tag Manager snippet into any HTML file that's missing it.

Run from the repo root:
    python scripts/generate_site_files.py

This is meant to be run automatically by the GitHub Actions workflow at
.github/workflows/auto-update-site-files.yml on every push to main.
"""

import os
import re
import datetime

SITE_URL = "https://wanderlustblog.github.io"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GTM_ID = "GTM-TR9NWVPL"

GTM_SCRIPT = f"""  <!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){{w[l]=w[l]||[];w[l].push({{'gtm.start':
new Date().getTime(),event:'gtm.js'}});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
}})(window,document,'script','dataLayer','{GTM_ID}');</script>
<!-- End Google Tag Manager -->
"""

GTM_NOSCRIPT = f"""  <!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id={GTM_ID}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
"""

# Files/patterns we never touch or list (verification files, this script's
# own output, etc.)
EXCLUDE_FILENAMES = {
    "sidemap.html",
    "404.html",
}
EXCLUDE_PREFIXES = ("google", "yandex_", "pinterest-", "bing")
EXCLUDE_DIRS = {".git", ".github", "node_modules", "scripts"}


def find_html_files():
    """Return a sorted list of relative paths to every content HTML file."""
    found = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for fname in filenames:
            if not fname.endswith(".html"):
                continue
            if fname in EXCLUDE_FILENAMES:
                continue
            if fname.startswith(EXCLUDE_PREFIXES):
                continue
            rel_dir = os.path.relpath(dirpath, REPO_ROOT)
            rel_path = fname if rel_dir == "." else f"{rel_dir}/{fname}"
            found.append(rel_path.replace(os.sep, "/"))
    return sorted(found)


def extract_meta(html):
    title_m = re.search(r"<title>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
    # Use a backreference so an apostrophe inside a double-quoted attribute
    # (e.g. content="What's the difference...") doesn't prematurely end the match.
    desc_m = re.search(
        r'<meta\s+name=["\']description["\']\s+content=(["\'])(.*?)\1',
        html, re.IGNORECASE | re.DOTALL,
    )
    title = re.sub(r"\s+", " ", title_m.group(1)).strip() if title_m else ""
    desc = re.sub(r"\s+", " ", desc_m.group(2)).strip() if desc_m else ""
    # Titles/descriptions are pulled from HTML attributes, so &amp; etc. need
    # unescaping for plain-text/Markdown output (llms.txt, sidemap link text).
    for a, b in (("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">")):
        title = title.replace(a, b)
        desc = desc.replace(a, b)
    return title, desc


def url_for(rel_path):
    if rel_path == "index.html":
        return f"{SITE_URL}/"
    if rel_path == "visa.html":
        return f"{SITE_URL}/visa.html"
    return f"{SITE_URL}/{rel_path}"


def category_for(rel_path):
    if rel_path.startswith("visa/"):
        return "Visa Guides"
    if rel_path.startswith("blog/"):
        return "Blog Posts"
    return "Main Pages"


def priority_for(rel_path):
    if rel_path == "index.html":
        return "1.0"
    if rel_path in ("visa.html", "blog.html"):
        return "0.9"
    if rel_path.startswith("visa/") or rel_path.startswith("blog/"):
        return "0.7"
    return "0.6"


# ---------------------------------------------------------------------------
# GTM injection
# ---------------------------------------------------------------------------

def ensure_gtm(html):
    """Insert the GTM script/noscript blocks if the GTM id isn't present."""
    changed = False

    if GTM_ID not in html:
        head_match = re.search(r"(<head[^>]*>)", html, re.IGNORECASE)
        if head_match:
            insert_at = head_match.end()
            html = html[:insert_at] + "\n" + GTM_SCRIPT + html[insert_at:]
            changed = True

    if "Google Tag Manager (noscript)" not in html:
        body_match = re.search(r"(<body[^>]*>)", html, re.IGNORECASE)
        if body_match:
            insert_at = body_match.end()
            html = html[:insert_at] + "\n" + GTM_NOSCRIPT + html[insert_at:]
            changed = True

    return html, changed


# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------

def generate_sitemap_xml(pages):
    today = datetime.date.today().isoformat()
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for rel_path, _title, _desc in pages:
        lines.append("  <url>")
        lines.append(f"    <loc>{url_for(rel_path)}</loc>")
        lines.append(f"    <lastmod>{today}</lastmod>")
        freq = "daily" if rel_path == "index.html" else "weekly"
        lines.append(f"    <changefreq>{freq}</changefreq>")
        lines.append(f"    <priority>{priority_for(rel_path)}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def generate_llms_txt(pages):
    lines = [
        "# WanderLust Blog",
        "",
        "> Authentic travel stories and practical visa guides from 120+ countries. "
        "Real journeys, honest writing, and no sponsored fluff.",
        "",
    ]
    by_cat = {}
    for rel_path, title, desc in pages:
        by_cat.setdefault(category_for(rel_path), []).append((rel_path, title, desc))

    for cat in ["Main Pages", "Visa Guides", "Blog Posts"]:
        if cat not in by_cat:
            continue
        lines.append(f"## {cat}")
        lines.append("")
        for rel_path, title, desc in by_cat[cat]:
            label = title or rel_path
            if desc:
                lines.append(f"- [{label}]({url_for(rel_path)}): {desc}")
            else:
                lines.append(f"- [{label}]({url_for(rel_path)})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def generate_sidemap_html(pages):
    by_cat = {}
    for rel_path, title, desc in pages:
        by_cat.setdefault(category_for(rel_path), []).append((rel_path, title, desc))

    section_html = []
    for cat in ["Main Pages", "Visa Guides", "Blog Posts"]:
        if cat not in by_cat:
            continue
        items = "\n".join(
            f'      <li><a href="{url_for(p)}">{t or p}</a>'
            f'{f"<span>{d}</span>" if d else ""}</li>'
            for p, t, d in by_cat[cat]
        )
        section_html.append(
            f'    <div class="smap-section">\n      <h2>{cat}</h2>\n'
            f'      <ul>\n{items}\n      </ul>\n    </div>'
        )
    sections = "\n".join(section_html)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
{GTM_SCRIPT}  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Sitemap | WanderLust Blog</title>
  <meta name="description" content="Full sitemap of WanderLust Blog — every page, guide, and story in one place."/>
  <meta name="robots" content="index, follow"/>
  <link rel="canonical" href="{SITE_URL}/sidemap.html"/>
  <link rel="icon" type="image/svg+xml" href="favicon.svg"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;0,700;1,400&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
    :root{{--terra:#c1593c;--deep:#0f0b07;--gold:#d4a853;--cream:#faf7f2;--sand:#f0e8da;--muted:#7a6d5e}}
    body{{font-family:'Outfit',sans-serif;background:var(--cream);color:var(--deep)}}
    header{{background:var(--deep);padding:5rem 4rem 3rem;text-align:center}}
    header h1{{font-family:'Cormorant Garamond',serif;font-size:clamp(2.2rem,4.5vw,3.2rem);color:var(--cream);font-weight:600}}
    header p{{color:#a09080;margin-top:.8rem}}
    main{{max-width:900px;margin:0 auto;padding:4rem}}
    .smap-section{{margin-bottom:3rem}}
    .smap-section h2{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--terra);margin-bottom:1rem;padding-bottom:.6rem;border-bottom:1px solid var(--sand)}}
    .smap-section ul{{list-style:none}}
    .smap-section li{{padding:.6rem 0;border-bottom:1px dashed rgba(15,11,7,.08);display:flex;flex-direction:column;gap:.15rem}}
    .smap-section li a{{color:var(--deep);text-decoration:none;font-weight:500}}
    .smap-section li a:hover{{color:var(--terra)}}
    .smap-section li span{{font-size:.8rem;color:var(--muted)}}
    footer{{text-align:center;padding:2rem;color:var(--muted);font-size:.8rem}}
    @media(max-width:700px){{header{{padding:3rem 1.5rem 2rem}}main{{padding:2rem 1.5rem}}}}
  </style>
</head>
<body>
{GTM_NOSCRIPT}  <header>
    <h1>Sitemap</h1>
    <p>Every page on WanderLust Blog, in one place.</p>
  </header>
  <main>
{sections}
  </main>
  <footer>Auto-generated — always up to date with the live site.</footer>
</body>
</html>
"""


def generate_robots_txt():
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        f"Sitemap: {SITE_URL}/sitemap.xml\n"
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    html_files = find_html_files()
    pages = []
    gtm_changed_files = []

    for rel_path in html_files:
        abs_path = os.path.join(REPO_ROOT, rel_path)
        with open(abs_path, "r", encoding="utf-8") as f:
            html = f.read()

        title, desc = extract_meta(html)
        pages.append((rel_path, title, desc))

        new_html, changed = ensure_gtm(html)
        if changed:
            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(new_html)
            gtm_changed_files.append(rel_path)

    # sitemap.xml
    with open(os.path.join(REPO_ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(generate_sitemap_xml(pages))

    # llms.txt
    with open(os.path.join(REPO_ROOT, "llms.txt"), "w", encoding="utf-8") as f:
        f.write(generate_llms_txt(pages))

    # sidemap.html
    with open(os.path.join(REPO_ROOT, "sidemap.html"), "w", encoding="utf-8") as f:
        f.write(generate_sidemap_html(pages))

    # robots.txt (only create if missing; don't clobber manual edits beyond
    # making sure the Sitemap line exists)
    robots_path = os.path.join(REPO_ROOT, "robots.txt")
    if os.path.exists(robots_path):
        with open(robots_path, "r", encoding="utf-8") as f:
            robots = f.read()
        if "Sitemap:" not in robots:
            robots = robots.rstrip() + f"\n\nSitemap: {SITE_URL}/sitemap.xml\n"
            with open(robots_path, "w", encoding="utf-8") as f:
                f.write(robots)
    else:
        with open(robots_path, "w", encoding="utf-8") as f:
            f.write(generate_robots_txt())

    print(f"Scanned {len(pages)} HTML pages.")
    print("Updated: sitemap.xml, sidemap.html, llms.txt")
    if gtm_changed_files:
        print(f"Injected GTM into {len(gtm_changed_files)} file(s):")
        for f in gtm_changed_files:
            print(f"  - {f}")
    else:
        print("GTM already present on every page — no changes needed.")


if __name__ == "__main__":
    main()

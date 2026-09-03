#!/usr/bin/env node
/**
 * translate-site.js
 *
 * Automatically translates EVERY English .html file in the repo
 * (including subfolders like blog/ and visa/) into each language listed
 * in LANGUAGES, mirrors the folder structure under /<lang>/, and injects
 * correct <link rel="alternate" hreflang="..."> tags into every language
 * version (including the English original).
 *
 * Usage:
 *   DEEPL_API_KEY=xxxx node scripts/translate-site.js
 *
 * Designed to run in CI (see .github/workflows/translate.yml) but works
 * fine locally too.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");
const fetch = require("node-fetch");

// ---------------------------------------------------------------------------
// CONFIG — edit this to match your site
// ---------------------------------------------------------------------------

const SITE_ROOT = path.resolve(__dirname, "..");     // repo root
const BASE_URL = "https://wanderlustblog.github.io"; // no trailing slash

// Target languages: DeepL language code -> hreflang code
const LANGUAGES = {
  es: "es",       // Spanish
  fr: "fr",       // French
  de: "de",       // German
  pt: "pt-BR",    // Portuguese (Brazilian)
  ja: "ja",       // Japanese
  "zh-CN": "zh",  // Chinese (Simplified)
  ar: "ar",       // Arabic
  ru: "ru",       // Russian
  ko: "ko",       // Korean
};

const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_ENDPOINT = process.env.DEEPL_FREE === "false"
  ? "https://api.deepl.com/v2/translate"
  : "https://api-free.deepl.com/v2/translate";

if (!DEEPL_API_KEY) {
  console.error("ERROR: DEEPL_API_KEY environment variable is not set.");
  process.exit(1);
}

// Folders we never walk into (language output folders get added below)
const EXCLUDE_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "scripts",
  "videos",
  ...Object.keys(LANGUAGES), // don't re-translate already-translated output
]);

// Specific filenames we never translate/copy
const EXCLUDE_FILENAMES = new Set(["sidemap.html", "404.html"]);

// Filename prefixes we never translate/copy (site-verification files etc.)
const EXCLUDE_PREFIXES = ["google", "yandex_", "pinterest-", "bing", "BingSiteAuth"];

// Languages that read right-to-left — their <html> tag needs dir="rtl"
const RTL_LANGUAGES = new Set(["ar"]);

const SKIP_TAGS = new Set(["script", "style", "code", "pre"]);

// Cache file that tracks a hash of each English source page's content, so
// we only pay DeepL for pages that actually changed since the last run.
const CACHE_PATH = path.join(SITE_ROOT, "scripts", ".translation-cache.json");

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function hashContent(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Discover every translatable HTML file in the repo, recursively
// ---------------------------------------------------------------------------

function findHtmlFiles() {
  const found = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".html")) continue;
      if (EXCLUDE_FILENAMES.has(entry.name)) continue;
      if (EXCLUDE_PREFIXES.some((p) => entry.name.startsWith(p))) continue;

      const relPath = path
        .relative(SITE_ROOT, path.join(dir, entry.name))
        .split(path.sep)
        .join("/");
      found.push(relPath);
    }
  }

  walk(SITE_ROOT);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Translation helper (batches text to stay under DeepL request limits)
// ---------------------------------------------------------------------------

async function translateBatch(texts, targetLang) {
  if (texts.length === 0) return [];
  const params = new URLSearchParams();
  params.append("target_lang", targetLang.toUpperCase());
  params.append("tag_handling", "html");
  texts.forEach((t) => params.append("text", t));

  const res = await fetch(DEEPL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `DeepL-Auth-Key ${DEEPL_API_KEY}`,
    },
    body: params,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`DeepL API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.translations.map((t) => t.text);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// HTML translation: walk text nodes + key attributes, translate, rebuild
// ---------------------------------------------------------------------------

async function translateHtmlFile(srcPath, targetLang, allRelPaths) {
  const html = fs.readFileSync(srcPath, "utf8");
  const $ = cheerio.load(html, { decodeEntities: false });

  const textNodes = [];
  $("*")
    .contents()
    .each((_, el) => {
      if (el.type !== "text") return;
      const parentTag = el.parent && el.parent.tagName;
      if (SKIP_TAGS.has(parentTag)) return;
      const trimmed = el.data.trim();
      if (trimmed.length === 0) return;
      textNodes.push(el);
    });

  const attrTargets = [];
  $("img[alt]").each((_, el) => attrTargets.push({ el, attr: "alt" }));
  $("meta[name='description'], meta[property^='og:'], meta[name^='twitter:']")
    .filter((_, el) => {
      const prop = $(el).attr("property") || $(el).attr("name");
      return /description|title/i.test(prop || "");
    })
    .each((_, el) => attrTargets.push({ el, attr: "content" }));
  $("title").each((_, el) => textNodes.push(el.children[0] || el));

  const rawStrings = [
    ...textNodes.map((n) => n.data || $(n).text()),
    ...attrTargets.map((t) => $(t.el).attr(t.attr) || ""),
  ];

  const translated = [];
  for (const group of chunk(rawStrings, 50)) {
    const out = await translateBatch(group, LANGUAGES[targetLang]);
    translated.push(...out);
  }

  let i = 0;
  for (const node of textNodes) {
    if (node.data !== undefined) node.data = translated[i];
    i++;
  }
  for (const t of attrTargets) {
    $(t.el).attr(t.attr, translated[i]);
    i++;
  }

  // Rewrite internal absolute links so they point at the translated
  // equivalent when one exists. Relative links (e.g. "visa.html",
  // "multiple-entry-visa.html") are left as-is since the folder structure
  // is mirrored under /<lang>/, so relative paths still resolve correctly.
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    if (href.startsWith(BASE_URL)) {
      const relFromSite = href.replace(BASE_URL, "").replace(/^\//, "");
      if (allRelPaths.includes(relFromSite)) {
        $(el).attr("href", `${BASE_URL}/${targetLang}/${relFromSite}`);
      }
    }
  });

  // Set correct <html lang="..."> and dir="rtl" for RTL languages so the
  // page renders in the right reading direction and browsers/screen
  // readers know what language they're looking at.
  $("html").attr("lang", targetLang === "zh-CN" ? "zh-CN" : targetLang);
  if (RTL_LANGUAGES.has(targetLang)) {
    $("html").attr("dir", "rtl");
  } else {
    $("html").removeAttr("dir");
  }

  return $.html();
}

// ---------------------------------------------------------------------------
// hreflang injection — runs AFTER all translations exist on disk
// ---------------------------------------------------------------------------

function injectHreflangTags(allRelPaths) {
  for (const relPath of allRelPaths) {
    const versions = [{ lang: "en", filePath: path.join(SITE_ROOT, relPath) }];
    for (const lang of Object.keys(LANGUAGES)) {
      versions.push({
        lang,
        filePath: path.join(SITE_ROOT, lang, relPath),
      });
    }

    const tagLines = versions
      .filter((v) => fs.existsSync(v.filePath))
      .map((v) => {
        const url =
          v.lang === "en"
            ? `${BASE_URL}/${relPath}`
            : `${BASE_URL}/${v.lang}/${relPath}`;
        return `<link rel="alternate" hreflang="${v.lang}" href="${url}" />`;
      });
    tagLines.push(
      `<link rel="alternate" hreflang="x-default" href="${BASE_URL}/${relPath}" />`
    );
    const block = tagLines.join("\n");

    for (const v of versions) {
      if (!fs.existsSync(v.filePath)) continue;
      const html = fs.readFileSync(v.filePath, "utf8");
      const $ = cheerio.load(html, { decodeEntities: false });
      $("head link[rel='alternate'][hreflang]").remove();
      $("head").append("\n" + block + "\n");
      fs.writeFileSync(v.filePath, $.html());
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const allRelPaths = findHtmlFiles();
  console.log(`Found ${allRelPaths.length} English HTML pages.`);

  const cache = loadCache(); // { "relPath": "sha256hash" }
  let translatedCount = 0;
  let skippedCount = 0;

  for (const relPath of allRelPaths) {
    const srcPath = path.join(SITE_ROOT, relPath);
    const sourceHtml = fs.readFileSync(srcPath, "utf8");
    const currentHash = hashContent(sourceHtml);
    const cachedHash = cache[relPath];

    // Only translate languages that are actually missing or stale for this
    // page — if you add a new language later, already-translated languages
    // for existing pages won't be wastefully re-translated.
    const langsNeeded = Object.keys(LANGUAGES).filter((lang) => {
      if (cachedHash !== currentHash) return true; // content changed, redo all
      return !fs.existsSync(path.join(SITE_ROOT, lang, relPath)); // missing only
    });

    if (langsNeeded.length === 0) {
      console.log(`Unchanged, skipping: ${relPath}`);
      skippedCount++;
      continue;
    }

    for (const lang of langsNeeded) {
      const outPath = path.join(SITE_ROOT, lang, relPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      console.log(`Translating ${relPath} -> ${lang} ...`);
      const translatedHtml = await translateHtmlFile(srcPath, lang, allRelPaths);
      fs.writeFileSync(outPath, translatedHtml);
    }

    cache[relPath] = currentHash;
    translatedCount++;
  }

  saveCache(cache);
  console.log(
    `\nTranslated ${translatedCount} page(s), skipped ${skippedCount} unchanged page(s).`
  );

  console.log("Injecting hreflang tags across all language versions...");
  injectHreflangTags(allRelPaths);

  console.log("Done. Translated files written under /<lang>/ folders.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

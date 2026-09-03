async function main() {
  const allRelPaths = findHtmlFiles();
  console.log(`Found ${allRelPaths.length} English HTML pages.`);

  const cache = loadCache(); // { "relPath": "sha256hash" }
  let translatedCount = 0;
  let skippedCount = 0;

  try {
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
  } finally {
    // Always save whatever progress was made, even if we're about to
    // rethrow an error (e.g. quota exceeded partway through). This is what
    // lets the GitHub Actions commit step find a real cache file to add,
    // instead of failing because the file was never created.
    saveCache(cache);
    console.log(
      `\nTranslated ${translatedCount} page(s), skipped ${skippedCount} unchanged page(s).`
    );
  }

  console.log("Injecting hreflang tags across all language versions...");
  injectHreflangTags(allRelPaths);

  console.log("Done. Translated files written under /<lang>/ folders.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

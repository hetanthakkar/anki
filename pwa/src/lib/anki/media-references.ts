function decodedName(value: string) {
  const unescaped = value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
  try { return decodeURIComponent(unescaped).normalize("NFC"); }
  catch { return unescaped.normalize("NFC"); }
}

function localName(value: string) {
  const name = decodedName(value.trim());
  if (!name || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(name)) return null;
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** Extract local media filenames from Anki fields, templates, and CSS. */
export function mediaReferences(...values: string[]) {
  const names = new Set<string>();
  const add = (raw: string) => {
    const name = localName(raw);
    if (name) names.add(name);
  };

  for (const value of values) {
    for (const match of value.matchAll(/\[sound:([^\]]+)]/gi)) add(match[1]);
    for (const match of value.matchAll(/\b(?:src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      add(match[1] ?? match[2] ?? match[3] ?? "");
    }
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
      add(match[1] ?? match[2] ?? match[3] ?? "");
    }
  }
  return names;
}

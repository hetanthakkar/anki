/** Imported fields are untrusted HTML; keep editable formatting without executable markup. */
export function editorHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "SUB", "SUP", "BR", "DIV", "P", "SPAN", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "HR", "IMG", "AUDIO", "VIDEO", "SOURCE", "A", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"]);
  const drop = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE", "LINK", "META", "BASE"]);
  const styles = ["font-weight", "font-style", "text-decoration", "text-decoration-line", "color", "background-color", "font-size", "font-family", "text-align", "white-space"];
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (drop.has(element.tagName)) { element.remove(); continue; }
    if (!allowed.has(element.tagName)) { element.replaceWith(...element.childNodes); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === "style") {
        const source = (element as HTMLElement).style;
        const clean = document.createElement("span").style;
        for (const property of styles) clean.setProperty(property, source.getPropertyValue(property));
        element.setAttribute("style", clean.cssText);
      } else if (["src", "href"].includes(name)) {
        const url = attribute.value.replace(/[\u0000-\u0020]/g, "");
        if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^(https?:|blob:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(url)) element.removeAttribute(name);
      } else if (!["alt", "title", "controls", "colspan", "rowspan", "target"].includes(name)) element.removeAttribute(name);
    }
  }
  return template.innerHTML;
}

export type SearchContext = {
  today: number;
  dayStart: number;
  now: number;
  decks: { id: number; name: string }[];
  notetypes: { id: number; name: string }[];
  currentDeckId: number | null;
};

/** Tokenize quoted names without interpolating user input into SQL. */
function tokens(query: string): string[] {
  const result: string[] = [];
  let word = "";
  let quoted = false;
  let escaped = false;
  for (const character of query.trim()) {
    if (escaped) { word += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (/\s/.test(character) && !quoted) {
      if (word) result.push(word);
      word = "";
    } else word += character;
  }
  if (quoted || escaped) throw new Error("Close the quoted search term.");
  if (word) result.push(word);
  return result;
}

export function quoteSearch(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function browserSearch(query: string, context: SearchContext) {
  const bind: (string | number)[] = [];
  const clauses: string[] = [];
  const due = "(CASE WHEN c.odue != 0 THEN c.odue ELSE c.due END)";
  for (let token of tokens(query)) {
    const negate = token.startsWith("-");
    if (negate) token = token.slice(1);
    let sql: string;
    const colon = token.indexOf(":");
    const key = colon < 0 ? "text" : token.slice(0, colon).toLowerCase();
    const value = colon < 0 ? token : token.slice(colon + 1);
    const integer = () => {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key} value.`);
      return Number(value);
    };
    if (key === "text") {
      if (["OR", "AND", "(", ")"].includes(token)) throw new Error("Combine search terms with spaces; each term must match.");
      sql = "(instr(lower(n.flds), lower(?)) > 0 OR instr(lower(n.tags), lower(?)) > 0 OR instr(lower(n.sfld), lower(?)) > 0)";
      bind.push(value, value, value);
    } else if (key === "is") {
      const states: Record<string, string> = {
        new: "c.type = 0", learn: "c.type IN (1,3)", learning: "c.type IN (1,3)", review: "c.type IN (2,3)",
        suspended: "c.queue = -1", buried: "c.queue IN (-2,-3)",
        due: `((c.queue IN (2,3) AND ${due} <= ?) OR (c.queue IN (1,4) AND ${due} <= ?))`,
      };
      sql = states[value.toLowerCase()];
      if (!sql) throw new Error(`Unknown card state: ${value}`);
      if (value.toLowerCase() === "due") bind.push(context.today, context.now);
    } else if (key === "flag") {
      const flag = integer();
      if (flag > 7) throw new Error("Flags range from 0 to 7.");
      sql = "(c.flags & 7) = ?"; bind.push(flag);
    } else if (key === "tag") {
      if (value.toLowerCase() === "none") sql = "trim(n.tags) = ''";
      else { sql = "instr(lower(' ' || trim(n.tags) || ' '), lower(?)) > 0"; bind.push(` ${value} `); }
    } else if (key === "deck" || key === "did") {
      const selected = key === "did" ? context.decks.find((deck) => deck.id === integer())
        : value.toLowerCase() === "current" ? context.decks.find((deck) => deck.id === context.currentDeckId)
          : context.decks.find((deck) => deck.name.toLowerCase() === value.toLowerCase());
      if (value.toLowerCase() === "current" && !selected) throw new Error("Open a deck first to use Current Deck.");
      const ids = selected ? context.decks.filter((deck) => deck.id === selected.id || deck.name.toLowerCase().startsWith(`${selected.name.toLowerCase()}::`)).map((deck) => deck.id) : [];
      sql = ids.length ? `c.did IN (${ids.map(() => "?").join(",")})` : "0";
      bind.push(...ids);
    } else if (key === "note" || key === "mid") {
      const ids = context.notetypes.filter((note) => key === "mid" ? note.id === integer() : note.name.toLowerCase() === value.toLowerCase()).map((note) => note.id);
      sql = ids.length ? `n.mid IN (${ids.map(() => "?").join(",")})` : "0";
      bind.push(...ids);
    } else if (key === "card") {
      sql = "c.ord = ?"; bind.push(Math.max(0, integer() - 1));
    } else if (key === "prop") {
      const match = /^due(<=|>=|!=|=|<|>)(-?\d+)$/.exec(value);
      if (!match) throw new Error("Use a due filter such as prop:due=0 or prop:due<0.");
      const [, operator, days] = match;
      sql = `((c.queue IN (2,3) AND ${due} ${operator} ?) OR (c.queue IN (1,4) AND floor((${due} - ?) / 86400.0) ${operator} ?))`;
      bind.push(context.today + Number(days), context.dayStart, Number(days));
    } else if (["added", "edited", "rated", "introduced", "resched"].includes(key)) {
      const match = /^(\d+)(?::([1-4]))?$/.exec(value);
      if (!match || (match[2] && key !== "rated")) throw new Error(`Invalid ${key} filter.`);
      const start = context.dayStart - (Math.max(1, Number(match[1])) - 1) * 86400;
      if (key === "added") { sql = "c.id >= ?"; bind.push(start * 1000); }
      else if (key === "edited") { sql = "n.mod >= ?"; bind.push(start); }
      else if (key === "introduced") {
        sql = "(SELECT min(r.id) FROM revlog r WHERE r.cid = c.id AND r.ease != 0) >= ?";
        bind.push(start * 1000);
      } else {
        sql = `EXISTS (SELECT 1 FROM revlog r WHERE r.cid = c.id AND r.id >= ?${key === "resched" ? " AND r.ease = 0" : match[2] ? " AND r.ease = ?" : " AND r.ease != 0"})`;
        bind.push(start * 1000);
        if (match[2]) bind.push(Number(match[2]));
      }
    } else throw new Error(`Unsupported search filter: ${key}`);
    clauses.push(negate ? `NOT coalesce((${sql}), 0)` : `(${sql})`);
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1", bind };
}

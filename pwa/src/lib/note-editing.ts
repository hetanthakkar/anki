/** Cloze numbers are shared across every field of a note. */
export function nextClozeNumber(fields: string[]): number {
  let highest = 0;
  for (const field of fields) {
    for (const match of field.matchAll(/\{\{c(\d+)::/g)) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
    }
  }
  return highest + 1;
}

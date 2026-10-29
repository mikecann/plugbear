// "*" matches any run of characters (including none) and "?" one
// character. Matching is case-insensitive so a rule like "*__*send*" also
// catches camelCase tools such as "sendMessage".

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let regexp = cache.get(glob);
  if (!regexp) {
    const body = glob
      .split("")
      .map((char) => {
        if (char === "*") return ".*";
        if (char === "?") return ".";
        return char.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
      })
      .join("");
    regexp = new RegExp(`^${body}$`, "is");
    cache.set(glob, regexp);
  }
  return regexp;
}

export function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

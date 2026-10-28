// src/app/admin/generator.ts
// Turns a template (text with [variables]) into a concrete question.

export type TemplateVariable = {
  name: string;
  type: "numerical" | "female_name" | "male_name" | "string" | "array" | "computed";
  // numerical: checkbox flags, optional bounds, and one constraint per line (LaTeX, may use [variables])
  flags?: string[];
  greaterThan?: string;
  lessThan?: string;
  constraints?: string[];
  // string: the possible values
  values?: string[];
  // array: each row is one variant; [name.2] picks the second entry of the chosen row.
  // Entries may contain [variables] and \calc{formulas}
  rows?: string[][];
  // computed: a LaTeX formula (may use [variables]) evaluated after the random picks, like \calc{expression}
  expression?: string;
};

export type TemplateData = {
  id: string;
  text: string;
  choices: { label: string; text: string }[];
  correct_label: string;
  solution: string | null;
  variables: TemplateVariable[];
};

export type GeneratedQuestion = {
  text: string;
  choices: { label: string; text: string }[];
  correctLabel: string;
  solution: string | null;
  values: { name: string; type: TemplateVariable["type"]; value: string }[];
};

const FEMALE_NAMES = [
  "Maria", "Olivia", "Emma", "Sophia", "Ava", "Isabella", "Mia", "Amelia", "Harper", "Evelyn",
  "Abigail", "Emily", "Ella", "Grace", "Chloe", "Lily", "Hannah", "Zoe", "Nora", "Aaliyah",
  "Priya", "Mei", "Fatima", "Sofia", "Naomi", "Leah", "Camila", "Aisha", "Rosa", "Tessa",
];
const MALE_NAMES = [
  "Liam", "Noah", "Oliver", "James", "Elijah", "William", "Henry", "Lucas", "Benjamin", "Theo",
  "Jacob", "Daniel", "Matthew", "Samuel", "David", "Carlos", "Mateo", "Omar", "Ethan", "Ravi",
  "Wei", "Jamal", "Diego", "Caleb", "Isaac", "Andre", "Miguel", "Jonah", "Felix", "Hassan",
];

// [name] or [name.2] (a position within an array variable, counting from 1)
const VAR_RE = /\[([A-Za-z_][A-Za-z0-9_]*)(?:\.(\d+))?\]/g;

// ---------------------------------------------------------------------------------------------
// LaTeX expression evaluator. Supports numbers, [variables], + - \cdot \times * \div /, ^,
// |absolute value|, \frac{}{}, \sqrt{},\tofrac{}, \rem{}{}, \floor{}, \ceil{}, \pi, parentheses and braces, \left \right, and implicit multiplication.
// ---------------------------------------------------------------------------------------------

type Token = { t: "num"; v: number } | { t: "var"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw new Error(`Unexpected "${ch}" in formula`);
      out.push({ t: "num", v: Number(m[1]) });
      i += m[1].length;
    } else if (ch === "[") {
      const m = /^\[([A-Za-z_][A-Za-z0-9_]*(?:\.\d+)?)\]/.exec(src.slice(i));
      if (!m) throw new Error("Unexpected [ in formula");
      out.push({ t: "var", v: m[1] });
      i += m[0].length;
    } else if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
      const cmd = m![1];
      i += m![0].length;
      if (cmd === "," || cmd === ";" || cmd === " " || cmd === "!" || cmd === "left" || cmd === "right") continue;
      if (cmd === "cdot" || cmd === "times") out.push({ t: "op", v: "*" });
      else if (cmd === "div") out.push({ t: "op", v: "/" });
      else if (cmd === "frac" || cmd === "dfrac" || cmd === "sqrt" || cmd === "pi" || cmd === "tofrac" || cmd === "rem" || cmd === "floor" || cmd === "ceil") out.push({ t: "op", v: "\\" + cmd });
      else throw new Error(`Unsupported LaTeX command \\${cmd}`);
    } else if ("+-*/^(){}|".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
    } else {
      throw new Error(`Unexpected "${ch}" in formula`);
    }
  }
  return out;
}

export function evaluateFormula(src: string, vars: Map<string, number | string>): number {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => toks[pos]?.t === "op" && toks[pos].v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}" in formula`);
    pos++;
  };
  // Inside |...| a bar closes the value instead of starting a new factor.
  let absOpen = 0;
  const startsFactor = () => {
    const k = peek();
    if (!k) return false;
    if (k.t === "op" && k.v === "|") return absOpen === 0;
    if (k.t === "num" || k.t === "var") return true;
    return ["(", "{", "\\frac", "\\dfrac", "\\sqrt", "\\pi", "\\tofrac", "\\rem", "\\floor", "\\ceil"].includes(k.v);
  };

  function expr(): number {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[pos++].v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = unary();
    for (;;) {
      if (isOp("*")) {
        pos++;
        v *= unary();
      } else if (isOp("/")) {
        pos++;
        v /= unary();
      } else if (startsFactor()) {
        v *= unary();
      } else return v;
    }
  }
  function unary(): number {
    if (isOp("-")) {
      pos++;
      return -unary();
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  }
  function power(): number {
    const base = atom();
    if (isOp("^")) {
      pos++;
      // Exponent is a braced group, or a single (possibly signed) atom.
      const sign = isOp("-") ? (pos++, -1) : 1;
      return Math.pow(base, sign * atom());
    }
    return base;
  }
  function group(): number {
    expectOp("{");
    const v = expr();
    expectOp("}");
    return v;
  }
  function atom(): number {
    const k = peek();
    if (!k) throw new Error("Formula ended unexpectedly");
    pos++;
    if (k.t === "num") return k.v;
    if (k.t === "var") {
      const val = vars.get(k.v);
      if (val === undefined) throw new Error(`[${k.v}] has no value`);
      if (typeof val === "string") throw new Error(`[${k.v}] is text and can't be used in a formula`);
      return val;
    }
    switch (k.v) {
      case "(": {
        const v = expr();
        expectOp(")");
        return v;
      }
      case "{":
        pos--;
        return group();
      case "|": {
        absOpen++;
        const v = expr();
        absOpen--;
        expectOp("|");
        return Math.abs(v);
      }
      case "\\frac":
      case "\\dfrac": {
        const n = group();
        const d = group();
        return n / d;
      }
      case "\\sqrt":
        return Math.sqrt(group());
      case "\\floor":
        return Math.floor(group());
      case "\\ceil":
        return Math.ceil(group());
      case "\\rem": {
        // Math convention: the remainder is never negative, so \rem{-7}{3} is 2.
        const a = group();
        const b = Math.abs(group());
        return b === 0 ? NaN : ((a % b) + b) % b;
      }
      case "\\tofrac": // only changes how the value is displayed, not what it is
        return group();
      case "\\pi":
        return Math.PI;
      default:
        throw new Error(`Unexpected "${k.v}" in formula`);
    }
  }

  const result = expr();
  if (pos < toks.length) throw new Error(`Unexpected "${(toks[pos] as { v: unknown }).v}" in formula`);
  return result;
}

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Numerical constraints
// ---------------------------------------------------------------------------------------------

export const NUMERIC_FLAGS = [
  { id: "integer", label: "Integer" },
  { id: "whole", label: "Whole number (0 or greater)" },
  { id: "positive", label: "Positive" },
  { id: "negative", label: "Negative" },
  { id: "nonzero", label: "Nonzero" },
  { id: "even", label: "Even" },
  { id: "odd", label: "Odd" },
] as const;

export type Relation = "<" | "<=" | ">" | ">=" | "=" | "!=";
/** A chain such as `0 < [x] < 10`: parts.length === ops.length + 1. */
export type Chain = { parts: string[]; ops: Relation[] };

const REL_RE = /\\leq?(?![A-Za-z])|\\geq?(?![A-Za-z])|\\neq?(?![A-Za-z])|<=|>=|!=|<|>|=/g;

function relationOf(token: string): Relation {
  if (token === "<=" || token.startsWith("\\le")) return "<=";
  if (token === ">=" || token.startsWith("\\ge")) return ">=";
  if (token === "!=" || token.startsWith("\\ne")) return "!=";
  return token as Relation;
}

/** Splits one constraint line into expressions and the relations between them. */
export function parseChain(line: string): Chain {
  const parts: string[] = [];
  const ops: Relation[] = [];
  let last = 0;
  for (const m of line.matchAll(REL_RE)) {
    parts.push(line.slice(last, m.index));
    ops.push(relationOf(m[0]));
    last = m.index! + m[0].length;
  }
  parts.push(line.slice(last));
  if (ops.length === 0) throw new Error(`"${line}" needs a comparison such as <, >, \\le, \\ge, = or \\ne`);
  if (parts.some((p) => !p.trim())) throw new Error(`"${line}" is missing a value next to a comparison`);
  return { parts, ops };
}

/** A constraint line that starts with "or" is an alternative to the line above it. */
const OR_RE = /^or\s+/i;
export const isOrLine = (line: string) => OR_RE.test(line.trim());

/** Throws if a constraint line can't be parsed or evaluated (checked with every variable set to 1). */
export function checkConstraintSyntax(line: string, names: string[]): Chain {
  const chain = parseChain(line.trim().replace(OR_RE, ""));
  const dummy = new Map<string, number | string>(names.map((n) => [n, 1]));
  for (const p of chain.parts) evaluateFormula(p, dummy);
  return chain;
}

function compare(a: number, op: Relation, b: number): boolean {
  const eps = 1e-9;
  switch (op) {
    case "<": return a < b - eps;
    case "<=": return a <= b + eps;
    case ">": return a > b + eps;
    case ">=": return a >= b - eps;
    case "=": return Math.abs(a - b) <= eps;
    case "!=": return Math.abs(a - b) > eps;
  }
}

function flagOk(flag: string, x: number): boolean {
  const isInt = Math.abs(x - Math.round(x)) < 1e-9;
  switch (flag) {
    case "integer": return isInt;
    case "whole": return isInt && x >= 0;
    case "positive": return x > 0;
    case "negative": return x < 0;
    case "nonzero": return x !== 0;
    case "even": return isInt && Math.round(x) % 2 === 0;
    case "odd": return isInt && Math.abs(Math.round(x) % 2) === 1;
    default: return true;
  }
}

/** Chains joined by "or": a group holds when at least one of its chains does. Groups are ANDed. */
export type ConstraintGroup = Chain[];

/** The constraint groups of a numerical variable, including its greater-than / less-than fields. */
export function groupsOf(v: TemplateVariable): ConstraintGroup[] {
  const self = `[${v.name}]`;
  const out: ConstraintGroup[] = [];
  if (v.greaterThan?.trim()) out.push([{ parts: [self, v.greaterThan], ops: [">"] }]);
  if (v.lessThan?.trim()) out.push([{ parts: [self, v.lessThan], ops: ["<"] }]);
  let first = true;
  for (const line of v.constraints ?? []) {
    if (!line.trim()) continue;
    const chain = parseChain(line.trim().replace(OR_RE, ""));
    if (isOrLine(line)) {
      if (first) throw new Error("The first constraint can't start with \"or\"");
      out[out.length - 1].push(chain);
    } else out.push([chain]);
    first = false;
  }
  return out;
}

/** Every chain of a numerical variable, ignoring how they are grouped. */
export function chainsOf(v: TemplateVariable): Chain[] {
  return groupsOf(v).flat();
}

/** Other variables this one's constraints refer to. */
export function dependenciesOf(v: TemplateVariable): string[] {
  const refs = new Set<string>();
  for (const c of chainsOf(v)) for (const p of c.parts) for (const m of p.matchAll(VAR_RE)) refs.add(m[1]);
  refs.delete(v.name);
  return [...refs];
}

/** Turns variables saved by earlier versions (integer / whole / formula) into numerical ones. */
export function normalizeVariable(raw: Record<string, unknown>): TemplateVariable {
  const name = String(raw.name);
  const type = String(raw.type);
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const list = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
  if (type === "integer" || type === "whole") {
    const constraints: string[] = [];
    if (raw.min != null) constraints.push(`[${name}] \\ge ${raw.min}`);
    if (raw.max != null) constraints.push(`[${name}] \\le ${raw.max}`);
    return { name, type: "numerical", flags: type === "whole" ? ["integer", "whole"] : ["integer"], constraints };
  }
  if (type === "formula") {
    return { name, type: "numerical", flags: [], constraints: [`[${name}] = ${str(raw.expression)}`] };
  }
  if (type === "numerical") {
    return {
      name,
      type,
      flags: list(raw.flags),
      greaterThan: str(raw.greaterThan),
      lessThan: str(raw.lessThan),
      constraints: list(raw.constraints),
    };
  }
  if (type === "computed") return { name, type, expression: str(raw.expression) };
  if (type === "array") {
    const rows = Array.isArray(raw.rows) ? (raw.rows as unknown[]).map((r) => list(r)) : [];
    return { name, type, rows };
  }
  return { name, type: type as TemplateVariable["type"], values: list(raw.values) };
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

class SampleError extends Error {}

function formatNumber(n: number): string {
  return String(Number(n.toFixed(8)));
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function fill(s: string, values: Map<string, string>, arrays: Map<string, string[]>): string {
  return s.replace(VAR_RE, (m, name: string, pos?: string) =>
    pos ? arrays.get(name)?.[Number(pos) - 1] ?? m : values.get(name) ?? m
  );
}

/** Replaces each \calc{...} in s with fn(body), where body is the text between the matching braces. */
export function mapCalc(s: string, fn: (body: string) => string): string {
  const tag = "\\calc{";
  let out = "";
  let i = 0;
  for (;;) {
    const start = s.indexOf(tag, i);
    if (start < 0) return out + s.slice(i);
    let depth = 1;
    let j = start + tag.length;
    while (j < s.length && depth > 0) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") depth--;
      j++;
    }
    if (depth > 0) throw new Error(`Missing } after \\calc{ in "${s}"`);
    out += s.slice(i, start) + fn(s.slice(start + tag.length, j - 1));
    i = j;
  }
}

/** True when the whole body is a single \tofrac{...}. */
function isWholeToFrac(body: string): boolean {
  const m = /^\s*\\tofrac\s*\{/.exec(body);
  if (!m) return false;
  let depth = 1;
  for (let j = m[0].length; j < body.length; j++) {
    if (body[j] === "{") depth++;
    else if (body[j] === "}" && --depth === 0) return body.slice(j + 1).trim() === "";
  }
  return false;
}

/** The value as a reduced \frac{n}{d} (or an integer), or null if no small denominator fits. */
function toFraction(x: number): string | null {
  for (let d = 1; d <= 10000; d++) {
    const n = Math.round(x * d);
    if (Math.abs(n / d - x) < 1e-9) {
      const neg = n < 0 ? "-" : "";
      return d === 1 ? `${n}` : `${neg}\\frac{${Math.abs(n)}}{${d}}`;
    }
  }
  return null;
}

/**
 * Replaces each \calc{formula} with its value. A \calc whose whole body is \tofrac{...}
 * gives a reduced fraction instead of a decimal.
 */
function resolveCalc(s: string, values: Map<string, number | string>): string {
  return mapCalc(s, (body) => {
    const n = evaluateFormula(body, values);
    if (!Number.isFinite(n)) throw new SampleError(`\\calc{${body}} isn't a finite number`);
    if (isWholeToFrac(body)) {
      const frac = toFraction(n);
      if (!frac) throw new SampleError(`\\calc{${body}} has no simple fraction form`);
      return frac;
    }
    return formatNumber(n);
  });
}

/** Fills an array entry: \calc{formula} becomes its value, then [variables] are substituted. */
function resolveEntry(
  entry: string,
  values: Map<string, number | string>,
  shown: Map<string, string>,
  done: Map<string, string[]>
): string {
  // Entries of already-filled arrays are available to formulas as [name.2].
  const withArrays = new Map(values);
  for (const [name, row] of done) {
    row.forEach((e, i) => withArrays.set(`${name}.${i + 1}`, e.trim() !== "" && Number.isFinite(Number(e)) ? Number(e) : e));
  }
  return fill(resolveCalc(entry, withArrays), shown, done);
}

/** Names of the arrays that an array's entries refer to (other than itself). */
function arrayRefsOf(rows: string[][]): Set<string> {
  const refs = new Set<string>();
  for (const e of rows.flat()) for (const m of e.matchAll(VAR_RE)) if (m[2]) refs.add(m[1]);
  return refs;
}

const WINDOW = 20;

/**
 * Picks a value for a numerical variable. Bounds and equations that involve only already-chosen
 * variables narrow where to look; candidates are whole numbers unless an equation fixes the value.
 * Everything is then checked against the flags and every constraint.
 */
function sampleNumerical(v: TemplateVariable, values: Map<string, number | string>): number {
  const groups = groupsOf(v);
  const flags = v.flags ?? [];
  const self = `[${v.name}]`;
  let lo = -Infinity;
  let hi = Infinity;
  let fixed: number | undefined;

  const valueOf = (expr: string): number | undefined => {
    try {
      const n = evaluateFormula(expr, values);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const bound = (op: Relation, n: number) => {
    if (op === "=") fixed = n;
    else if (op === "<" || op === "<=") hi = Math.min(hi, n);
    else if (op === ">" || op === ">=") lo = Math.max(lo, n);
  };
  const flip: Record<Relation, Relation> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=", "!=": "!=" };

  // Only a constraint with no "or" alternatives can narrow the search range.
  for (const c of groups.filter((g) => g.length === 1).map((g) => g[0])) {
    c.ops.forEach((op, i) => {
      const left = c.parts[i];
      const right = c.parts[i + 1];
      if (left.trim() === self) {
        const n = valueOf(right);
        if (n !== undefined) bound(op, n);
      } else if (right.trim() === self) {
        const n = valueOf(left);
        if (n !== undefined) bound(flip[op], n);
      }
    });
  }
  if (flags.includes("whole") || flags.includes("positive")) lo = Math.max(lo, 0);
  if (flags.includes("negative")) hi = Math.min(hi, 0);

  const ok = (x: number): boolean => {
    if (!Number.isFinite(x)) return false;
    if (!flags.every((f) => flagOk(f, x))) return false;
    const vals = new Map(values);
    vals.set(v.name, x);
    const holds = (c: Chain) => {
      try {
        return c.ops.every((op, i) => compare(evaluateFormula(c.parts[i], vals), op, evaluateFormula(c.parts[i + 1], vals)));
      } catch {
        return false;
      }
    };
    return groups.every((g) => g.some(holds));
  };

  if (fixed !== undefined) {
    if (ok(fixed)) return fixed;
    throw new SampleError(`[${v.name}] can't satisfy its constraints`);
  }

  let from: number;
  let to: number;
  if (Number.isFinite(lo) && Number.isFinite(hi)) [from, to] = [Math.ceil(lo), Math.floor(hi)];
  else if (Number.isFinite(lo)) [from, to] = [Math.ceil(lo), Math.ceil(lo) + WINDOW];
  else if (Number.isFinite(hi)) [from, to] = [Math.floor(hi) - WINDOW, Math.floor(hi)];
  else [from, to] = [-10, 10];

  if (from <= to) {
    for (let i = 0; i < 300; i++) {
      const x = randInt(from, to);
      if (ok(x)) return x;
    }
  }
  throw new SampleError(`No value of [${v.name}] satisfies its constraints`);
}

function attempt(vars: TemplateVariable[]): {
  values: Map<string, number | string>;
  shown: Map<string, string>;
  arrays: Map<string, string[]>;
} {
  const values = new Map<string, number | string>();
  const arrays = new Map<string, string[]>();
  const usedNames = new Set<string>();
  const takeName = (list: string[]) => {
    const free = list.filter((n) => !usedNames.has(n));
    const name = pick(free.length ? free : list);
    usedNames.add(name);
    return name;
  };

  for (const v of vars) {
    if (v.type === "female_name") values.set(v.name, takeName(FEMALE_NAMES));
    else if (v.type === "male_name") values.set(v.name, takeName(MALE_NAMES));
    else if (v.type === "string") {
      if (!v.values?.length) throw new Error(`[${v.name}] has no strings`);
      values.set(v.name, pick(v.values));
    } else if (v.type === "array") {
      if (!v.rows?.length) throw new Error(`[${v.name}] has no rows`);
      arrays.set(v.name, pick(v.rows));
    }
  }

  // A variable can only be chosen once everything its constraints mention has a value.
  let pending = vars.filter((v) => v.type === "numerical");
  while (pending.length) {
    const ready = pending.filter((v) => dependenciesOf(v).every((d) => values.has(d)));
    if (ready.length === 0) {
      throw new Error(`[${pending[0].name}] depends on a variable that is missing or part of a loop`);
    }
    for (const v of ready) values.set(v.name, sampleNumerical(v, values));
    pending = pending.filter((v) => !ready.includes(v));
  }

  // Computed values come after the random picks and may use each other, in any order.
  const shown = new Map<string, string>();
  for (const [k, v] of values) shown.set(k, typeof v === "number" ? formatNumber(v) : v);
  let toCompute = vars.filter((v) => v.type === "computed");
  const refsOf = (v: TemplateVariable) => [...(v.expression ?? "").matchAll(VAR_RE)].map((m) => m[1]).filter((n) => n !== v.name);
  while (toCompute.length) {
    const ready = toCompute.filter((v) => refsOf(v).every((d) => values.has(d)));
    if (ready.length === 0) {
      throw new Error(`[${toCompute[0].name}] depends on a variable that is missing or part of a loop`);
    }
    for (const v of ready) {
      const body = v.expression ?? "";
      const n = evaluateFormula(body, values);
      if (!Number.isFinite(n)) throw new SampleError(`[${v.name}] = ${body} isn't a finite number`);
      let text = formatNumber(n);
      if (isWholeToFrac(body)) {
        const frac = toFraction(n);
        if (!frac) throw new SampleError(`[${v.name}] = ${body} has no simple fraction form`);
        text = frac;
      }
      values.set(v.name, n);
      shown.set(v.name, text);
    }
    toCompute = toCompute.filter((v) => !ready.includes(v));
  }

  // Array entries may use [variables] and \calc{formulas}, so they are filled in last.
  // An array that uses another array's entries is filled after that one.
  const done = new Map<string, string[]>();
  let waiting = [...arrays.keys()];
  while (waiting.length) {
    const ready = waiting.filter((n) => {
      const need = [...arrayRefsOf([arrays.get(n)!])];
      return need.every((r) => r !== n && (done.has(r) || !arrays.has(r)));
    });
    if (ready.length === 0) throw new Error(`[${waiting[0]}] uses array entries that depend on each other in a loop`);
    // Resolve against the arrays finished before this round, then publish the whole round at once.
    const round = ready.map((n) => [n, arrays.get(n)!.map((e) => resolveEntry(e, values, shown, done))] as const);
    for (const [n, row] of round) done.set(n, row);
    waiting = waiting.filter((n) => !ready.includes(n));
  }
  return { values, shown, arrays: done };
}

/** Fills in a template with random values. Retries when constraints can't be met or two choices come out identical. */
export function generateQuestion(t: TemplateData): GeneratedQuestion {
  let lastProblem = "";
  for (let tries = 0; tries < 100; tries++) {
    let shown: Map<string, string>;
    let arrays: Map<string, string[]>;
    try {
      ({ shown, arrays } = attempt(t.variables));
    } catch (e) {
      if (!(e instanceof SampleError)) throw e;
      lastProblem = e.message;
      continue;
    }
    const choices = t.choices.map((c) => ({ label: c.label, text: fill(c.text, shown, arrays) }));
    if (new Set(choices.map((c) => c.text)).size < choices.length) {
      lastProblem = "Two answer choices came out identical.";
      continue;
    }
    let solution: string | null = null;
    if (t.solution) {
      try {
        solution = resolveCalc(fill(t.solution, shown, arrays), new Map());
      } catch (e) {
        if (!(e instanceof SampleError)) throw e;
        lastProblem = e.message;
        continue;
      }
    }
    return {
      text: fill(t.text, shown, arrays),
      choices,
      correctLabel: t.correct_label,
      solution,
      values: t.variables.map((v) => ({ name: v.name, type: v.type, value: arrays.get(v.name)?.join(" ; ") ?? shown.get(v.name) ?? "" })),
    };
  }
  throw new Error(lastProblem || "Could not generate a valid question.");
}

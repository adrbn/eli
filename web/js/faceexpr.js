// The formula language of .eliface faces: numbers, names, + - * /, comparisons, && || !, a ternary and a few pure
// functions. A formula compiles once to a closure over an env object and can reach nothing else.

// Signed distance to a rounded box (negative inside): the same arithmetic as sdBox in themes.js.
export function box(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

const FUNCS = {
  min: [2, Math.min], max: [2, Math.max], clamp: [3, (v, lo, hi) => Math.min(hi, Math.max(lo, v))],
  abs: [1, Math.abs], floor: [1, Math.floor], mod: [2, (a, b) => a % b], sin: [1, Math.sin], cos: [1, Math.cos],
  hypot: [2, Math.hypot], sqrt: [1, Math.sqrt], sq: [1, (a) => a ** 2], box: [5, box],
};
const CONSTS = { pi: Math.PI };
const MAX_DEPTH = 32; // nested parentheses, ternaries and unary signs: the ESP32 evaluator has a small stack
const BIN = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];
const OPS = {
  '||': (a, b) => (e) => (a(e) || b(e) ? 1 : 0), '&&': (a, b) => (e) => (a(e) && b(e) ? 1 : 0),
  '==': (a, b) => (e) => (a(e) === b(e) ? 1 : 0), '!=': (a, b) => (e) => (a(e) !== b(e) ? 1 : 0),
  '<': (a, b) => (e) => (a(e) < b(e) ? 1 : 0), '<=': (a, b) => (e) => (a(e) <= b(e) ? 1 : 0),
  '>': (a, b) => (e) => (a(e) > b(e) ? 1 : 0), '>=': (a, b) => (e) => (a(e) >= b(e) ? 1 : 0),
  '+': (a, b) => (e) => a(e) + b(e), '-': (a, b) => (e) => a(e) - b(e),
  '*': (a, b) => (e) => a(e) * b(e), '/': (a, b) => (e) => a(e) / b(e),
};
const TOKEN = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/!<>?:(),]))/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const at = TOKEN.lastIndex, m = TOKEN.exec(src);
    if (!m) {
      const rest = src.slice(at);
      if (!rest.trim()) break;
      throw new Error(`unexpected '${rest.trim()[0]}' at ${at + rest.length - rest.trimStart().length}`);
    }
    const pos = TOKEN.lastIndex - m[0].trimStart().length;
    out.push(m[1] !== undefined ? { num: Number(m[1]), at: pos } : m[2] ? { name: m[2], at: pos } : { op: m[3], at: pos });
  }
  return out;
}

export function compileExpr(src, names) {
  if (typeof src === 'number' && Number.isFinite(src)) return () => src;
  if (typeof src !== 'string') throw new Error('a formula is a string or a number');
  const toks = tokenize(src);
  let i = 0, depth = 0;
  const fail = (msg) => { throw new Error(msg) };
  const show = (t) => t.op ?? t.name ?? String(t.num);
  const take = (op) => (toks[i]?.op === op ? (i++, true) : false);
  const expect = (op) => take(op) || fail(toks[i] ? `expected '${op}' at ${toks[i].at}` : `expected '${op}' at the end`);

  const nested = (parse) => () => {
    if (++depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH}`);
    const fn = parse();
    depth--;
    return fn;
  };
  const ternary = nested(() => {
    const c = level(0);
    if (!take('?')) return c;
    const a = ternary();
    expect(':');
    const b = ternary();
    return (e) => (c(e) ? a(e) : b(e));
  });
  const level = (k) => {
    if (k === BIN.length) return unary();
    let left = level(k + 1);
    while (BIN[k].includes(toks[i]?.op)) {
      const op = toks[i++].op;
      left = OPS[op](left, level(k + 1));
    }
    return left;
  };
  const unary = nested(() => {
    if (take('-')) { const a = unary(); return (e) => -a(e) }
    if (take('!')) { const a = unary(); return (e) => (a(e) ? 0 : 1) }
    return primary();
  });
  const primary = () => {
    const t = toks[i++] ?? fail('unexpected end');
    if (t.num !== undefined) { const v = t.num; return () => v }
    if (t.op === '(') { const a = ternary(); expect(')'); return a }
    if (!t.name) return fail(`unexpected '${show(t)}' at ${t.at}`);
    if (toks[i]?.op === '(') {
      i++;
      if (!Object.hasOwn(FUNCS, t.name)) fail(`unknown function '${t.name}'`);
      const [arity, fn] = FUNCS[t.name], args = [];
      if (!take(')')) {
        do args.push(ternary()); while (take(','));
        expect(')');
      }
      if (args.length !== arity) fail(`'${t.name}' takes ${arity} argument${arity > 1 ? 's' : ''}`);
      if (arity === 1) { const [a] = args; return (e) => fn(a(e)) }
      if (arity === 2) { const [a, b] = args; return (e) => fn(a(e), b(e)) }
      return (e) => fn(...args.map((a) => a(e)));
    }
    if (Object.hasOwn(CONSTS, t.name)) { const v = CONSTS[t.name]; return () => v }
    if (!names.has(t.name)) fail(`unknown name '${t.name}'`);
    const name = t.name;
    return (e) => e[name];
  };

  const fn = ternary();
  if (i < toks.length) fail(`unexpected '${show(toks[i])}' at ${toks[i].at}`);
  return fn;
}

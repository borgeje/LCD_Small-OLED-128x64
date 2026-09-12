/*
 * lexer.js - preprocessor + tokenizer for the C++ subset Arduino sketches use.
 *
 * Two passes. preprocess() resolves #define / #ifdef / #include at the line
 * level, blanking directive lines rather than deleting them so every later
 * stage still reports the user's original line numbers. tokenize() then
 * produces a flat token stream, and macros are expanded on that stream --
 * which is what makes function-like macros such as
 * #define MIN(a,b) ((a)<(b)?(a):(b)) work.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).lexer = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class CompileError extends Error {
    constructor(message, line, col) {
      super(message);
      this.name = "CompileError";
      this.line = line;
      this.col = col;
    }
  }

  const KEYWORDS = new Set([
    "if", "else", "for", "while", "do", "switch", "case", "default", "break",
    "continue", "return", "struct", "class", "enum", "typedef", "sizeof",
    "const", "static", "volatile", "unsigned", "signed", "public", "private",
    "protected", "new", "delete", "true", "false", "void", "bool", "boolean",
    "char", "int", "long", "short", "float", "double", "byte", "word",
    "size_t", "String", "auto", "PROGMEM", "inline", "extern", "register",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "int8_t", "int16_t", "int32_t", "int64_t",
  ]);

  // Longest-first so that ">>=" beats ">>" beats ">".
  const OPERATORS = [
    ">>=", "<<=", "...",
    "==", "!=", "<=", ">=", "&&", "||", "++", "--", "->", "<<", ">>",
    "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "::",
    "+", "-", "*", "/", "%", "=", "<", ">", "!", "~", "&", "|", "^",
    "?", ":", ";", ",", ".", "(", ")", "[", "]", "{", "}", "#",
  ];

  /* ------------------------------------------------------------------ *
   * Comment stripping, done first and preserving newlines.
   * ------------------------------------------------------------------ */
  function stripComments(src) {
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "/" && d === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") out += "\n";
          i++;
        }
        i += 2;
      } else if (c === '"' || c === "'") {
        const quote = c;
        out += src[i++];
        while (i < n && src[i] !== quote) {
          if (src[i] === "\\") out += src[i++];
          if (i < n) out += src[i++];
        }
        if (i < n) out += src[i++];
      } else {
        out += src[i++];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Preprocessor
   * ------------------------------------------------------------------ */
  function preprocess(src) {
    const clean = stripComments(src);
    // A backslash continuation folds the next line up into this one; emit a
    // marker newline afterwards so the running line count stays correct.
    const lines = clean.split("\n");
    const folded = [];
    for (let i = 0; i < lines.length; i++) {
      let cur = lines[i];
      let extra = 0;
      while (/\\\s*$/.test(cur) && i + 1 < lines.length) {
        cur = cur.replace(/\\\s*$/, " ") + lines[++i];
        extra++;
      }
      folded.push(cur);
      for (let k = 0; k < extra; k++) folded.push("");
    }

    const defines = new Map();
    const includes = [];
    const out = [];
    const stack = [];

    const active = () => stack.every((f) => f.active);

    for (const raw of folded) {
      const t = raw.trim();

      if (t.startsWith("#")) {
        const m = t.match(/^#\s*(\w+)\s*([\s\S]*)$/);
        const directive = m ? m[1] : "";
        const rest = m ? m[2].trim() : "";

        switch (directive) {
          case "include":
            if (active()) {
              const inc = rest.match(/[<"]([^>"]+)[>"]/);
              if (inc) includes.push(inc[1]);
            }
            break;
          case "define":
            if (active()) {
              const fn = rest.match(/^(\w+)\(([^)]*)\)\s*([\s\S]*)$/);
              if (fn) {
                defines.set(fn[1], {
                  params: fn[2].trim() ? fn[2].split(",").map((s) => s.trim()) : [],
                  body: fn[3].trim(),
                  fn: true,
                });
              } else {
                const ob = rest.match(/^(\w+)\s*([\s\S]*)$/);
                if (ob) defines.set(ob[1], { body: ob[2].trim(), fn: false });
              }
            }
            break;
          case "undef":
            if (active()) defines.delete(rest.split(/\s/)[0]);
            break;
          case "ifdef":
            stack.push({ active: defines.has(rest), taken: defines.has(rest) });
            break;
          case "ifndef":
            stack.push({ active: !defines.has(rest), taken: !defines.has(rest) });
            break;
          case "if": {
            const v = evalPPExpr(rest, defines);
            stack.push({ active: v, taken: v });
            break;
          }
          case "elif": {
            const f = stack[stack.length - 1];
            if (f) {
              if (f.taken) {
                f.active = false;
              } else {
                const v = evalPPExpr(rest, defines);
                f.active = v;
                f.taken = f.taken || v;
              }
            }
            break;
          }
          case "else": {
            const f = stack[stack.length - 1];
            if (f) {
              f.active = !f.taken;
              f.taken = true;
            }
            break;
          }
          case "endif":
            stack.pop();
            break;
          default:
            break; // #pragma, #error, #line - ignored
        }
        out.push("");
      } else {
        out.push(active() ? raw : "");
      }
    }

    return { source: out.join("\n"), defines, includes };
  }

  // Enough of #if to handle the guards real sketches carry.
  function evalPPExpr(expr, defines) {
    let e = expr.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (defines.has(n) ? "1" : "0"));
    e = e.replace(/defined\s+(\w+)/g, (_, n) => (defines.has(n) ? "1" : "0"));
    e = e.replace(/\b([A-Za-z_]\w*)\b/g, (mm) => {
      if (defines.has(mm)) {
        const d = defines.get(mm);
        return /^-?\d+$/.test(d.body) ? d.body : "0";
      }
      return "0";
    });
    if (!/^[\d\s()+\-*/%<>=!&|^~]*$/.test(e)) return false;
    try {
      // eslint-disable-next-line no-new-func
      return !!Function('"use strict";return (' + (e.trim() || "0") + ")")();
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Tokenizer
   * ------------------------------------------------------------------ */
  function tokenize(src) {
    const tokens = [];
    let i = 0;
    let line = 1;
    let col = 1;
    const n = src.length;

    const push = (type, value, l, c) => tokens.push({ type, value, line: l, col: c });

    while (i < n) {
      const c = src[i];

      if (c === "\n") {
        i++;
        line++;
        col = 1;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        i++;
        col++;
        continue;
      }

      const startLine = line;
      const startCol = col;

      if (c === '"') {
        let s = "";
        i++;
        col++;
        while (i < n && src[i] !== '"') {
          if (src[i] === "\\") {
            i++;
            col++;
            s += unescapeChar(src[i]);
          } else {
            s += src[i];
          }
          i++;
          col++;
        }
        i++;
        col++;
        push("str", s, startLine, startCol);
        continue;
      }

      if (c === "'") {
        i++;
        col++;
        let v;
        if (src[i] === "\\") {
          i++;
          col++;
          v = unescapeChar(src[i]).charCodeAt(0);
        } else {
          v = src.charCodeAt(i);
        }
        i++;
        col++;
        if (src[i] === "'") {
          i++;
          col++;
        }
        push("char", v, startLine, startCol);
        continue;
      }

      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
        if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
          let s = "";
          i += 2;
          col += 2;
          while (i < n && /[0-9a-fA-F]/.test(src[i])) { s += src[i++]; col++; }
          push("num", { value: parseInt(s, 16), isFloat: false }, startLine, startCol);
        } else if (c === "0" && (src[i + 1] === "b" || src[i + 1] === "B")) {
          let b = "";
          i += 2;
          col += 2;
          while (i < n && /[01]/.test(src[i])) { b += src[i++]; col++; }
          push("num", { value: parseInt(b, 2), isFloat: false }, startLine, startCol);
        } else {
          let s = "";
          let isFloat = false;
          while (i < n && /[0-9]/.test(src[i])) { s += src[i++]; col++; }
          if (src[i] === ".") {
            isFloat = true;
            s += src[i++];
            col++;
            while (i < n && /[0-9]/.test(src[i])) { s += src[i++]; col++; }
          }
          if (src[i] === "e" || src[i] === "E") {
            isFloat = true;
            s += src[i++];
            col++;
            if (src[i] === "+" || src[i] === "-") { s += src[i++]; col++; }
            while (i < n && /[0-9]/.test(src[i])) { s += src[i++]; col++; }
          }
          push("num", { value: parseFloat(s), isFloat }, startLine, startCol);
        }
        // Numeric suffixes: UL, LL, f, u ...
        while (i < n && /[uUlLfF]/.test(src[i])) {
          if (/[fF]/.test(src[i])) tokens[tokens.length - 1].value.isFloat = true;
          i++;
          col++;
        }
        continue;
      }

      if (/[A-Za-z_]/.test(c)) {
        let s = "";
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) { s += src[i++]; col++; }
        push(KEYWORDS.has(s) ? "kw" : "ident", s, startLine, startCol);
        continue;
      }

      let matched = null;
      for (const op of OPERATORS) {
        if (src.startsWith(op, i)) { matched = op; break; }
      }
      if (matched) {
        push("op", matched, startLine, startCol);
        i += matched.length;
        col += matched.length;
        continue;
      }

      throw new CompileError("Unexpected character '" + c + "'", line, col);
    }

    push("eof", null, line, col);
    return mergeStrings(tokens);
  }

  function unescapeChar(c) {
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      default: return c;
    }
  }

  // Adjacent string literals concatenate, as in C.
  function mergeStrings(tokens) {
    const out = [];
    for (const t of tokens) {
      const prev = out[out.length - 1];
      if (t.type === "str" && prev && prev.type === "str") prev.value += t.value;
      else out.push(t);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Macro expansion over the token stream
   * ------------------------------------------------------------------ */
  function expandMacros(tokens, defines, depth) {
    depth = depth || 0;
    if (depth > 16 || defines.size === 0) return tokens;

    let changed = false;
    const out = [];
    let i = 0;

    while (i < tokens.length) {
      const t = tokens[i];
      if ((t.type === "ident" || t.type === "kw") && defines.has(t.value)) {
        const macro = defines.get(t.value);

        if (macro.fn) {
          const next = tokens[i + 1];
          if (next && next.type === "op" && next.value === "(") {
            const args = [];
            let j = i + 2;
            let cur = [];
            let par = 0;
            while (j < tokens.length) {
              const tk = tokens[j];
              if (tk.type === "op" && (tk.value === "(" || tk.value === "[")) par++;
              else if (tk.type === "op" && (tk.value === ")" || tk.value === "]")) {
                if (par === 0 && tk.value === ")") break;
                par--;
              }
              if (tk.type === "op" && tk.value === "," && par === 0) {
                args.push(cur);
                cur = [];
              } else {
                cur.push(tk);
              }
              j++;
            }
            if (cur.length || args.length) args.push(cur);

            const bodyTokens = macro.body ? tokenize(macro.body).slice(0, -1) : [];
            for (const bt of bodyTokens) {
              const pi = macro.params.indexOf(bt.value);
              if ((bt.type === "ident" || bt.type === "kw") && pi >= 0) {
                for (const at of args[pi] || []) {
                  out.push(Object.assign({}, at, { line: t.line, col: t.col }));
                }
              } else {
                out.push(Object.assign({}, bt, { line: t.line, col: t.col }));
              }
            }
            i = j + 1;
            changed = true;
            continue;
          }
        } else {
          const bodyTokens = macro.body ? tokenize(macro.body).slice(0, -1) : [];
          for (const bt of bodyTokens) {
            out.push(Object.assign({}, bt, { line: t.line, col: t.col }));
          }
          i++;
          changed = true;
          continue;
        }
      }
      out.push(t);
      i++;
    }

    return changed ? expandMacros(out, defines, depth + 1) : out;
  }

  function lex(src) {
    const pre = preprocess(src);
    const tokens = tokenize(pre.source);
    const expanded = expandMacros(tokens, pre.defines, 0);
    return { tokens: expanded, includes: pre.includes, defines: pre.defines };
  }

  return { lex, tokenize, preprocess, CompileError, KEYWORDS };
});

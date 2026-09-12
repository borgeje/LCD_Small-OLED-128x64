/*
 * interpreter.js - tree-walking evaluator for the parsed sketch.
 *
 * Every eval function is a generator. That is the whole trick: delay() and
 * display.display() suspend the sketch mid-expression and hand control back to
 * the driver, which advances a virtual clock and paints a frame. So a sketch
 * animates in the simulator at the same rate it would on the panel, and it can
 * be paused, stepped a frame at a time, or run at 10x -- without the sketch
 * knowing anything about it.
 *
 * Values are tagged: { t: "num" | "str" | "arr" | "struct" | "obj" | "ptr" |
 * "func" | "void", ... }. Integer width and signedness live on the variable
 * cell rather than the value, and are applied on store, which is what makes
 * `uint8_t x = 300` wrap to 44 the way it does on the device.
 */
(function (root, factory) {
  const mod = factory(
    typeof module === "object" && module.exports
      ? require("./lexer.js")
      : root.OLEDSim.lexer
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).interpreter = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (lexer) {
  "use strict";

  const CompileError = lexer.CompileError;

  class RuntimeError extends Error {
    constructor(message, line) {
      super(message);
      this.name = "RuntimeError";
      this.line = line;
    }
  }

  /* ---------------- values ---------------- */

  const VOID = { t: "void" };

  const num = (v, isFloat) => ({ t: "num", v, isFloat: !!isFloat });
  const str = (v) => ({ t: "str", v });
  const bool = (v) => ({ t: "num", v: v ? 1 : 0, isFloat: false });

  const INT_SPECS = {
    bool: { bits: 8, unsigned: true, int: true },
    boolean: { bits: 8, unsigned: true, int: true },
    char: { bits: 8, unsigned: false, int: true },
    byte: { bits: 8, unsigned: true, int: true },
    uint8_t: { bits: 8, unsigned: true, int: true },
    int8_t: { bits: 8, unsigned: false, int: true },
    uint16_t: { bits: 16, unsigned: true, int: true },
    int16_t: { bits: 16, unsigned: false, int: true },
    word: { bits: 16, unsigned: true, int: true },
    short: { bits: 16, unsigned: false, int: true },
    int: { bits: 32, unsigned: false, int: true },
    uint32_t: { bits: 32, unsigned: true, int: true },
    int32_t: { bits: 32, unsigned: false, int: true },
    long: { bits: 32, unsigned: false, int: true },
    size_t: { bits: 32, unsigned: true, int: true },
    uint64_t: { bits: 32, unsigned: true, int: true },
    int64_t: { bits: 32, unsigned: false, int: true },
    float: { int: false },
    double: { int: false },
    String: { str: true },
    void: {},
  };

  function specInfo(spec) {
    if (!spec) return { bits: 32, unsigned: false, int: true };
    if (spec.pointer > 0 || spec.reference) return { ptr: true };
    const base = INT_SPECS[spec.base];
    if (!base) return { object: true, name: spec.base };
    if (base.int && spec.unsigned) return { bits: base.bits, unsigned: true, int: true };
    return base;
  }

  // Truncate and wrap on store, exactly as the device would.
  function coerce(value, spec) {
    const info = specInfo(spec);
    if (!value) return value;
    if (info.str) {
      return str(valueToString(value));
    }
    if (value.t !== "num") return value;
    if (info.int === false) return num(value.v, true);
    if (!info.int) return value;

    let v = Math.trunc(value.v);
    if (!isFinite(v)) v = 0;
    const bits = info.bits || 32;
    if (bits >= 32) {
      v = info.unsigned ? v >>> 0 : v | 0;
    } else {
      const mask = (1 << bits) - 1;
      v &= mask;
      if (!info.unsigned && v & (1 << (bits - 1))) v -= 1 << bits;
    }
    return num(v, false);
  }

  function truthy(value) {
    if (!value) return false;
    switch (value.t) {
      case "num": return value.v !== 0;
      case "str": return value.v.length > 0;
      case "ptr": return !!value.ref;
      case "void": return false;
      default: return true;
    }
  }

  function asNumber(value, line) {
    if (!value) return 0;
    if (value.t === "num") return value.v;
    if (value.t === "str") {
      const p = parseFloat(value.v);
      return isNaN(p) ? 0 : p;
    }
    if (value.t === "ptr") return 1;
    if (value.t === "arr") return 1;
    if (value.t === "void") return 0;
    return 0;
  }

  // Arduino's Print semantics: floats default to 2 decimals, ints honour a base.
  function formatNumber(value, arg2) {
    if (value.t !== "num") return valueToString(value);
    if (arg2 !== undefined && arg2 !== null) {
      const b = asNumber(arg2);
      if (!value.isFloat && (b === 2 || b === 8 || b === 10 || b === 16)) {
        let n = Math.trunc(value.v);
        if (n < 0) n = n >>> 0;
        return n.toString(b).toUpperCase();
      }
      if (value.isFloat) return value.v.toFixed(Math.max(0, Math.trunc(b)));
      return String(Math.trunc(value.v));
    }
    if (value.isFloat) return value.v.toFixed(2);
    return String(Math.trunc(value.v));
  }

  function valueToString(value) {
    if (!value) return "";
    switch (value.t) {
      case "str": return value.v;
      case "num": return value.isFloat ? value.v.toFixed(2) : String(Math.trunc(value.v));
      case "arr":
        // A char array used as a string.
        return value.elems
          .map((c) => (c.v && c.v.t === "num" ? String.fromCharCode(c.v.v) : ""))
          .join("")
          .replace(/\0.*$/, "");
      case "void": return "";
      default: return "[object]";
    }
  }

  function cloneValue(value) {
    if (!value) return value;
    // Instances are handled as references throughout: `Widget *w = x` is the
    // shape real firmware uses, and silently copying a polymorphic object
    // would be the wrong answer far more often than the right one.
    if (value.t === "instance") return value;
    if (value.t === "struct") {
      const fields = {};
      for (const k of Object.keys(value.fields)) {
        fields[k] = { v: cloneValue(value.fields[k].v), spec: value.fields[k].spec };
      }
      return { t: "struct", name: value.name, fields };
    }
    if (value.t === "arr") {
      return {
        t: "arr",
        spec: value.spec,
        elems: value.elems.map((c) => ({ v: cloneValue(c.v), spec: c.spec })),
      };
    }
    return value;
  }

  /* ---------------- scopes ---------------- */

  class Scope {
    constructor(parent) {
      this.vars = new Map();
      this.parent = parent || null;
    }
    lookup(name) {
      let s = this;
      while (s) {
        const c = s.vars.get(name);
        if (c) return c;
        s = s.parent;
      }
      return null;
    }
    declare(name, cell) {
      this.vars.set(name, cell);
      return cell;
    }
  }

  /* ---------------- interpreter ---------------- */

  class Interpreter {
    constructor(options) {
      options = options || {};
      this.global = new Scope(null);
      this.functions = new Map();
      this.structs = new Map();
      this.classes = new Map();
      this.staticCells = new Map();
      // The receiver of the method currently executing, so a method can call
      // a sibling method without writing `this->`.
      this.thisStack = [];

      this.micros = 0; // virtual clock, microseconds
      this.steps = 0;
      this.stepsSinceYield = 0;
      this.yieldEvery = options.yieldEvery || 50000;
      this.maxStepsPerLoop = options.maxStepsPerLoop || 40000000;

      this.serial = []; // { t: ms, text }
      this.serialBuffer = "";
      this.maxSerialLines = options.maxSerialLines || 500;

      this.display = null; // set by runtime
      this.io = {
        analog: {},
        digital: {},
        pinModes: {},
        pinsRead: new Set(),      // union, for callers that just want "used"
        analogPins: new Set(),    // read via analogRead -> needs a slider
        digitalPins: new Set(),   // read via digitalRead -> needs a switch
        pinsWritten: new Set(),
      };
      this.randomState = 12345;
      this.onEvent = options.onEvent || null;
    }

    millisNow() {
      return Math.floor(this.micros / 1000);
    }

    /*
     * Turn an unknown name into a useful message. A sketch written against an
     * unemulated library otherwise fails as "U8G2_R0 is not declared", which
     * sends you hunting for a typo instead of telling you the library is the
     * problem. Populated by the runtime.
     */
    explainUnknown(name, kind) {
      if (this.unknownHint) {
        const hint = this.unknownHint(name, kind);
        if (hint) return hint;
      }
      return (
        "'" + name + (kind === "call" ? "()" : "") + "' is not " +
        (kind === "call" ? "defined in this sketch and is not emulated" : "declared") +
        ". See simulator/README.md for the supported API."
      );
    }

    log(text) {
      this.serialBuffer += text;
      let idx;
      while ((idx = this.serialBuffer.indexOf("\n")) >= 0) {
        const line = this.serialBuffer.slice(0, idx);
        this.serialBuffer = this.serialBuffer.slice(idx + 1);
        this.serial.push({ t: this.millisNow(), text: line });
        if (this.serial.length > this.maxSerialLines) this.serial.shift();
      }
    }

    flushSerial() {
      if (this.serialBuffer.length) {
        this.serial.push({ t: this.millisNow(), text: this.serialBuffer });
        this.serialBuffer = "";
        if (this.serial.length > this.maxSerialLines) this.serial.shift();
      }
    }

    // Deterministic PRNG so a run is reproducible frame to frame.
    nextRandom() {
      this.randomState = (this.randomState * 1103515245 + 12345) & 0x7fffffff;
      return this.randomState / 0x7fffffff;
    }

    /* ---- program loading ---- */

    load(program) {
      this.program = program;

      for (const decl of program.decls) {
        if (decl.type === "FuncDecl") {
          this.functions.set(decl.name, decl);
        } else if (decl.type === "StructDecl" && decl.name) {
          this.structs.set(decl.name, decl);
          this.classes.set(decl.name, {
            name: decl.name,
            base: decl.base || null,
            members: decl.members || [],
            methods: new Map((decl.methods || []).map((m) => [m.name, m])),
            ctor: decl.ctor || null,
          });
        }
      }

      // A second pass, because `void Foo::bar() {}` may appear before or
      // after the class body that declared bar.
      for (const decl of program.decls) {
        if (decl.type !== "MethodDef") continue;
        const cls = this.classes.get(decl.className);
        if (!cls) {
          throw new RuntimeError(
            "'" + decl.className + "::" + decl.decl.name +
              "' has no matching class declaration",
            decl.line
          );
        }
        if (decl.decl.type === "CtorDecl") cls.ctor = decl.decl;
        else cls.methods.set(decl.decl.name, decl.decl);
      }

      return this;
    }

    /* ---- classes ---- */

    classChain(className) {
      const chain = [];
      const seen = new Set();
      let name = className;
      while (name && this.classes.has(name) && !seen.has(name)) {
        seen.add(name);
        chain.unshift(this.classes.get(name));
        name = this.classes.get(name).base;
      }
      return chain;
    }

    findMethod(className, methodName) {
      const chain = this.classChain(className);
      // Most-derived wins, which is what makes every call dynamically bound.
      for (let i = chain.length - 1; i >= 0; i--) {
        const m = chain[i].methods.get(methodName);
        if (m) return m;
      }
      return null;
    }

    *instantiate(className, args, line, depth) {
      depth = depth || 0;
      if (depth > 8) {
        throw new RuntimeError(
          "'" + className + "' contains itself by value - use a pointer", line
        );
      }
      const chain = this.classChain(className);
      if (!chain.length) {
        throw new RuntimeError("'" + className + "' is not a known class", line);
      }

      const inst = { t: "instance", className, fields: {} };

      // Data members, base class first, so a derived field of the same name
      // ends up on top the way C++ shadowing does.
      for (const cls of chain) {
        for (const m of cls.members) {
          if (m.type !== "VarDecl") continue;
          for (const d of m.declarators) {
            let value;
            if (d.arrayDims.length) {
              const dims = [];
              for (const dim of d.arrayDims) {
                dims.push(dim ? Math.trunc(asNumber(yield* this.evalExpr(dim, this.global))) : 0);
              }
              value = d.init && d.init.type === "InitList"
                ? yield* this.buildArrayFromInit(d.init, dims, m.spec, this.global)
                : this.makeArray(dims, m.spec);
            } else if (d.init) {
              value = coerce(yield* this.evalExpr(d.init, this.global), m.spec);
            } else if (!m.spec.pointer && !d.pointer && this.classes.has(m.spec.base)) {
              value = yield* this.instantiate(m.spec.base, [], line, depth + 1);
            } else {
              value = this.defaultValue(m.spec, d.pointer);
            }
            inst.fields[d.name] = { v: value, spec: m.spec };
          }
        }
      }

      yield* this.runCtor(inst, chain[chain.length - 1], args, line);
      return inst;
    }

    *runCtor(inst, cls, args, line) {
      const ctor = cls.ctor;

      if (!ctor) {
        if (cls.base && this.classes.has(cls.base)) {
          yield* this.runCtor(inst, this.classes.get(cls.base), [], line);
        }
        return;
      }

      // One scope for both the member-initialiser list and the body: an
      // initialiser like `: display(display)` has to see the parameter, and a
      // parameter that shares a field's name must shadow it, exactly as in C++.
      const scope = this.makeReceiverScope(inst);
      yield* this.bindParams(scope, ctor.params, args);

      let baseDone = false;
      for (const init of ctor.inits || []) {
        if (cls.base && init.name === cls.base) {
          const baseArgs = [];
          for (const a of init.args) baseArgs.push(yield* this.evalExpr(a, scope));
          yield* this.runCtor(inst, this.classes.get(cls.base), baseArgs, line);
          baseDone = true;
          continue;
        }
        const cell = inst.fields[init.name];
        if (!cell) {
          throw new RuntimeError(
            "'" + init.name + "' is not a member of " + cls.name, init.line || line
          );
        }
        if (init.args.length) {
          cell.v = coerce(yield* this.evalExpr(init.args[0], scope), cell.spec);
        }
      }
      if (!baseDone && cls.base && this.classes.has(cls.base)) {
        yield* this.runCtor(inst, this.classes.get(cls.base), [], line);
      }

      if (ctor.body) {
        this.thisStack.push(inst);
        try {
          yield* this.execBlock(ctor.body, scope);
        } finally {
          this.thisStack.pop();
        }
      }
    }

    // A scope in which the receiver's fields are visible as bare names.
    makeReceiverScope(inst) {
      const scope = new Scope(this.global);
      for (const name of Object.keys(inst.fields)) {
        scope.declare(name, inst.fields[name]);
      }
      scope.declare("this", {
        v: { t: "ptr", ref: { get: () => inst, set: () => {} } },
        spec: { base: inst.className, pointer: 1 },
      });
      return scope;
    }

    *bindParams(scope, params, argValues) {
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (!p.name || p.variadic) continue;
        let v = argValues[i];
        if (v === undefined) {
          v = p.defaultValue ? yield* this.evalExpr(p.defaultValue, scope) : num(0, false);
        }
        if (
          p.reference || p.pointer > 0 ||
          (v && (v.t === "arr" || v.t === "obj" || v.t === "ptr" || v.t === "instance"))
        ) {
          scope.declare(p.name, { v, spec: p.spec, byRef: true });
        } else {
          scope.declare(p.name, { v: coerce(cloneValue(v), p.spec), spec: p.spec });
        }
      }
    }

    *callMethod(inst, decl, args) {
      if (decl.pure || !decl.body) {
        throw new RuntimeError(
          "'" + inst.className + "::" + decl.name + "()' is declared but never defined" +
            (decl.pure ? " (it is pure virtual - override it in the subclass)" : ""),
          decl.line
        );
      }
      const scope = this.makeReceiverScope(inst);
      yield* this.bindParams(scope, decl.params, args);

      this.thisStack.push(inst);
      let sig;
      try {
        sig = yield* this.execBlock(decl.body, scope);
      } finally {
        this.thisStack.pop();
      }
      if (sig && sig.sig === "return") {
        return sig.value === undefined ? VOID : coerce(sig.value, decl.retType);
      }
      return VOID;
    }

    *initGlobals() {
      for (const decl of this.program.decls) {
        if (decl.type === "VarDecl") yield* this.execVarDecl(decl, this.global);
        else if (decl.type === "EnumDecl") this.declareEnum(decl, this.global);
        else if (decl.type === "StructDecl") {
          for (const vname of decl.vars || []) {
            const v = this.classes.has(decl.name)
              ? yield* this.instantiate(decl.name, [], decl.line || 0)
              : this.makeStruct(decl.name);
            this.global.declare(vname, { v, spec: { base: decl.name } });
          }
        }
      }
    }

    declareEnum(decl, scope) {
      let auto = 0;
      for (const e of decl.entries) {
        let v = auto;
        if (e.value) {
          const res = runSync(this.evalExpr(e.value, scope));
          v = asNumber(res);
        }
        auto = v + 1;
        scope.declare(e.name, { v: num(v, false), spec: { base: "int", isConst: true } });
      }
    }

    hasFunction(name) {
      return this.functions.has(name);
    }

    *callFunctionByName(name, args) {
      const fn = this.functions.get(name);
      if (!fn) throw new RuntimeError("Sketch has no function '" + name + "()'", 0);
      return yield* this.callFunction(fn, args || []);
    }

    *callFunction(decl, argValues) {
      // Arrays, objects and references alias; everything else copies.
      const scope = new Scope(this.global);
      yield* this.bindParams(scope, decl.params, argValues);

      const sig = yield* this.execBlock(decl.body, scope);
      if (sig && sig.sig === "return") {
        return sig.value === undefined ? VOID : coerce(sig.value, decl.retType);
      }
      return VOID;
    }

    /* ---- statements ---- */

    *execBlock(block, parentScope) {
      const scope = new Scope(parentScope);
      for (const stmt of block.body) {
        const sig = yield* this.execStatement(stmt, scope);
        if (sig) return sig;
      }
      return null;
    }

    *execStatement(stmt, scope) {
      // Step accounting is inlined rather than delegated: at one extra
      // generator frame per AST node it dominated the interpreter's cost.
      this.steps++;
      if (++this.stepsSinceYield >= this.yieldEvery) {
        this.stepsSinceYield = 0;
        yield { kind: "tick" };
      }

      switch (stmt.type) {
        case "Block":
          return yield* this.execBlock(stmt, scope);

        case "VarDecl":
          yield* this.execVarDecl(stmt, scope);
          return null;

        case "StructDecl":
          if (stmt.name) this.structs.set(stmt.name, stmt);
          return null;

        case "EnumDecl":
          this.declareEnum(stmt, scope);
          return null;

        case "ExprStmt":
          yield* this.evalExpr(stmt.expr, scope);
          return null;

        case "Empty":
          return null;

        case "If": {
          const c = yield* this.evalExpr(stmt.cond, scope);
          if (truthy(c)) return yield* this.execStatement(stmt.consequent, scope);
          if (stmt.alternate) return yield* this.execStatement(stmt.alternate, scope);
          return null;
        }

        case "While": {
          for (;;) {
            const c = yield* this.evalExpr(stmt.cond, scope);
            if (!truthy(c)) break;
            const sig = yield* this.execStatement(stmt.body, scope);
            if (sig) {
              if (sig.sig === "break") break;
              if (sig.sig === "continue") continue;
              return sig;
            }
          }
          return null;
        }

        case "DoWhile": {
          for (;;) {
            const sig = yield* this.execStatement(stmt.body, scope);
            if (sig) {
              if (sig.sig === "break") break;
              if (sig.sig !== "continue") return sig;
            }
            const c = yield* this.evalExpr(stmt.cond, scope);
            if (!truthy(c)) break;
          }
          return null;
        }

        case "For": {
          const forScope = new Scope(scope);
          if (stmt.init) {
            if (stmt.init.type === "VarDecl") yield* this.execVarDecl(stmt.init, forScope);
            else yield* this.execStatement(stmt.init, forScope);
          }
          for (;;) {
            if (stmt.cond) {
              const c = yield* this.evalExpr(stmt.cond, forScope);
              if (!truthy(c)) break;
            }
            const sig = yield* this.execStatement(stmt.body, forScope);
            if (sig) {
              if (sig.sig === "break") break;
              if (sig.sig !== "continue") return sig;
            }
            if (stmt.update) yield* this.evalExpr(stmt.update, forScope);
          }
          return null;
        }

        case "Switch": {
          const disc = yield* this.evalExpr(stmt.disc, scope);
          const swScope = new Scope(scope);
          let start = -1;
          let defaultIdx = -1;
          for (let i = 0; i < stmt.body.length; i++) {
            const node = stmt.body[i];
            if (node.type !== "Case") continue;
            if (node.test === null) {
              defaultIdx = i;
              continue;
            }
            const t = yield* this.evalExpr(node.test, swScope);
            if (asNumber(t) === asNumber(disc)) {
              start = i;
              break;
            }
          }
          if (start < 0) start = defaultIdx;
          if (start < 0) return null;
          for (let i = start; i < stmt.body.length; i++) {
            const node = stmt.body[i];
            if (node.type === "Case") continue;
            const sig = yield* this.execStatement(node, swScope);
            if (sig) {
              if (sig.sig === "break") return null;
              return sig;
            }
          }
          return null;
        }

        case "Return": {
          const value = stmt.arg ? yield* this.evalExpr(stmt.arg, scope) : undefined;
          return { sig: "return", value };
        }

        case "Break":
          return { sig: "break" };
        case "Continue":
          return { sig: "continue" };

        case "FuncDecl":
          this.functions.set(stmt.name, stmt);
          return null;

        default:
          throw new RuntimeError("Cannot execute " + stmt.type, stmt.line);
      }
    }

    makeStruct(name) {
      const decl = this.structs.get(name);
      const fields = {};
      if (decl) {
        for (const m of decl.members) {
          if (m.type !== "VarDecl") continue;
          for (const d of m.declarators) {
            fields[d.name] = {
              v: d.arrayDims.length
                ? this.makeArray(d.arrayDims.map(() => 0), m.spec)
                : this.defaultValue(m.spec),
              spec: m.spec,
            };
          }
        }
      }
      return { t: "struct", name, fields };
    }

    defaultValue(spec, declaratorPointer) {
      // A pointer starts null, which is 0 here, so `if (p)` behaves.
      if ((spec && spec.pointer > 0) || declaratorPointer > 0) return num(0, false);
      const info = specInfo(spec);
      if (info.str) return str("");
      if (info.object && this.classes.has(spec.base)) return VOID; // built by instantiate()
      if (info.object && this.structs.has(spec.base)) return this.makeStruct(spec.base);
      if (info.object) return VOID;
      if (info.int === false) return num(0, true);
      return num(0, false);
    }

    makeArray(dims, spec) {
      const size = dims[0] || 0;
      const elems = [];
      for (let i = 0; i < size; i++) {
        const v =
          dims.length > 1
            ? this.makeArray(dims.slice(1), spec)
            : this.defaultValue(spec);
        elems.push({ v, spec });
      }
      return { t: "arr", elems, spec };
    }

    *execVarDecl(decl, scope) {
      for (const d of decl.declarators) {
        // `static` inside a function keeps its value across calls.
        const staticKey = decl.spec.isStatic ? decl.line + ":" + d.name : null;
        if (staticKey && this.staticCells.has(staticKey)) {
          scope.declare(d.name, this.staticCells.get(staticKey));
          continue;
        }

        let value;

        if (d.ctorArgs) {
          const args = [];
          for (const a of d.ctorArgs) args.push(yield* this.evalExpr(a, scope));
          value = this.classes.has(decl.spec.base)
            ? yield* this.instantiate(decl.spec.base, args, d.line)
            : this.construct(decl.spec.base, args, d.line);
        } else if (
          !d.arrayDims.length && !d.init && !d.pointer && !decl.spec.pointer &&
          this.classes.has(decl.spec.base)
        ) {
          // `WidgetHost host;` - default-construct it.
          value = yield* this.instantiate(decl.spec.base, [], d.line);
        } else if (d.arrayDims.length) {
          const dims = [];
          for (const dim of d.arrayDims) {
            dims.push(dim ? Math.trunc(asNumber(yield* this.evalExpr(dim, scope))) : null);
          }
          if (d.init && d.init.type === "InitList") {
            value = yield* this.buildArrayFromInit(d.init, dims, decl.spec, scope);
          } else if (d.init) {
            const v = yield* this.evalExpr(d.init, scope);
            if (v.t === "str") {
              // char buf[] = "text";
              const elems = [];
              for (let i = 0; i < v.v.length; i++) {
                elems.push({ v: num(v.v.charCodeAt(i), false), spec: decl.spec });
              }
              elems.push({ v: num(0, false), spec: decl.spec });
              value = { t: "arr", elems, spec: decl.spec };
            } else {
              value = v;
            }
          } else {
            value = this.makeArray(dims.map((x) => x || 0), decl.spec);
          }
        } else if (d.init) {
          if (d.init.type === "InitList") {
            value = yield* this.buildStructFromInit(d.init, decl.spec, scope);
          } else {
            const v = yield* this.evalExpr(d.init, scope);
            value = coerce(cloneValue(v), decl.spec);
          }
        } else {
          value = this.defaultValue(decl.spec, d.pointer);
        }

        const cell = { v: value, spec: decl.spec };
        scope.declare(d.name, cell);
        if (staticKey) this.staticCells.set(staticKey, cell);
      }
    }

    *buildArrayFromInit(initList, dims, spec, scope) {
      const elems = [];
      for (const el of initList.elements) {
        if (el.type === "InitList") {
          const sub = dims.length > 1
            ? yield* this.buildArrayFromInit(el, dims.slice(1), spec, scope)
            : yield* this.buildStructFromInit(el, spec, scope);
          elems.push({ v: sub, spec });
        } else {
          const v = yield* this.evalExpr(el, scope);
          elems.push({ v: coerce(v, spec), spec });
        }
      }
      const declared = dims[0];
      if (declared !== null && declared !== undefined && declared > elems.length) {
        while (elems.length < declared) {
          elems.push({
            v: dims.length > 1 ? this.makeArray(dims.slice(1), spec) : this.defaultValue(spec),
            spec,
          });
        }
      }
      return { t: "arr", elems, spec };
    }

    *buildStructFromInit(initList, spec, scope) {
      if (this.structs.has(spec.base)) {
        const st = this.makeStruct(spec.base);
        const keys = Object.keys(st.fields);
        for (let i = 0; i < initList.elements.length && i < keys.length; i++) {
          const el = initList.elements[i];
          const fieldSpec = st.fields[keys[i]].spec;
          st.fields[keys[i]].v =
            el.type === "InitList"
              ? yield* this.buildStructFromInit(el, fieldSpec, scope)
              : coerce(yield* this.evalExpr(el, scope), fieldSpec);
        }
        return st;
      }
      return yield* this.buildArrayFromInit(initList, [null], spec, scope);
    }

    construct(typeName, args, line) {
      const ctor = this.constructors && this.constructors[typeName];
      if (ctor) return ctor(args, this);
      if (this.structs.has(typeName)) return this.makeStruct(typeName);
      if (this.unknownHint) {
        const hint = this.unknownHint(typeName, "class");
        if (hint) throw new RuntimeError(hint, line);
      }
      // Unknown class: an inert object, so an unused library handle is not fatal.
      return {
        t: "obj",
        obj: { __name: typeName, __inert: true, methods: {} },
      };
    }

    /* ---- expressions ---- */

    *evalExpr(node, scope) {
      this.steps++;
      if (++this.stepsSinceYield >= this.yieldEvery) {
        this.stepsSinceYield = 0;
        yield { kind: "tick" };
      }

      switch (node.type) {
        case "Num":
          return num(node.value, node.isFloat);
        case "Str":
          return str(node.value);
        case "Char":
          return num(node.value, false);
        case "Bool":
          return bool(node.value);

        case "Ident": {
          const cell = scope.lookup(node.name);
          if (cell) return cell.v;
          if (this.functions.has(node.name)) {
            return { t: "func", decl: this.functions.get(node.name) };
          }
          throw new RuntimeError(this.explainUnknown(node.name, "name"), node.line);
        }

        case "Sequence":
          yield* this.evalExpr(node.left, scope);
          return yield* this.evalExpr(node.right, scope);

        case "InitList": {
          const elems = [];
          for (const el of node.elements) {
            elems.push({ v: yield* this.evalExpr(el, scope), spec: null });
          }
          return { t: "arr", elems, spec: null };
        }

        case "Cast": {
          const v = yield* this.evalExpr(node.arg, scope);
          return coerce(v, node.spec);
        }

        case "Sizeof": {
          if (node.arg.type === "TypeRef") {
            const info = specInfo(node.arg.spec);
            return num(info.bits ? info.bits / 8 : 4, false);
          }
          const v = yield* this.evalExpr(node.arg, scope);
          if (v.t === "arr") {
            const info = specInfo(v.spec);
            const each = info && info.bits ? info.bits / 8 : 4;
            return num(v.elems.length * each, false);
          }
          if (v.t === "str") return num(v.v.length + 1, false);
          return num(v.isFloat ? 4 : 4, false);
        }

        case "Unary": {
          if (node.op === "&") {
            const ref = yield* this.resolveRef(node.arg, scope);
            return { t: "ptr", ref };
          }
          if (node.op === "*") {
            const p = yield* this.evalExpr(node.arg, scope);
            if (p.t === "ptr" && p.ref) return p.ref.get();
            if (p.t === "arr") return p.elems.length ? p.elems[0].v : num(0, false);
            return p;
          }
          const v = yield* this.evalExpr(node.arg, scope);
          const n = asNumber(v, node.line);
          switch (node.op) {
            case "-": return num(-n, v.isFloat);
            case "+": return num(n, v.isFloat);
            case "!": return bool(!truthy(v));
            case "~": return num(~Math.trunc(n), false);
            default:
              throw new RuntimeError("Unsupported unary '" + node.op + "'", node.line);
          }
        }

        case "Update": {
          const ref = yield* this.resolveRef(node.arg, scope);
          const old = ref.get();
          const delta = node.op === "++" ? 1 : -1;
          const updated = coerce(num(asNumber(old) + delta, old.isFloat), ref.spec);
          ref.set(updated);
          return node.prefix ? updated : old;
        }

        case "Logical": {
          const l = yield* this.evalExpr(node.left, scope);
          if (node.op === "&&") {
            if (!truthy(l)) return bool(false);
            return bool(truthy(yield* this.evalExpr(node.right, scope)));
          }
          if (truthy(l)) return bool(true);
          return bool(truthy(yield* this.evalExpr(node.right, scope)));
        }

        case "Binary": {
          const l = yield* this.evalExpr(node.left, scope);
          const r = yield* this.evalExpr(node.right, scope);
          return this.binary(node.op, l, r, node.line);
        }

        case "Ternary": {
          const c = yield* this.evalExpr(node.cond, scope);
          return truthy(c)
            ? yield* this.evalExpr(node.consequent, scope)
            : yield* this.evalExpr(node.alternate, scope);
        }

        case "Assign": {
          const ref = yield* this.resolveRef(node.target, scope);
          let value = yield* this.evalExpr(node.value, scope);
          if (node.op !== "=") {
            const op = node.op.slice(0, -1);
            value = this.binary(op, ref.get(), value, node.line);
          }
          const stored = coerce(cloneValue(value), ref.spec);
          ref.set(stored);
          return stored;
        }

        case "Index": {
          const ref = yield* this.resolveRef(node, scope);
          return ref.get();
        }

        case "Member": {
          const obj = yield* this.evalExpr(node.obj, scope);
          return yield* this.memberValue(obj, node.prop, node);
        }

        case "Scope": {
          // Namespace-qualified constant, e.g. Foo::BAR -- look it up flat.
          const cell = scope.lookup(node.prop);
          if (cell) return cell.v;
          return num(0, false);
        }

        case "New": {
          const args = [];
          for (const a of node.args || []) args.push(yield* this.evalExpr(a, scope));
          if (this.classes.has(node.spec.base)) {
            return yield* this.instantiate(node.spec.base, args, node.line);
          }
          return this.construct(node.spec.base, args, node.line);
        }

        case "This": {
          const inst = this.thisStack[this.thisStack.length - 1];
          if (!inst) {
            throw new RuntimeError("'this' is only valid inside a method", node.line);
          }
          return { t: "ptr", ref: { get: () => inst, set: () => {} } };
        }

        case "Delete":
          // Accepted so ordinary C++ runs; the sketch owns memory for one
          // session and nothing here is reclaimed.
          yield* this.evalExpr(node.arg, scope);
          return VOID;
        case "NewArray": {
          const size = Math.trunc(asNumber(yield* this.evalExpr(node.size, scope)));
          return this.makeArray([size], node.spec);
        }

        case "Call":
          return yield* this.evalCall(node, scope);

        default:
          throw new RuntimeError("Cannot evaluate " + node.type, node.line);
      }
    }

    binary(op, l, r, line) {
      if (op === "+" && (l.t === "str" || r.t === "str")) {
        return str(valueToString(l) + valueToString(r));
      }
      if ((op === "==" || op === "!=") && (l.t === "str" || r.t === "str")) {
        const eq = valueToString(l) === valueToString(r);
        return bool(op === "==" ? eq : !eq);
      }

      const a = asNumber(l, line);
      const b = asNumber(r, line);
      // Float contaminates: int / int truncates, anything else does not.
      const isFloat = !!(l.isFloat || r.isFloat);

      switch (op) {
        case "+": return num(a + b, isFloat);
        case "-": return num(a - b, isFloat);
        case "*": return num(a * b, isFloat);
        case "/":
          if (b === 0) return num(isFloat ? (a === 0 ? NaN : a > 0 ? Infinity : -Infinity) : 0, isFloat);
          // Integer division truncates on the device; only float division doesn't.
          return isFloat ? num(a / b, true) : num(Math.trunc(a / b), false);
        case "%":
          if (b === 0) return num(0, false);
          return num(isFloat ? a % b : Math.trunc(a) % Math.trunc(b), isFloat);
        case "<": return bool(a < b);
        case ">": return bool(a > b);
        case "<=": return bool(a <= b);
        case ">=": return bool(a >= b);
        case "==": return bool(a === b);
        case "!=": return bool(a !== b);
        case "&": return num(Math.trunc(a) & Math.trunc(b), false);
        case "|": return num(Math.trunc(a) | Math.trunc(b), false);
        case "^": return num(Math.trunc(a) ^ Math.trunc(b), false);
        case "<<": return num(Math.trunc(a) << Math.trunc(b), false);
        case ">>": return num(Math.trunc(a) >> Math.trunc(b), false);
        default:
          throw new RuntimeError("Unsupported operator '" + op + "'", line);
      }
    }

    // An lvalue: something with get/set, so assignment and & can target it.
    *resolveRef(node, scope) {
      switch (node.type) {
        case "Ident": {
          const cell = scope.lookup(node.name);
          if (!cell) {
            throw new RuntimeError("'" + node.name + "' is not declared", node.line);
          }
          return {
            spec: cell.spec,
            get: () => cell.v,
            set: (v) => {
              cell.v = v;
            },
          };
        }

        case "Index": {
          const obj = yield* this.evalExpr(node.obj, scope);
          const idxV = yield* this.evalExpr(node.index, scope);
          const i = Math.trunc(asNumber(idxV));
          let arr = obj;
          if (obj.t === "ptr" && obj.ref) arr = obj.ref.get();

          if (arr.t === "str") {
            return {
              spec: { base: "char" },
              get: () => num(arr.v.charCodeAt(i) || 0, false),
              set: (v) => {
                const chars = arr.v.split("");
                chars[i] = String.fromCharCode(asNumber(v));
                arr.v = chars.join("");
              },
            };
          }
          if (arr.t !== "arr") {
            throw new RuntimeError("Cannot index a non-array value", node.line);
          }
          if (i < 0 || i >= arr.elems.length) {
            throw new RuntimeError(
              "Array index " + i + " is out of bounds (size " + arr.elems.length + ")",
              node.line
            );
          }
          const cell = arr.elems[i];
          return {
            spec: cell.spec || arr.spec,
            get: () => cell.v,
            set: (v) => {
              cell.v = v;
            },
          };
        }

        case "Member": {
          let obj = yield* this.evalExpr(node.obj, scope);
          if (obj.t === "ptr" && obj.ref) obj = obj.ref.get();
          if (obj.t === "instance") {
            let cell = obj.fields[node.prop];
            if (!cell) {
              throw new RuntimeError(
                "'" + node.prop + "' is not a member of " + obj.className, node.line
              );
            }
            return {
              spec: cell.spec,
              get: () => cell.v,
              set: (v) => {
                cell.v = v;
              },
            };
          }
          if (obj.t === "struct") {
            let cell = obj.fields[node.prop];
            if (!cell) {
              cell = { v: num(0, false), spec: { base: "int" } };
              obj.fields[node.prop] = cell;
            }
            return {
              spec: cell.spec,
              get: () => cell.v,
              set: (v) => {
                cell.v = v;
              },
            };
          }
          throw new RuntimeError(
            "'" + node.prop + "' is not a member of this value",
            node.line
          );
        }

        case "Unary":
          if (node.op === "*") {
            const p = yield* this.evalExpr(node.arg, scope);
            if (p.t === "ptr" && p.ref) return p.ref;
            if (p.t === "arr" && p.elems.length) {
              const cell = p.elems[0];
              return {
                spec: cell.spec,
                get: () => cell.v,
                set: (v) => {
                  cell.v = v;
                },
              };
            }
          }
          break;

        default:
          break;
      }

      // Not assignable, but readable -- e.g. ++f() would land here.
      const v = yield* this.evalExpr(node, scope);
      return { spec: null, get: () => v, set: () => {} };
    }

    *memberValue(obj, prop, node) {
      if (obj && obj.t === "ptr" && obj.ref) obj = obj.ref.get();

      if (obj && obj.t === "instance") {
        const cell = obj.fields[prop];
        if (cell) return cell.v;
        const method = this.findMethod(obj.className, prop);
        if (method) return { t: "boundmethod", inst: obj, decl: method };
        throw new RuntimeError(
          "'" + prop + "' is not a member of " + obj.className, node.line
        );
      }

      if (obj && obj.t === "struct") {
        const cell = obj.fields[prop];
        if (cell) return cell.v;
        throw new RuntimeError("'" + prop + "' is not a member of struct " + obj.name, node.line);
      }
      if (obj && obj.t === "obj") {
        const host = obj.obj;
        if (host.methods && host.methods[prop]) {
          return { t: "method", host, name: prop };
        }
        if (host.props && prop in host.props) return host.props[prop];
        if (host.__inert) return { t: "method", host, name: prop };
        throw new RuntimeError(
          "'" + prop + "' is not available on " + (host.__name || "this object"),
          node.line
        );
      }
      if (obj && (obj.t === "str" || obj.t === "arr" || obj.t === "num")) {
        return { t: "method", host: { __builtin: obj }, name: prop };
      }
      throw new RuntimeError("Cannot read '" + prop + "' from this value", node.line);
    }

    *evalCall(node, scope) {
      const callee = node.callee;

      // Method call: obj.method(...)
      if (callee.type === "Member") {
        let obj = yield* this.evalExpr(callee.obj, scope);
        if (obj.t === "ptr" && obj.ref) obj = obj.ref.get();
        const args = [];
        for (const a of node.args) args.push(yield* this.evalExpr(a, scope));

        if (obj.t === "instance") {
          const method = this.findMethod(obj.className, callee.prop);
          if (!method) {
            throw new RuntimeError(
              "'" + callee.prop + "()' is not a method of " + obj.className +
                (obj.className === callee.prop ? "" : ""),
              node.line
            );
          }
          return yield* this.callMethod(obj, method, args);
        }

        if (obj.t === "obj") {
          const host = obj.obj;
          const fn = host.methods && host.methods[callee.prop];
          if (!fn) {
            if (host.__inert) return VOID;
            throw new RuntimeError(
              "'" + callee.prop + "()' is not supported on " + (host.__name || "this object") +
                ". See simulator/README.md for what is emulated.",
              node.line
            );
          }
          const result = fn.call(host, args, this, node);
          return yield* this.applyEffect(result);
        }
        if (obj.t === "str" || obj.t === "arr") {
          return this.stringMethod(obj, callee.prop, args, node, scope);
        }
        throw new RuntimeError("Cannot call '" + callee.prop + "()' on this value", node.line);
      }

      // Plain function call
      if (callee.type === "Ident") {
        const name = callee.name;
        const cell = scope.lookup(name);

        if (cell && cell.v && cell.v.t === "hostfn") {
          const args = [];
          for (const a of node.args) args.push(yield* this.evalExpr(a, scope));
          const result = cell.v.fn(args, this, node);
          return yield* this.applyEffect(result);
        }

        if (this.functions.has(name)) {
          const args = [];
          for (const a of node.args) args.push(yield* this.evalExpr(a, scope));
          return yield* this.callFunction(this.functions.get(name), args);
        }

        if (cell && cell.v && cell.v.t === "func") {
          const args = [];
          for (const a of node.args) args.push(yield* this.evalExpr(a, scope));
          return yield* this.callFunction(cell.v.decl, args);
        }

        if (cell && cell.v && cell.v.t === "boundmethod") {
          const args = [];
          for (const a of node.args) args.push(yield* this.evalExpr(a, scope));
          return yield* this.callMethod(cell.v.inst, cell.v.decl, args);
        }

        // Inside a method, an unqualified call resolves against the receiver.
        const receiver = this.thisStack[this.thisStack.length - 1];
        if (receiver) {
          const method = this.findMethod(receiver.className, name);
          if (method) {
            const args = [];
            for (const a of node.args) args.push(yield* this.evalExpr(a, scope));
            return yield* this.callMethod(receiver, method, args);
          }
        }

        throw new RuntimeError(this.explainUnknown(name, "call"), node.line);
      }

      throw new RuntimeError("Unsupported call target", node.line);
    }

    // A host method can ask the driver to do something (advance the clock,
    // latch a frame) by returning { __effect }.
    *applyEffect(result) {
      if (result && result.__effect) {
        yield { kind: result.__effect, ...result };
        return result.value === undefined ? VOID : result.value;
      }
      return result === undefined ? VOID : result;
    }

    stringMethod(obj, prop, args, node) {
      const s = valueToString(obj);
      const n = (i) => asNumber(args[i]);
      switch (prop) {
        case "length": return num(s.length, false);
        case "charAt": return num(s.charCodeAt(n(0)) || 0, false);
        case "indexOf": return num(s.indexOf(valueToString(args[0])), false);
        case "lastIndexOf": return num(s.lastIndexOf(valueToString(args[0])), false);
        case "substring":
          return str(args.length > 1 ? s.substring(n(0), n(1)) : s.substring(n(0)));
        case "toInt": return num(parseInt(s, 10) || 0, false);
        case "toFloat": case "toDouble": return num(parseFloat(s) || 0, true);
        case "toUpperCase": return str(s.toUpperCase());
        case "toLowerCase": return str(s.toLowerCase());
        case "trim": return str(s.trim());
        case "equals": return bool(s === valueToString(args[0]));
        case "equalsIgnoreCase":
          return bool(s.toLowerCase() === valueToString(args[0]).toLowerCase());
        case "startsWith": return bool(s.startsWith(valueToString(args[0])));
        case "endsWith": return bool(s.endsWith(valueToString(args[0])));
        case "c_str": case "toString": return str(s);
        case "concat": return str(s + valueToString(args[0]));
        case "replace":
          return str(s.split(valueToString(args[0])).join(valueToString(args[1])));
        case "isEmpty": return bool(s.length === 0);
        default:
          throw new RuntimeError(
            "String method '" + prop + "()' is not emulated", node.line
          );
      }
    }
  }

  // Drain a generator that is known not to yield effects (constant folding).
  function runSync(gen) {
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
  }

  return {
    Interpreter,
    Scope,
    RuntimeError,
    CompileError,
    VOID,
    num,
    str,
    bool,
    coerce,
    truthy,
    asNumber,
    valueToString,
    formatNumber,
    cloneValue,
    runSync,
    specInfo,
  };
});

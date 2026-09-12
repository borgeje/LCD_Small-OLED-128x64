/*
 * parser.js - recursive-descent parser for the C++ subset Arduino sketches use.
 *
 * Produces a plain-object AST. It is deliberately permissive: the goal is to
 * run real sketches, not to reject invalid C++. Anything it cannot model
 * (templates, operator overloading, multiple inheritance) raises a
 * CompileError pointing at the offending line rather than failing silently.
 *
 * The one genuinely ambiguous construct in this grammar is `Type name(args);`,
 * which is either a function prototype or a constructor-initialised variable.
 * Resolved the way a reader does: a built-in return type means prototype,
 * a class-like identifier means an object being constructed --
 *   void drawScreen();                       -> prototype
 *   Adafruit_SSD1306 display(128, 64, &Wire, -1);  -> object
 */
(function (root, factory) {
  const mod = factory(
    typeof module === "object" && module.exports
      ? require("./lexer.js")
      : root.OLEDSim.lexer
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).parser = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (lexer) {
  "use strict";

  const CompileError = lexer.CompileError;

  const TYPE_KEYWORDS = new Set([
    "void", "bool", "boolean", "char", "int", "long", "short", "float",
    "double", "byte", "word", "size_t", "String", "auto",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "int8_t", "int16_t", "int32_t", "int64_t",
  ]);

  const QUALIFIERS = new Set([
    "const", "static", "volatile", "unsigned", "signed", "extern",
    "register", "inline", "PROGMEM", "virtual", "explicit",
  ]);

  // Assignment operators, all right-associative at the same precedence.
  const ASSIGN_OPS = new Set([
    "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
  ]);

  // Binary precedence, loosest to tightest.
  const BINARY_PRECEDENCE = {
    "||": 1,
    "&&": 2,
    "|": 3,
    "^": 4,
    "&": 5,
    "==": 6, "!=": 6,
    "<": 7, ">": 7, "<=": 7, ">=": 7,
    "<<": 8, ">>": 8,
    "+": 9, "-": 9,
    "*": 10, "/": 10, "%": 10,
  };

  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
      this.knownTypes = new Set(); // struct / class / typedef names
      this.prototypes = new Set();
    }

    peek(offset) {
      return this.tokens[this.pos + (offset || 0)] || this.tokens[this.tokens.length - 1];
    }
    next() {
      return this.tokens[this.pos++];
    }
    at(type, value) {
      const t = this.peek();
      return t.type === type && (value === undefined || t.value === value);
    }
    atOp(value) {
      return this.at("op", value);
    }
    atKw(value) {
      return this.at("kw", value);
    }
    eat(type, value) {
      if (this.at(type, value)) {
        return this.next();
      }
      return null;
    }
    expect(type, value) {
      const t = this.peek();
      if (t.type === type && (value === undefined || t.value === value)) {
        return this.next();
      }
      throw new CompileError(
        "Expected " + (value !== undefined ? "'" + value + "'" : type) +
          " but found " + describe(t),
        t.line,
        t.col
      );
    }

    /* ---------------- top level ---------------- */

    parseProgram() {
      const decls = [];
      while (!this.at("eof")) {
        const d = this.parseTopLevel();
        if (d) decls.push(d);
      }
      return { type: "Program", decls };
    }

    parseTopLevel() {
      if (this.atOp(";")) {
        this.next();
        return null;
      }
      if (this.atKw("typedef")) return this.parseTypedef();
      if (this.atKw("struct") || this.atKw("class")) {
        const saved = this.pos;
        const rec = this.parseStructOrClass();
        if (rec) return rec;
        this.pos = saved;
      }
      if (this.atKw("enum")) return this.parseEnum();
      return this.parseDeclaration(true);
    }

    parseTypedef() {
      this.expect("kw", "typedef");
      // typedef struct { ... } Name;  |  typedef unsigned char byte;
      if (this.atKw("struct") || this.atKw("class")) {
        const rec = this.parseStructOrClass(true);
        const nameTok = this.eat("ident");
        this.eat("op", ";");
        if (nameTok) {
          this.knownTypes.add(nameTok.value);
          if (rec) rec.name = rec.name || nameTok.value;
        }
        return rec;
      }
      const parts = [];
      while (!this.atOp(";") && !this.at("eof")) parts.push(this.next());
      this.eat("op", ";");
      const last = parts[parts.length - 1];
      if (last && (last.type === "ident" || last.type === "kw")) {
        this.knownTypes.add(last.value);
      }
      return null;
    }

    parseEnum() {
      this.expect("kw", "enum");
      const nameTok = this.eat("ident");
      const entries = [];
      if (this.eat("op", "{")) {
        let auto = 0;
        while (!this.atOp("}") && !this.at("eof")) {
          const id = this.expect("ident");
          let value = null;
          if (this.eat("op", "=")) value = this.parseAssignment();
          entries.push({ name: id.value, value, index: auto++ });
          if (!this.eat("op", ",")) break;
        }
        this.expect("op", "}");
      }
      this.eat("ident");
      this.eat("op", ";");
      if (nameTok) this.knownTypes.add(nameTok.value);
      return { type: "EnumDecl", name: nameTok ? nameTok.value : null, entries };
    }

    parseStructOrClass(fromTypedef) {
      this.next(); // struct | class
      const nameTok = this.eat("ident");

      // Inheritance. Only the first base is modelled; multiple inheritance is
      // out of scope and would change how method lookup works.
      let base = null;
      if (this.atOp(":")) {
        this.next();
        do {
          this.eat("kw", "public");
          this.eat("kw", "private");
          this.eat("kw", "protected");
          this.eat("kw", "virtual");
          const b = this.eat("ident");
          if (b && !base) base = b.value;
        } while (this.eat("op", ","));
      }

      // Register the name before the body is parsed, so members can refer to
      // the type being defined (a Widget* inside Widget, say).
      if (nameTok) this.knownTypes.add(nameTok.value);

      if (!this.atOp("{")) {
        // A forward declaration, or a `struct Foo bar;` style variable.
        return null;
      }
      this.expect("op", "{");

      const className = nameTok ? nameTok.value : null;
      const members = [];
      const methods = [];
      let ctor = null;

      while (!this.atOp("}") && !this.at("eof")) {
        if (this.atKw("public") || this.atKw("private") || this.atKw("protected")) {
          this.next();
          this.eat("op", ":");
          continue;
        }
        if (this.eat("op", ";")) continue;

        const member = this.parseMember(className);
        if (!member) continue;
        if (member.type === "CtorDecl") ctor = member;
        else if (member.type === "FuncDecl") methods.push(member);
        else members.push(member);
      }
      this.expect("op", "}");

      // `struct Point { ... } origin;` also declares a variable.
      const vars = [];
      while (this.at("ident")) {
        const v = this.next();
        vars.push(v.value);
        if (!this.eat("op", ",")) break;
      }
      if (!fromTypedef) this.eat("op", ";");

      return {
        type: "StructDecl",
        name: className,
        base,
        members,
        methods,
        ctor,
        vars,
      };
    }

    /*
     * One entry inside a class body: a constructor, a destructor, a method
     * (inline, declared-only, or pure virtual), or a data member.
     */
    parseMember(className) {
      // Destructor. Nothing here owns memory, so the body is parsed and dropped.
      if (this.atOp("~")) {
        this.next();
        this.eat("ident");
        this.parseParams();
        this.eat("kw", "override");
        if (this.atOp("{")) this.parseBlock();
        else this.eat("op", ";");
        return null;
      }

      // Constructor: the member's name is the class name, followed by '('.
      const t = this.peek();
      if (
        className &&
        (t.type === "ident" || t.type === "kw") &&
        t.value === className &&
        this.peek(1).type === "op" &&
        this.peek(1).value === "("
      ) {
        this.next();
        const params = this.parseParams();
        const inits = this.parseMemberInitList();
        let body = null;
        if (this.atOp("{")) body = this.parseBlock();
        else this.eat("op", ";");
        return { type: "CtorDecl", name: className, params, inits, body, line: t.line };
      }

      return this.parseDeclaration(false, true);
    }

    // `: display(d), count(0)` between a constructor's parameters and its body.
    parseMemberInitList() {
      const inits = [];
      if (!this.atOp(":")) return inits;
      this.next();
      do {
        const name = this.peek();
        if (name.type !== "ident" && name.type !== "kw") break;
        this.next();
        const args = [];
        if (this.eat("op", "(") ) {
          if (!this.atOp(")")) {
            do { args.push(this.parseAssignment()); } while (this.eat("op", ","));
          }
          this.expect("op", ")");
        } else if (this.atOp("{")) {
          args.push(this.parseInitList());
        }
        inits.push({ name: name.value, args, line: name.line });
      } while (this.eat("op", ","));
      return inits;
    }

    /* ---------------- types ---------------- */

    isTypeToken(t) {
      if (t.type === "kw" && (TYPE_KEYWORDS.has(t.value) || QUALIFIERS.has(t.value))) return true;
      if (t.type === "kw" && (t.value === "struct" || t.value === "class")) return true;
      if (t.type === "ident" && this.knownTypes.has(t.value)) return true;
      return false;
    }

    // Does a declaration start here? Used to tell statements from expressions.
    looksLikeDeclaration() {
      const t = this.peek();
      if (t.type === "kw" && (TYPE_KEYWORDS.has(t.value) || QUALIFIERS.has(t.value))) return true;
      if (t.type === "kw" && (t.value === "struct" || t.value === "class" || t.value === "enum")) return true;
      if (t.type !== "ident") return false;

      // `Ident Ident`, `Ident *Ident`, `Ident &Ident` -- a declaration.
      let i = 1;
      while (this.peek(i).type === "op" && (this.peek(i).value === "*" || this.peek(i).value === "&")) i++;
      const after = this.peek(i);
      if (after.type !== "ident") return false;
      // Exclude `a * b;` style expressions by requiring a known type, a
      // declarator tail, or a capitalised class-looking name.
      if (this.knownTypes.has(t.value)) return true;
      const tail = this.peek(i + 1);
      if (tail.type === "op" && (tail.value === "=" || tail.value === ";" || tail.value === "," ||
          tail.value === "(" || tail.value === "[")) {
        return i === 1 || /^[A-Z_]/.test(t.value);
      }
      return false;
    }

    parseTypeSpec() {
      const spec = {
        base: null,
        unsigned: false,
        isConst: false,
        isStatic: false,
        pointer: 0,
        reference: false,
        longCount: 0,
      };
      let sawAny = false;

      for (;;) {
        const t = this.peek();
        if (t.type === "kw" && QUALIFIERS.has(t.value)) {
          if (t.value === "const") spec.isConst = true;
          else if (t.value === "static") spec.isStatic = true;
          else if (t.value === "unsigned") spec.unsigned = true;
          this.next();
          sawAny = true;
          continue;
        }
        if (t.type === "kw" && (t.value === "struct" || t.value === "class")) {
          this.next();
          sawAny = true;
          continue;
        }
        if (t.type === "kw" && t.value === "long") {
          spec.longCount++;
          spec.base = spec.base || "long";
          this.next();
          sawAny = true;
          continue;
        }
        if (t.type === "kw" && t.value === "short") {
          spec.base = "short";
          this.next();
          sawAny = true;
          continue;
        }
        if (t.type === "kw" && TYPE_KEYWORDS.has(t.value)) {
          spec.base = t.value;
          this.next();
          sawAny = true;
          continue;
        }
        if (t.type === "ident" && !spec.base && (this.knownTypes.has(t.value) || this.peek(1).type === "ident" ||
            (this.peek(1).type === "op" && (this.peek(1).value === "*" || this.peek(1).value === "&") &&
             this.peek(2).type === "ident"))) {
          spec.base = t.value;
          spec.isClass = !TYPE_KEYWORDS.has(t.value);
          this.next();
          sawAny = true;
          continue;
        }
        break;
      }

      while (this.atOp("*")) {
        spec.pointer++;
        this.next();
      }
      if (this.atOp("&")) {
        spec.reference = true;
        this.next();
      }

      if (!sawAny) return null;
      if (!spec.base) spec.base = spec.unsigned ? "int" : "int";
      if (spec.longCount >= 1 && spec.base === "long") spec.base = "long";
      return spec;
    }

    /* ---------------- declarations ---------------- */

    parseDeclaration(topLevel, inClass) {
      const startTok = this.peek();

      if (this.atKw("struct") || this.atKw("class")) {
        const saved = this.pos;
        const rec = this.parseStructOrClass();
        if (rec) return rec;
        this.pos = saved;
      }
      if (this.atKw("enum")) return this.parseEnum();

      // An out-of-line constructor has no return type to parse first:
      //   WidgetHost::WidgetHost(Adafruit_SSD1306 &d) : display(d) { ... }
      if (
        this.peek().type === "ident" &&
        this.knownTypes.has(this.peek().value) &&
        this.peek(1).type === "op" &&
        this.peek(1).value === "::" &&
        this.peek(2).type === "ident" &&
        this.peek(2).value === this.peek().value
      ) {
        const owner = this.next().value;
        this.next(); // ::
        this.next(); // name
        const params = this.parseParams();
        const inits = this.parseMemberInitList();
        const body = this.atOp("{") ? this.parseBlock() : (this.eat("op", ";"), null);
        return {
          type: "MethodDef",
          className: owner,
          decl: { type: "CtorDecl", name: owner, params, inits, body, line: startTok.line },
          line: startTok.line,
        };
      }

      const spec = this.parseTypeSpec();
      if (!spec) {
        throw new CompileError(
          "Expected a declaration but found " + describe(startTok),
          startTok.line,
          startTok.col
        );
      }

      const declarators = [];
      for (;;) {
        let ptr = 0;
        while (this.atOp("*")) { ptr++; this.next(); }
        let ref = false;
        if (this.atOp("&")) { ref = true; this.next(); }

        const nameTok = this.peek();
        if (nameTok.type !== "ident" && nameTok.type !== "kw") {
          throw new CompileError(
            "Expected a name in declaration but found " + describe(nameTok),
            nameTok.line,
            nameTok.col
          );
        }
        this.next();
        let name = nameTok.value;

        // `void WidgetHost::tick() { ... }` defines a method declared earlier.
        let ownerClass = null;
        if (this.atOp("::")) {
          this.next();
          ownerClass = name;
          const memberTok = this.peek();
          if (memberTok.type !== "ident" && memberTok.type !== "kw") {
            throw new CompileError(
              "Expected a member name after '" + ownerClass + "::'",
              memberTok.line,
              memberTok.col
            );
          }
          this.next();
          name = memberTok.value;
        }

        // Function definition, prototype, or pure virtual.
        if (this.atOp("(") && (ownerClass || this.isFunctionDeclarator(spec))) {
          const params = this.parseParams();
          this.eat("kw", "const");
          this.eat("kw", "override");
          this.eat("kw", "final");

          // `= 0` marks a pure virtual: declared, deliberately not defined.
          let pure = false;
          if (this.atOp("=")) {
            this.next();
            this.eat("num");
            pure = true;
          }

          const fn = {
            type: "FuncDecl",
            name,
            retType: spec,
            params,
            body: null,
            pure,
            line: startTok.line,
          };

          if (this.atOp("{")) {
            fn.body = this.parseBlock();
          } else {
            this.eat("op", ";");
            if (!inClass && !ownerClass) {
              this.prototypes.add(name);
              return null; // a free-function prototype carries no behaviour
            }
          }

          if (ownerClass) {
            return { type: "MethodDef", className: ownerClass, decl: fn, line: startTok.line };
          }
          return fn;
        }

        const decl = {
          name,
          pointer: ptr + spec.pointer,
          reference: ref || spec.reference,
          arrayDims: [],
          init: null,
          ctorArgs: null,
          line: nameTok.line,
        };

        while (this.atOp("[")) {
          this.next();
          if (this.atOp("]")) decl.arrayDims.push(null);
          else decl.arrayDims.push(this.parseAssignment());
          this.expect("op", "]");
        }

        // Storage attributes trail the declarator in Arduino code:
        //   const uint8_t icon[] PROGMEM = { ... };
        while (this.atKw("PROGMEM") || this.atKw("const") || this.atKw("static")) {
          this.next();
        }

        if (this.atOp("=")) {
          this.next();
          decl.init = this.atOp("{") ? this.parseInitList() : this.parseAssignment();
        } else if (this.atOp("(")) {
          // Constructor-style initialisation: Adafruit_SSD1306 display(...)
          this.next();
          const args = [];
          if (!this.atOp(")")) {
            do {
              args.push(this.parseAssignment());
            } while (this.eat("op", ","));
          }
          this.expect("op", ")");
          decl.ctorArgs = args;
        } else if (this.atOp("{")) {
          decl.init = this.parseInitList();
        }

        declarators.push(decl);
        if (!this.eat("op", ",")) break;
      }

      this.eat("op", ";");
      return {
        type: "VarDecl",
        spec,
        declarators,
        topLevel: !!topLevel,
        line: startTok.line,
      };
    }

    /*
     * `(` after a name is a function declarator only when this is not an
     * object being constructed. A built-in return type settles it; so does a
     * body, and so does a parameter list that names types.
     */
    isFunctionDeclarator(spec) {
      if (!spec.isClass) return true;

      let i = 1;
      let depth = 1;
      while (depth > 0) {
        const t = this.peek(i);
        if (t.type === "eof") return false;
        if (t.type === "op" && t.value === "(") depth++;
        if (t.type === "op" && t.value === ")") depth--;
        i++;
      }
      const after = this.peek(i);
      if (after.type === "op" && after.value === "{") return true;

      // `Foo bar(int x);` is a prototype; `Foo bar(1, 2);` is an object.
      const first = this.peek(1);
      if (first.type === "op" && first.value === ")") return false;
      return this.isTypeToken(first) && this.peek(2).type === "ident";
    }

    parseParams() {
      this.expect("op", "(");
      const params = [];
      if (!this.atOp(")")) {
        do {
          if (this.atOp("...")) {
            this.next();
            params.push({ name: "...", variadic: true });
            break;
          }
          const spec = this.parseTypeSpec();
          if (spec && spec.base === "void" && this.atOp(")")) break;
          let ptr = 0;
          while (this.atOp("*")) { ptr++; this.next(); }
          let ref = false;
          if (this.atOp("&")) { ref = true; this.next(); }
          const nameTok = this.eat("ident");
          const p = {
            spec: spec || { base: "int" },
            name: nameTok ? nameTok.value : null,
            pointer: ptr + (spec ? spec.pointer : 0),
            reference: ref || (spec ? spec.reference : false),
            arrayDims: [],
          };
          while (this.atOp("[")) {
            this.next();
            if (!this.atOp("]")) this.parseAssignment();
            this.expect("op", "]");
            p.arrayDims.push(null);
          }
          if (this.atOp("=")) {
            this.next();
            p.defaultValue = this.parseAssignment();
          }
          params.push(p);
        } while (this.eat("op", ","));
      }
      this.expect("op", ")");
      return params;
    }

    parseInitList() {
      this.expect("op", "{");
      const elements = [];
      while (!this.atOp("}") && !this.at("eof")) {
        elements.push(this.atOp("{") ? this.parseInitList() : this.parseAssignment());
        if (!this.eat("op", ",")) break;
      }
      this.expect("op", "}");
      return { type: "InitList", elements };
    }

    /* ---------------- statements ---------------- */

    parseBlock() {
      const open = this.expect("op", "{");
      const body = [];
      while (!this.atOp("}") && !this.at("eof")) {
        body.push(this.parseStatement());
      }
      this.expect("op", "}");
      return { type: "Block", body, line: open.line };
    }

    parseStatement() {
      const t = this.peek();

      if (t.type === "op" && t.value === "{") return this.parseBlock();
      if (t.type === "op" && t.value === ";") {
        this.next();
        return { type: "Empty", line: t.line };
      }

      if (t.type === "kw") {
        switch (t.value) {
          case "if": return this.parseIf();
          case "for": return this.parseFor();
          case "while": return this.parseWhile();
          case "do": return this.parseDoWhile();
          case "switch": return this.parseSwitch();
          case "return": {
            this.next();
            let arg = null;
            if (!this.atOp(";")) arg = this.parseExpression();
            this.eat("op", ";");
            return { type: "Return", arg, line: t.line };
          }
          case "break":
            this.next();
            this.eat("op", ";");
            return { type: "Break", line: t.line };
          case "continue":
            this.next();
            this.eat("op", ";");
            return { type: "Continue", line: t.line };
          default:
            break;
        }
      }

      if (this.looksLikeDeclaration()) {
        const d = this.parseDeclaration(false);
        return d || { type: "Empty", line: t.line };
      }

      const expr = this.parseExpression();
      this.eat("op", ";");
      return { type: "ExprStmt", expr, line: t.line };
    }

    parseIf() {
      const t = this.expect("kw", "if");
      this.expect("op", "(");
      const cond = this.parseExpression();
      this.expect("op", ")");
      const consequent = this.parseStatement();
      let alternate = null;
      if (this.eat("kw", "else")) alternate = this.parseStatement();
      return { type: "If", cond, consequent, alternate, line: t.line };
    }

    parseFor() {
      const t = this.expect("kw", "for");
      this.expect("op", "(");
      let init = null;
      if (!this.atOp(";")) {
        if (this.looksLikeDeclaration()) init = this.parseDeclaration(false);
        else {
          init = { type: "ExprStmt", expr: this.parseExpression(), line: t.line };
          this.eat("op", ";");
        }
      } else {
        this.next();
      }
      let cond = null;
      if (!this.atOp(";")) cond = this.parseExpression();
      this.expect("op", ";");
      let update = null;
      if (!this.atOp(")")) update = this.parseExpression();
      this.expect("op", ")");
      const body = this.parseStatement();
      return { type: "For", init, cond, update, body, line: t.line };
    }

    parseWhile() {
      const t = this.expect("kw", "while");
      this.expect("op", "(");
      const cond = this.parseExpression();
      this.expect("op", ")");
      const body = this.parseStatement();
      return { type: "While", cond, body, line: t.line };
    }

    parseDoWhile() {
      const t = this.expect("kw", "do");
      const body = this.parseStatement();
      this.expect("kw", "while");
      this.expect("op", "(");
      const cond = this.parseExpression();
      this.expect("op", ")");
      this.eat("op", ";");
      return { type: "DoWhile", body, cond, line: t.line };
    }

    // Flat body with Case/Default markers, so fallthrough is the default.
    parseSwitch() {
      const t = this.expect("kw", "switch");
      this.expect("op", "(");
      const disc = this.parseExpression();
      this.expect("op", ")");
      this.expect("op", "{");
      const body = [];
      while (!this.atOp("}") && !this.at("eof")) {
        if (this.atKw("case")) {
          const ct = this.next();
          const test = this.parseAssignment();
          this.expect("op", ":");
          body.push({ type: "Case", test, line: ct.line });
        } else if (this.atKw("default")) {
          const dt = this.next();
          this.expect("op", ":");
          body.push({ type: "Case", test: null, line: dt.line });
        } else {
          body.push(this.parseStatement());
        }
      }
      this.expect("op", "}");
      return { type: "Switch", disc, body, line: t.line };
    }

    /* ---------------- expressions ---------------- */

    parseExpression() {
      let expr = this.parseAssignment();
      while (this.atOp(",")) {
        const t = this.next();
        const right = this.parseAssignment();
        expr = { type: "Sequence", left: expr, right, line: t.line };
      }
      return expr;
    }

    parseAssignment() {
      const left = this.parseTernary();
      const t = this.peek();
      if (t.type === "op" && ASSIGN_OPS.has(t.value)) {
        this.next();
        const value = this.parseAssignment();
        return { type: "Assign", op: t.value, target: left, value, line: t.line };
      }
      return left;
    }

    parseTernary() {
      const cond = this.parseBinary(1);
      if (this.atOp("?")) {
        const t = this.next();
        const consequent = this.parseAssignment();
        this.expect("op", ":");
        const alternate = this.parseAssignment();
        return { type: "Ternary", cond, consequent, alternate, line: t.line };
      }
      return cond;
    }

    parseBinary(minPrec) {
      let left = this.parseUnary();
      for (;;) {
        const t = this.peek();
        if (t.type !== "op") break;
        const prec = BINARY_PRECEDENCE[t.value];
        if (prec === undefined || prec < minPrec) break;
        this.next();
        const right = this.parseBinary(prec + 1);
        const kind = t.value === "&&" || t.value === "||" ? "Logical" : "Binary";
        left = { type: kind, op: t.value, left, right, line: t.line };
      }
      return left;
    }

    parseUnary() {
      const t = this.peek();

      if (t.type === "op" && (t.value === "++" || t.value === "--")) {
        this.next();
        const arg = this.parseUnary();
        return { type: "Update", op: t.value, arg, prefix: true, line: t.line };
      }
      if (t.type === "op" && ["-", "+", "!", "~", "*", "&"].indexOf(t.value) >= 0) {
        this.next();
        const arg = this.parseUnary();
        return { type: "Unary", op: t.value, arg, line: t.line };
      }
      if (t.type === "kw" && t.value === "sizeof") {
        this.next();
        if (this.atOp("(")) {
          this.next();
          let arg;
          if (this.isTypeToken(this.peek())) {
            const spec = this.parseTypeSpec();
            arg = { type: "TypeRef", spec };
          } else {
            arg = this.parseExpression();
          }
          this.expect("op", ")");
          return { type: "Sizeof", arg, line: t.line };
        }
        return { type: "Sizeof", arg: this.parseUnary(), line: t.line };
      }
      if (t.type === "kw" && t.value === "delete") {
        this.next();
        if (this.eat("op", "[")) this.expect("op", "]");
        const arg = this.parseUnary();
        // Nothing here is reclaimed; a sketch runs for one session.
        return { type: "Delete", arg, line: t.line };
      }
      if (t.type === "kw" && t.value === "new") {
        this.next();
        const spec = this.parseTypeSpec();
        const args = [];
        if (this.atOp("(")) {
          this.next();
          if (!this.atOp(")")) {
            do { args.push(this.parseAssignment()); } while (this.eat("op", ","));
          }
          this.expect("op", ")");
        } else if (this.atOp("[")) {
          this.next();
          args.push(this.parseAssignment());
          this.expect("op", "]");
          return { type: "NewArray", spec, size: args[0], line: t.line };
        }
        return { type: "New", spec, args, line: t.line };
      }

      // Cast: `(int)x`, `(uint8_t)(a + b)`
      if (t.type === "op" && t.value === "(" && this.isTypeToken(this.peek(1))) {
        const saved = this.pos;
        this.next();
        const spec = this.parseTypeSpec();
        if (spec && this.atOp(")")) {
          const closeIdx = this.pos;
          this.next();
          const nt = this.peek();
          const castable =
            nt.type === "num" || nt.type === "ident" || nt.type === "char" ||
            nt.type === "str" ||
            (nt.type === "op" && ["(", "-", "+", "!", "~", "*", "&"].indexOf(nt.value) >= 0) ||
            (nt.type === "kw" && (nt.value === "true" || nt.value === "false"));
          if (castable) {
            const arg = this.parseUnary();
            return { type: "Cast", spec, arg, line: t.line };
          }
          this.pos = closeIdx;
        }
        this.pos = saved;
      }

      return this.parsePostfix();
    }

    parsePostfix() {
      let expr = this.parsePrimary();
      for (;;) {
        const t = this.peek();
        if (t.type === "op" && t.value === "(") {
          this.next();
          const args = [];
          if (!this.atOp(")")) {
            do { args.push(this.parseAssignment()); } while (this.eat("op", ","));
          }
          this.expect("op", ")");
          expr = { type: "Call", callee: expr, args, line: t.line };
        } else if (t.type === "op" && t.value === "[") {
          this.next();
          const index = this.parseExpression();
          this.expect("op", "]");
          expr = { type: "Index", obj: expr, index, line: t.line };
        } else if (t.type === "op" && (t.value === "." || t.value === "->")) {
          this.next();
          const prop = this.peek();
          if (prop.type !== "ident" && prop.type !== "kw") {
            throw new CompileError("Expected a member name after '" + t.value + "'", prop.line, prop.col);
          }
          this.next();
          expr = { type: "Member", obj: expr, prop: prop.value, line: t.line };
        } else if (t.type === "op" && t.value === "::") {
          this.next();
          const prop = this.expect("ident");
          expr = { type: "Scope", obj: expr, prop: prop.value, line: t.line };
        } else if (t.type === "op" && (t.value === "++" || t.value === "--")) {
          this.next();
          expr = { type: "Update", op: t.value, arg: expr, prefix: false, line: t.line };
        } else {
          break;
        }
      }
      return expr;
    }

    parsePrimary() {
      const t = this.peek();

      if (t.type === "num") {
        this.next();
        return { type: "Num", value: t.value.value, isFloat: t.value.isFloat, line: t.line };
      }
      if (t.type === "str") {
        this.next();
        return { type: "Str", value: t.value, line: t.line };
      }
      if (t.type === "char") {
        this.next();
        return { type: "Char", value: t.value, line: t.line };
      }
      if (t.type === "kw" && (t.value === "true" || t.value === "false")) {
        this.next();
        return { type: "Bool", value: t.value === "true", line: t.line };
      }
      if (t.type === "kw" && t.value === "this") {
        this.next();
        return { type: "This", line: t.line };
      }
      if (t.type === "ident") {
        this.next();
        return { type: "Ident", name: t.value, line: t.line };
      }
      // A type keyword in expression position is a functional cast: int(x)
      if (t.type === "kw" && TYPE_KEYWORDS.has(t.value)) {
        this.next();
        return { type: "Ident", name: t.value, line: t.line };
      }
      if (t.type === "op" && t.value === "(") {
        this.next();
        const expr = this.parseExpression();
        this.expect("op", ")");
        return expr;
      }
      if (t.type === "op" && t.value === "{") {
        return this.parseInitList();
      }

      throw new CompileError("Unexpected " + describe(t) + " in expression", t.line, t.col);
    }
  }

  function describe(t) {
    if (!t) return "end of file";
    if (t.type === "eof") return "end of file";
    if (t.type === "num") return "number " + t.value.value;
    if (t.type === "str") return "string literal";
    return "'" + t.value + "'";
  }

  function parse(source, options) {
    const lexed = lexer.lex(source, options);
    const p = new Parser(lexed.tokens);
    const program = p.parseProgram();
    program.includes = lexed.includes;
    program.defines = lexed.defines;
    program.lineMap = lexed.lineMap;
    program.flattened = lexed.flattened;
    return program;
  }

  return { parse, Parser, CompileError, TYPE_KEYWORDS };
});

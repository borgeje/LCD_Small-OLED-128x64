/*
 * runtime.js - the Arduino environment the sketch runs inside, plus the
 * driver that pumps it.
 *
 * Two things live here:
 *
 *   installGlobals()  puts millis/delay/Serial/Wire/constants into scope and
 *                     registers the Adafruit_SSD1306 constructor.
 *   Sketch            owns the virtual clock, runs setup() then loop(), and
 *                     turns the generator's yields into clock advances and
 *                     latched frames.
 *
 * The clock is charged for work the way the hardware is: roughly 50 ns per
 * interpreted step, and a full display.display() costs the real I2C transfer
 * time for 1024 bytes at the configured bus speed. That is why a sketch that
 * redraws in a tight loop tops out near 30 fps here, exactly as it does on a
 * panel at 400 kHz -- the simulator shows you the ceiling before you wire
 * anything up.
 */
(function (root, factory) {
  const mod = factory(
    typeof module === "object" && module.exports
      ? {
          parser: require("./parser.js"),
          interp: require("./interpreter.js"),
          display: require("./display.js"),
        }
      : {
          parser: root.OLEDSim.parser,
          interp: root.OLEDSim.interpreter,
          display: root.OLEDSim.display,
        }
  );
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.OLEDSim = root.OLEDSim || {}).runtime = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (deps) {
  "use strict";

  const { parse } = deps.parser;
  const {
    Interpreter, RuntimeError, CompileError, VOID,
    num, str, bool, asNumber, valueToString, formatNumber,
  } = deps.interp;
  const SSD1306 = deps.display.SSD1306;

  const hostfn = (fn) => ({ t: "hostfn", fn });
  const hostobj = (name, methods, props) => ({
    t: "obj",
    obj: { __name: name, methods: methods || {}, props: props || {} },
  });

  // Pull a flat byte array out of an array value or a pointer to one.
  function toByteArray(value) {
    let v = value;
    if (v && v.t === "ptr" && v.ref) v = v.ref.get();
    if (!v) return [];
    if (v.t === "arr") return v.elems.map((c) => Math.trunc(asNumber(c.v)) & 0xff);
    if (v.t === "str") {
      const out = [];
      for (let i = 0; i < v.v.length; i++) out.push(v.v.charCodeAt(i) & 0xff);
      return out;
    }
    return [];
  }

  // Arduino's Print::print, shared by Serial and the display.
  function printArgs(args) {
    if (!args.length) return "";
    const v = args[0];
    if (v.t === "num") return formatNumber(v, args.length > 1 ? args[1] : undefined);
    return valueToString(v);
  }

  function cFormat(fmt, args) {
    let i = 0;
    return fmt.replace(
      /%%|%[-+ #0]*(\d+)?(?:\.(\d+))?(l{0,2}|h{0,2})([diufFeEgGxXocsp])/g,
      (m, width, prec, _len, conv) => {
        if (m === "%%") return "%";
        const a = args[i++];
        let out;
        const n = a === undefined ? 0 : asNumber(a);
        switch (conv) {
          case "d": case "i": out = String(Math.trunc(n)); break;
          case "u": out = String(Math.trunc(n) >>> 0); break;
          case "f": case "F":
            out = n.toFixed(prec === undefined ? 6 : parseInt(prec, 10));
            break;
          case "e": case "E":
            out = n.toExponential(prec === undefined ? 6 : parseInt(prec, 10));
            if (conv === "E") out = out.toUpperCase();
            break;
          case "g": case "G": out = String(n); break;
          case "x": out = (Math.trunc(n) >>> 0).toString(16); break;
          case "X": out = (Math.trunc(n) >>> 0).toString(16).toUpperCase(); break;
          case "o": out = (Math.trunc(n) >>> 0).toString(8); break;
          case "c": out = String.fromCharCode(Math.trunc(n)); break;
          case "s": out = a === undefined ? "" : valueToString(a); break;
          case "p": out = "0x" + (Math.trunc(n) >>> 0).toString(16); break;
          default: out = m;
        }
        if (width) {
          const w = parseInt(width, 10);
          const pad = m.indexOf("0") >= 0 && m.indexOf("-") < 0 ? "0" : " ";
          if (out.length < w) {
            out = m.indexOf("-") >= 0
              ? out + " ".repeat(w - out.length)
              : pad.repeat(w - out.length) + out;
          }
        }
        return out;
      }
    );
  }

  /* ------------------------------------------------------------------ *
   * Host objects
   * ------------------------------------------------------------------ */

  function makeSerial() {
    const write = (args, interp) => {
      interp.log(printArgs(args));
      return num(1, false);
    };
    return hostobj("Serial", {
      begin: () => VOID,
      end: () => VOID,
      print: write,
      write: (args, interp) => {
        const v = args[0];
        interp.log(v && v.t === "num" ? String.fromCharCode(asNumber(v)) : valueToString(v));
        return num(1, false);
      },
      println: (args, interp) => {
        interp.log(printArgs(args) + "\n");
        return num(1, false);
      },
      printf: (args, interp) => {
        interp.log(cFormat(valueToString(args[0]), args.slice(1)));
        return num(1, false);
      },
      flush: (args, interp) => {
        interp.flushSerial();
        return VOID;
      },
      available: () => num(0, false),
      read: () => num(-1, false),
      peek: () => num(-1, false),
      setTimeout: () => VOID,
      // `while (!Serial);` must not hang: the port is always ready here.
      __bool: () => bool(true),
    });
  }

  function makeWire(interp) {
    return hostobj("Wire", {
      begin: (args) => {
        if (args.length >= 2) {
          interp.i2c.sda = asNumber(args[0]);
          interp.i2c.scl = asNumber(args[1]);
        }
        return VOID;
      },
      setClock: (args) => {
        interp.i2c.clock = asNumber(args[0]) || 100000;
        return VOID;
      },
      beginTransmission: (args) => {
        interp.i2c.lastAddress = asNumber(args[0]);
        return VOID;
      },
      endTransmission: () => num(interp.i2c.devices.has(interp.i2c.lastAddress) ? 0 : 2, false),
      write: () => num(1, false),
      requestFrom: () => num(0, false),
      available: () => num(0, false),
      read: () => num(-1, false),
      setTimeOut: () => VOID,
    });
  }

  function makeDisplayObject(panel, interp) {
    const N = (a, i) => Math.trunc(asNumber(a[i]));
    const methods = {
      begin: (args) => {
        const addr = args.length > 1 ? N(args, 1) : 0x3c;
        panel.begin(args.length ? asNumber(args[0]) : 2, addr);
        interp.i2c.devices.add(addr);
        return bool(interp.i2c.devices.has(addr));
      },
      // The one call that actually pushes GDDRAM over the wire.
      display: () => {
        panel.display();
        return { __effect: "frame", us: interp.i2cFrameMicros() };
      },
      clearDisplay: () => (panel.clearDisplay(), VOID),
      drawPixel: (a) => (panel.drawPixel(N(a, 0), N(a, 1), N(a, 2)), VOID),
      getPixel: (a) => num(panel.getPixel(N(a, 0), N(a, 1)), false),
      drawLine: (a) => (panel.drawLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4)), VOID),
      drawFastHLine: (a) => (panel.drawFastHLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      drawFastVLine: (a) => (panel.drawFastVLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      drawRect: (a) => (panel.drawRect(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4)), VOID),
      fillRect: (a) => (panel.fillRect(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4)), VOID),
      fillScreen: (a) => (panel.fillScreen(N(a, 0)), VOID),
      drawCircle: (a) => (panel.drawCircle(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      fillCircle: (a) => (panel.fillCircle(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      drawRoundRect: (a) => (panel.drawRoundRect(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4), N(a, 5)), VOID),
      fillRoundRect: (a) => (panel.fillRoundRect(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4), N(a, 5)), VOID),
      drawTriangle: (a) => (panel.drawTriangle(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4), N(a, 5), N(a, 6)), VOID),
      fillTriangle: (a) => (panel.fillTriangle(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4), N(a, 5), N(a, 6)), VOID),
      drawBitmap: (a) => {
        panel.drawBitmap(N(a, 0), N(a, 1), toByteArray(a[2]), N(a, 3), N(a, 4), N(a, 5),
          a.length > 6 ? N(a, 6) : undefined);
        return VOID;
      },
      drawXBitmap: (a) => {
        panel.drawXBitmap(N(a, 0), N(a, 1), toByteArray(a[2]), N(a, 3), N(a, 4), N(a, 5));
        return VOID;
      },
      drawChar: (a) => {
        panel.drawChar(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4),
          a.length > 5 ? N(a, 5) : 1, a.length > 6 ? N(a, 6) : undefined);
        return VOID;
      },
      setCursor: (a) => (panel.setCursor(N(a, 0), N(a, 1)), VOID),
      getCursorX: () => num(panel.getCursorX(), false),
      getCursorY: () => num(panel.getCursorY(), false),
      setTextSize: (a) => (panel.setTextSize(N(a, 0), a.length > 1 ? N(a, 1) : undefined), VOID),
      setTextColor: (a) => (panel.setTextColor(N(a, 0), a.length > 1 ? N(a, 1) : undefined), VOID),
      setTextWrap: (a) => (panel.setTextWrap(asNumber(a[0]) !== 0), VOID),
      cp437: (a) => (panel.cp437(a.length ? asNumber(a[0]) !== 0 : true), VOID),
      setRotation: (a) => (panel.setRotation(N(a, 0)), VOID),
      getRotation: () => num(panel.getRotation(), false),
      width: () => num(panel.width(), false),
      height: () => num(panel.height(), false),
      print: (a) => (panel.printString(printArgs(a)), VOID),
      println: (a) => (panel.printString(printArgs(a) + "\n"), VOID),
      printf: (a) => (panel.printString(cFormat(valueToString(a[0]), a.slice(1))), VOID),
      write: (a) => (panel.write(Math.trunc(asNumber(a[0]))), num(1, false)),
      invertDisplay: (a) => (panel.invertDisplay(asNumber(a[0]) !== 0), VOID),
      dim: (a) => (panel.dim(asNumber(a[0]) !== 0), VOID),
      setContrast: (a) => (panel.setContrast(N(a, 0)), VOID),
      ssd1306_command: (a) => (panel.ssd1306_command(N(a, 0)), VOID),
      startscrollright: (a) => (panel.startscrollright(N(a, 0), N(a, 1)), VOID),
      startscrollleft: (a) => (panel.startscrollleft(N(a, 0), N(a, 1)), VOID),
      startscrolldiagright: (a) => (panel.startscrolldiagright(N(a, 0), N(a, 1)), VOID),
      startscrolldiagleft: (a) => (panel.startscrolldiagleft(N(a, 0), N(a, 1)), VOID),
      stopscroll: () => (panel.stopscroll(), VOID),
      getTextBounds: (a) => {
        // Signature takes pointers for the four outputs.
        const b = panel.getTextBounds(valueToString(a[0]), N(a, 1), N(a, 2));
        const outs = [b.x, b.y, b.w, b.h];
        for (let i = 0; i < 4; i++) {
          const p = a[3 + i];
          if (p && p.t === "ptr" && p.ref) p.ref.set(num(outs[i], false));
        }
        return VOID;
      },
      // Adafruit_GFX transaction markers -- no-ops on an I2C panel.
      startWrite: () => VOID,
      endWrite: () => VOID,
      writePixel: (a) => (panel.drawPixel(N(a, 0), N(a, 1), N(a, 2)), VOID),
      writeFillRect: (a) => (panel.fillRect(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4)), VOID),
      writeFastHLine: (a) => (panel.drawFastHLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      writeFastVLine: (a) => (panel.drawFastVLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3)), VOID),
      writeLine: (a) => (panel.drawLine(N(a, 0), N(a, 1), N(a, 2), N(a, 3), N(a, 4)), VOID),
      setFont: () => VOID, // custom GFX fonts are not emulated; stays 5x7
      getBuffer: () => VOID,
    };
    return hostobj("Adafruit_SSD1306", methods);
  }

  /* ------------------------------------------------------------------ *
   * Globals
   * ------------------------------------------------------------------ */

  const CONSTANTS = {
    NULL: 0, nullptr: 0,
    HIGH: 1, LOW: 0,
    INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 9,
    LED_BUILTIN: 2,
    true: 1, false: 0,
    DEC: 10, HEX: 16, OCT: 8, BIN: 2,
    SSD1306_BLACK: 0, SSD1306_WHITE: 1, SSD1306_INVERSE: 2,
    BLACK: 0, WHITE: 1, INVERSE: 2,
    SSD1306_SWITCHCAPVCC: 0x02, SSD1306_EXTERNALVCC: 0x01,
    SSD1306_MEMORYMODE: 0x20, SSD1306_SETCONTRAST: 0x81,
    SSD1306_DISPLAYON: 0xaf, SSD1306_DISPLAYOFF: 0xae,
    A0: 36, A1: 37, A2: 38, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35,
    D0: 0, D1: 1, D2: 2, D3: 21, D4: 22, D5: 23,
    D6: 16, D7: 17, D8: 19, D9: 20, D10: 18,
    PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2,
    DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI,
    EULER: Math.E,
    MSBFIRST: 1, LSBFIRST: 0,
    CHANGE: 1, FALLING: 2, RISING: 3,
  };

  function installGlobals(interp) {
    const g = interp.global;
    const declare = (name, v) => g.declare(name, { v, spec: { base: "int", isConst: true } });

    for (const k of Object.keys(CONSTANTS)) {
      const v = CONSTANTS[k];
      declare(k, num(v, !Number.isInteger(v)));
    }

    interp.i2c = { clock: 100000, sda: null, scl: null, devices: new Set(), lastAddress: 0 };
    interp.i2cFrameMicros = function () {
      // 1024 data bytes + control overhead, 9 bit-times per byte.
      const bytes = 1024 + 16;
      return Math.round((bytes * 9 * 1e6) / (interp.i2c.clock || 100000));
    };

    declare("Serial", makeSerial());
    declare("Serial1", makeSerial());
    declare("Wire", makeWire(interp));
    declare("Wire1", makeWire(interp));

    /* --- time --- */
    declare("millis", hostfn(() => num(Math.floor(interp.micros / 1000), false)));
    declare("micros", hostfn(() => num(Math.floor(interp.micros), false)));
    declare("delay", hostfn((a) => ({
      __effect: "delay",
      us: Math.max(0, asNumber(a[0])) * 1000,
    })));
    declare("delayMicroseconds", hostfn((a) => ({
      __effect: "delay",
      us: Math.max(0, asNumber(a[0])),
    })));
    declare("yield", hostfn(() => ({ __effect: "tick" })));

    /* --- GPIO --- */
    declare("pinMode", hostfn((a) => {
      interp.io.pinModes[Math.trunc(asNumber(a[0]))] = Math.trunc(asNumber(a[1]));
      return VOID;
    }));
    declare("digitalWrite", hostfn((a) => {
      const pin = Math.trunc(asNumber(a[0]));
      interp.io.digital[pin] = asNumber(a[1]) ? 1 : 0;
      interp.io.pinsWritten.add(pin);
      return VOID;
    }));
    declare("digitalRead", hostfn((a) => {
      const pin = Math.trunc(asNumber(a[0]));
      interp.io.pinsRead.add(pin);
      interp.io.digitalPins.add(pin);
      const mode = interp.io.pinModes[pin];
      // An INPUT_PULLUP pin with nothing attached reads HIGH, as on hardware.
      const dflt = mode === 2 ? 1 : 0;
      return num(interp.io.digital[pin] === undefined ? dflt : interp.io.digital[pin], false);
    }));
    declare("analogRead", hostfn((a) => {
      const pin = Math.trunc(asNumber(a[0]));
      interp.io.pinsRead.add(pin);
      interp.io.analogPins.add(pin);
      return num(interp.io.analog[pin] === undefined ? 0 : interp.io.analog[pin], false);
    }));
    declare("analogWrite", hostfn((a) => {
      const pin = Math.trunc(asNumber(a[0]));
      interp.io.analog[pin] = Math.trunc(asNumber(a[1]));
      interp.io.pinsWritten.add(pin);
      return VOID;
    }));
    declare("analogReadResolution", hostfn(() => VOID));
    declare("attachInterrupt", hostfn(() => VOID));
    declare("detachInterrupt", hostfn(() => VOID));
    declare("digitalPinToInterrupt", hostfn((a) => num(asNumber(a[0]), false)));
    declare("pulseIn", hostfn(() => num(0, false)));
    declare("tone", hostfn(() => VOID));
    declare("noTone", hostfn(() => VOID));

    /* --- math --- */
    const m1 = (fn, isFloat) => hostfn((a) => num(fn(asNumber(a[0])), isFloat !== false));
    declare("abs", hostfn((a) => num(Math.abs(asNumber(a[0])), a[0] && a[0].isFloat)));
    declare("sqrt", m1(Math.sqrt));
    declare("sq", hostfn((a) => {
      const v = asNumber(a[0]);
      return num(v * v, a[0] && a[0].isFloat);
    }));
    declare("pow", hostfn((a) => num(Math.pow(asNumber(a[0]), asNumber(a[1])), true)));
    declare("sin", m1(Math.sin));
    declare("cos", m1(Math.cos));
    declare("tan", m1(Math.tan));
    declare("asin", m1(Math.asin));
    declare("acos", m1(Math.acos));
    declare("atan", m1(Math.atan));
    declare("atan2", hostfn((a) => num(Math.atan2(asNumber(a[0]), asNumber(a[1])), true)));
    declare("log", m1(Math.log));
    declare("log10", m1(Math.log10));
    declare("exp", m1(Math.exp));
    declare("floor", m1(Math.floor));
    declare("ceil", m1(Math.ceil));
    declare("round", hostfn((a) => num(Math.round(asNumber(a[0])), false)));
    declare("trunc", hostfn((a) => num(Math.trunc(asNumber(a[0])), false)));
    declare("fabs", m1(Math.abs));
    declare("fmod", hostfn((a) => num(asNumber(a[0]) % asNumber(a[1]), true)));
    declare("isnan", hostfn((a) => bool(isNaN(asNumber(a[0])))));
    declare("isinf", hostfn((a) => bool(!isFinite(asNumber(a[0])))));
    declare("radians", hostfn((a) => num((asNumber(a[0]) * Math.PI) / 180, true)));
    declare("degrees", hostfn((a) => num((asNumber(a[0]) * 180) / Math.PI, true)));

    declare("min", hostfn((a) => {
      const x = asNumber(a[0]), y = asNumber(a[1]);
      return num(Math.min(x, y), (a[0] && a[0].isFloat) || (a[1] && a[1].isFloat));
    }));
    declare("max", hostfn((a) => {
      const x = asNumber(a[0]), y = asNumber(a[1]);
      return num(Math.max(x, y), (a[0] && a[0].isFloat) || (a[1] && a[1].isFloat));
    }));
    declare("constrain", hostfn((a) => {
      const v = asNumber(a[0]), lo = asNumber(a[1]), hi = asNumber(a[2]);
      return num(v < lo ? lo : v > hi ? hi : v, a[0] && a[0].isFloat);
    }));
    // Arduino's map() is integer maths, truncating -- a classic source of
    // off-by-one surprises, so it is reproduced rather than "fixed".
    declare("map", hostfn((a) => {
      const x = Math.trunc(asNumber(a[0]));
      const inMin = Math.trunc(asNumber(a[1]));
      const inMax = Math.trunc(asNumber(a[2]));
      const outMin = Math.trunc(asNumber(a[3]));
      const outMax = Math.trunc(asNumber(a[4]));
      if (inMax === inMin) return num(outMin, false);
      return num(
        Math.trunc(((x - inMin) * (outMax - outMin)) / (inMax - inMin)) + outMin,
        false
      );
    }));

    declare("random", hostfn((a) => {
      if (a.length === 0) return num(Math.floor(interp.nextRandom() * 2147483647), false);
      if (a.length === 1) {
        const hi = Math.trunc(asNumber(a[0]));
        return num(hi <= 0 ? 0 : Math.floor(interp.nextRandom() * hi), false);
      }
      const lo = Math.trunc(asNumber(a[0]));
      const hi = Math.trunc(asNumber(a[1]));
      return num(hi <= lo ? lo : lo + Math.floor(interp.nextRandom() * (hi - lo)), false);
    }));
    declare("randomSeed", hostfn((a) => {
      interp.randomState = (Math.trunc(asNumber(a[0])) || 1) & 0x7fffffff;
      return VOID;
    }));
    declare("esp_random", hostfn(() => num(Math.floor(interp.nextRandom() * 4294967295), false)));

    /* --- strings and memory --- */
    declare("F", hostfn((a) => a[0]));
    declare("PSTR", hostfn((a) => a[0]));
    declare("String", hostfn((a) => {
      if (!a.length) return str("");
      if (a.length > 1 && a[0].t === "num") return str(formatNumber(a[0], a[1]));
      return str(valueToString(a[0]));
    }));
    declare("strlen", hostfn((a) => num(valueToString(a[0]).length, false)));
    declare("strcmp", hostfn((a) => {
      const x = valueToString(a[0]), y = valueToString(a[1]);
      return num(x < y ? -1 : x > y ? 1 : 0, false);
    }));
    declare("atoi", hostfn((a) => num(parseInt(valueToString(a[0]), 10) || 0, false)));
    declare("atof", hostfn((a) => num(parseFloat(valueToString(a[0])) || 0, true)));

    const writeCString = (target, text) => {
      let arr = target;
      if (arr && arr.t === "ptr" && arr.ref) arr = arr.ref.get();
      if (arr && arr.t === "arr") {
        for (let i = 0; i < arr.elems.length; i++) {
          arr.elems[i].v = num(i < text.length ? text.charCodeAt(i) : 0, false);
        }
      }
      return text.length;
    };
    declare("sprintf", hostfn((a) =>
      num(writeCString(a[0], cFormat(valueToString(a[1]), a.slice(2))), false)
    ));
    declare("snprintf", hostfn((a) => {
      const cap = Math.trunc(asNumber(a[1]));
      const text = cFormat(valueToString(a[2]), a.slice(3)).slice(0, Math.max(0, cap - 1));
      return num(writeCString(a[0], text), false);
    }));
    declare("strcpy", hostfn((a) => (writeCString(a[0], valueToString(a[1])), a[0])));
    declare("dtostrf", hostfn((a) => {
      const v = asNumber(a[0]);
      const width = Math.trunc(asNumber(a[1]));
      const prec = Math.trunc(asNumber(a[2]));
      let text = v.toFixed(prec);
      while (text.length < Math.abs(width)) {
        text = width < 0 ? text + " " : " " + text;
      }
      writeCString(a[3], text);
      return a[3];
    }));
    declare("memset", hostfn((a) => {
      let arr = a[0];
      if (arr && arr.t === "ptr" && arr.ref) arr = arr.ref.get();
      if (arr && arr.t === "arr") {
        const v = Math.trunc(asNumber(a[1]));
        const n = Math.min(arr.elems.length, Math.trunc(asNumber(a[2])));
        for (let i = 0; i < n; i++) arr.elems[i].v = num(v, false);
      }
      return a[0];
    }));
    declare("memcpy", hostfn((a) => {
      let dst = a[0], src = a[1];
      if (dst && dst.t === "ptr" && dst.ref) dst = dst.ref.get();
      if (src && src.t === "ptr" && src.ref) src = src.ref.get();
      if (dst && dst.t === "arr" && src && src.t === "arr") {
        const n = Math.min(dst.elems.length, src.elems.length, Math.trunc(asNumber(a[2])));
        for (let i = 0; i < n; i++) dst.elems[i].v = src.elems[i].v;
      }
      return a[0];
    }));

    // PROGMEM reads are ordinary reads here; the pointer form is the common one.
    const pgmRead = (a) => {
      const p = a[0];
      if (p && p.t === "ptr" && p.ref) return p.ref.get();
      if (p && p.t === "arr") return p.elems.length ? p.elems[0].v : num(0, false);
      return p || num(0, false);
    };
    declare("pgm_read_byte", hostfn(pgmRead));
    declare("pgm_read_byte_near", hostfn(pgmRead));
    declare("pgm_read_word", hostfn(pgmRead));
    declare("pgm_read_dword", hostfn(pgmRead));
    declare("pgm_read_float", hostfn(pgmRead));

    /* --- ESP / FreeRTOS odds and ends sketches reach for --- */
    declare("ESP", hostobj("ESP", {
      getFreeHeap: () => num(200000, false),
      getChipModel: () => str("ESP32-C6"),
      restart: () => VOID,
      getCycleCount: () => num(Math.floor(interp.micros * 160), false),
    }));
    declare("esp_sleep_enable_timer_wakeup", hostfn(() => VOID));
    declare("esp_deep_sleep_start", hostfn(() => VOID));
    declare("vTaskDelay", hostfn((a) => ({ __effect: "delay", us: asNumber(a[0]) * 1000 })));

    /*
     * Name the library rather than the symbol. Anything matching a known
     * unemulated stack gets a straight answer instead of "not declared".
     */
    const UNEMULATED = [
      {
        test: /^(U8G2|U8X8|u8g2|u8x8)_/,
        name: "U8g2",
        note: "this simulator emulates the Adafruit_SSD1306 + Adafruit_GFX stack only",
      },
      {
        test: /^(WiFi|HTTPClient|WiFiClient|WebServer|ESPAsync)/,
        name: "the networking libraries",
        note: "there is no network in the simulator; stub the call out to test the display code",
      },
      {
        test: /^(SD|SPIFFS|LittleFS|FS)$/,
        name: "the filesystem libraries",
        note: "there is no filesystem in the simulator",
      },
    ];

    interp.unknownHint = function (name, kind) {
      for (const entry of UNEMULATED) {
        if (entry.test.test(name)) {
          return (
            "'" + name + "' comes from " + entry.name + ", which is not emulated - " +
            entry.note + ". See simulator/README.md."
          );
        }
      }
      if (kind === "class") {
        // Unknown classes stay inert so an unrelated handle does not break a
        // sketch whose display code is the part under test.
        return null;
      }
      return null;
    };

    /* --- constructors --- */
    interp.constructors = {
      Adafruit_SSD1306: (args) => {
        const w = args.length > 0 ? Math.trunc(asNumber(args[0])) : 128;
        const h = args.length > 1 ? Math.trunc(asNumber(args[1])) : 64;
        const panel = new SSD1306(w, h);
        if (!interp.display) interp.display = panel;
        return makeDisplayObject(panel, interp);
      },
      Adafruit_GFX: (args) => {
        const panel = new SSD1306(
          args.length > 0 ? Math.trunc(asNumber(args[0])) : 128,
          args.length > 1 ? Math.trunc(asNumber(args[1])) : 64
        );
        if (!interp.display) interp.display = panel;
        return makeDisplayObject(panel, interp);
      },
      String: (args) => (args.length ? str(valueToString(args[0])) : str("")),
    };

    return interp;
  }

  /* ------------------------------------------------------------------ *
   * Sketch driver
   * ------------------------------------------------------------------ */

  class Sketch {
    constructor(source, options) {
      options = options || {};
      this.options = options;
      this.source = source;
      this.nsPerStep = options.nsPerStep === undefined ? 50 : options.nsPerStep;
      this.loopOverheadUs =
        options.loopOverheadUs === undefined ? 2 : options.loopOverheadUs;

      this.program = parse(source, {
        resolveInclude: options.resolveInclude || null,
        fileName: options.fileName || "sketch.ino",
      });
      this.lineMap = this.program.lineMap || null;
      this.interp = new Interpreter(options);
      installGlobals(this.interp);
      this.interp.load(this.program);

      this.frames = 0;
      this.loops = 0;
      this.started = false;
      this.finished = false;
      this.error = null;
      this.lastFrameMicros = 0;
      this.frameIntervals = [];

      this.gen = this.run();
    }

    get display() {
      return this.interp.display;
    }
    get micros() {
      return this.interp.micros;
    }
    get millis() {
      return Math.floor(this.interp.micros / 1000);
    }
    get serial() {
      return this.interp.serial;
    }

    /*
     * Map a line in the flattened source back to the file and line the author
     * wrote. Without this, an error inside an included header points at a line
     * number in a file that only exists inside the preprocessor.
     */
    locate(line) {
      if (!this.lineMap || !line || line < 1 || line > this.lineMap.length) {
        return { file: this.options.fileName || "sketch.ino", line: line || 0 };
      }
      return this.lineMap[line - 1];
    }

    /** The same error, with `file` and `line` pointing at real source. */
    locateError(e) {
      if (!e) return e;
      const where = this.locate(e.line);
      e.file = where.file;
      e.sourceLine = where.line;
      return e;
    }

    // The sketch as one long generator: globals, setup(), then loop() forever.
    *run() {
      const interp = this.interp;
      yield* interp.initGlobals();

      if (interp.hasFunction("setup")) {
        yield { kind: "phase", phase: "setup" };
        yield* interp.callFunctionByName("setup", []);
      }
      this.started = true;

      if (!interp.hasFunction("loop")) {
        yield { kind: "phase", phase: "done" };
        return;
      }

      for (;;) {
        const before = interp.steps;
        yield* interp.callFunctionByName("loop", []);
        this.loops++;
        // Charge each iteration the Arduino core's own loop-task overhead.
        // Without a floor, a sketch whose loop() is a bare millis() poll would
        // need millions of interpreted iterations to advance one virtual
        // second; ~2 us per iteration is both cheap to simulate and closer to
        // what the ESP32 core actually costs.
        yield { kind: "delay", us: this.loopOverheadUs };
        if (interp.steps - before > interp.maxStepsPerLoop) {
          throw new RuntimeError(
            "loop() ran " + (interp.steps - before).toLocaleString() +
              " steps without returning - is there an endless loop inside it?",
            0
          );
        }
      }
    }

    /*
     * Advance the sketch until a frame is latched, the virtual clock passes
     * `untilMicros`, or the step budget runs out. Returns why it stopped.
     */
    advance(opts) {
      opts = opts || {};
      const untilMicros = opts.untilMicros === undefined ? Infinity : opts.untilMicros;
      const stopOnFrame = !!opts.stopOnFrame;
      const maxSteps = opts.maxSteps || 8000000;
      const wallDeadline = opts.wallMs ? Date.now() + opts.wallMs : Infinity;
      const interp = this.interp;

      if (this.finished || this.error) return { reason: this.error ? "error" : "done" };

      const startSteps = interp.steps;
      let framed = false;
      let sinceWallCheck = 0;

      for (;;) {
        let r;
        try {
          r = this.gen.next();
        } catch (e) {
          this.error = this.locateError(e);
          this.finished = true;
          interp.flushSerial();
          return { reason: "error", error: this.error };
        }

        if (r.done) {
          this.finished = true;
          interp.flushSerial();
          return { reason: "done" };
        }

        // Charge the clock for the work done since the last yield.
        const stepDelta = interp.steps - (this._lastChargedSteps || 0);
        this._lastChargedSteps = interp.steps;
        interp.micros += (stepDelta * this.nsPerStep) / 1000;

        const ev = r.value;
        if (ev.kind === "delay") {
          interp.micros += ev.us;
        } else if (ev.kind === "frame") {
          interp.micros += ev.us || 0;
          this.frames++;
          const dt = interp.micros - this.lastFrameMicros;
          this.lastFrameMicros = interp.micros;
          this.frameIntervals.push(dt);
          if (this.frameIntervals.length > 60) this.frameIntervals.shift();
          framed = true;
        }

        if (framed && stopOnFrame) return { reason: "frame" };
        if (interp.micros >= untilMicros) return { reason: "time", framed };
        if (interp.steps - startSteps > maxSteps) {
          return { reason: "budget", framed };
        }
        if (++sinceWallCheck >= 256 && wallDeadline !== Infinity) {
          sinceWallCheck = 0;
          if (Date.now() > wallDeadline) return { reason: "wall", framed };
        }
      }
    }

    runUntil(millis, opts) {
      return this.advance(
        Object.assign({ untilMicros: millis * 1000 }, opts || {})
      );
    }

    nextFrame(opts) {
      return this.advance(Object.assign({ stopOnFrame: true }, opts || {}));
    }

    // Measured frames per second over the recent window of latched frames.
    fps() {
      if (this.frameIntervals.length < 2) return 0;
      const total = this.frameIntervals.reduce((a, b) => a + b, 0);
      return total > 0 ? (this.frameIntervals.length * 1e6) / total : 0;
    }

    snapshot() {
      if (!this.display) return null;
      return this.display.snapshot();
    }

    setAnalog(pin, value) {
      this.interp.io.analog[pin] = value;
    }
    setDigital(pin, value) {
      this.interp.io.digital[pin] = value ? 1 : 0;
    }
  }

  return {
    Sketch,
    installGlobals,
    makeDisplayObject,
    cFormat,
    CONSTANTS,
    RuntimeError,
    CompileError,
  };
});

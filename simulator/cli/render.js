#!/usr/bin/env node
/*
 * render.js - run a .ino sketch headlessly and write out what the panel shows.
 *
 *   node simulator/cli/render.js sketch.ino --ascii
 *   node simulator/cli/render.js sketch.ino --at 5000 --out frame.png
 *   node simulator/cli/render.js sketch.ino --frames 12 --every 250 --out anim/
 *   node simulator/cli/render.js sketch.ino --analog 36=820 --ascii --serial
 *
 * Useful in CI: --ascii output is a stable text snapshot of the screen, so a
 * change in rendering shows up as a readable diff.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Sketch } = require("../src/runtime.js");
const { encodePNG } = require("./png.js");

const USAGE = `
Render an Arduino SSD1306 sketch without hardware.

  node simulator/cli/render.js <sketch.ino> [options]

Options
  --at <ms>            Virtual time to render at (default: first frame)
  --frames <n>         Render n frames instead of one
  --every <ms>         With --frames, virtual ms between frames (default: 100)
  --out <path>         PNG file, or directory when --frames > 1
  --scale <n>          PNG pixels per display pixel (default: 4)
  --grid               Draw the inter-pixel gap the real panel has
  --ascii              Print the screen as text
  --serial             Print what the sketch wrote to Serial
  --stats              Print timing, frame count and measured fps
  --analog <pin=val>   Seed analogRead(pin) (repeatable)
  --digital <pin=val>  Seed digitalRead(pin) (repeatable)
  --i2c-clock <hz>     Bus speed for frame-time modelling (default: 100000,
                       or whatever the sketch sets via Wire.setClock)
  --timeout <s>        Give up after this much wall time (default: 20)
  --help               This message
`;

function parseArgs(argv) {
  const opts = {
    at: null, frames: 1, every: 100, out: null, scale: 4, grid: false,
    ascii: false, serial: false, stats: false, analog: {}, digital: {},
    i2cClock: null, timeout: 20, sketch: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--at": opts.at = Number(next()); break;
      case "--frames": opts.frames = Math.max(1, parseInt(next(), 10)); break;
      case "--every": opts.every = Number(next()); break;
      case "--out": opts.out = next(); break;
      case "--scale": opts.scale = Math.max(1, parseInt(next(), 10)); break;
      case "--grid": opts.grid = true; break;
      case "--ascii": opts.ascii = true; break;
      case "--serial": opts.serial = true; break;
      case "--stats": opts.stats = true; break;
      case "--i2c-clock": opts.i2cClock = Number(next()); break;
      case "--timeout": opts.timeout = Number(next()); break;
      case "--analog": {
        const [p, v] = next().split("=");
        opts.analog[parseInt(p, 10)] = Number(v);
        break;
      }
      case "--digital": {
        const [p, v] = next().split("=");
        opts.digital[parseInt(p, 10)] = Number(v);
        break;
      }
      case "--help": case "-h": opts.help = true; break;
      default:
        if (a.startsWith("-")) {
          console.error("Unknown option: " + a);
          process.exit(2);
        }
        opts.sketch = a;
    }
  }
  return opts;
}

function toAscii(snap, on, off) {
  on = on || "#";
  off = off || " ";
  const top = "+" + "-".repeat(snap.width) + "+";
  const rows = [top];
  for (let y = 0; y < snap.height; y++) {
    let row = "|";
    for (let x = 0; x < snap.width; x++) {
      row += snap.pixels[y * snap.width + x] ? on : off;
    }
    rows.push(row + "|");
  }
  rows.push(top);
  return rows.join("\n");
}

// Paint the panel the way it looks: near-black glass, slightly blue-white lit
// pixels, and the thin dark gap between pixels that gives OLEDs their texture.
function toRGB(snap, scale, grid) {
  const W = snap.width * scale;
  const H = snap.height * scale;
  const rgb = new Uint8Array(W * H * 3);

  const bg = [8, 10, 14];
  const gapCol = [4, 5, 8];
  const lit = [226, 240, 255];
  const dim = snap.contrast !== undefined ? Math.max(0.35, snap.contrast / 0x8f) : 1;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = Math.floor(x / scale);
      const py = Math.floor(y / scale);
      const inGap = grid && scale >= 3 && (x % scale === scale - 1 || y % scale === scale - 1);
      const on = snap.pixels[py * snap.width + px];
      let c;
      if (inGap) c = gapCol;
      else if (on) {
        c = [
          Math.min(255, Math.round(lit[0] * dim)),
          Math.min(255, Math.round(lit[1] * dim)),
          Math.min(255, Math.round(lit[2] * dim)),
        ];
      } else c = bg;
      const o = (y * W + x) * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  return { width: W, height: H, rgb };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || !opts.sketch) {
    console.log(USAGE.trim());
    process.exit(opts.sketch ? 0 : 1);
  }
  if (!fs.existsSync(opts.sketch)) {
    console.error("No such file: " + opts.sketch);
    process.exit(1);
  }

  const source = fs.readFileSync(opts.sketch, "utf8");
  const sketchDir = path.dirname(path.resolve(opts.sketch));

  /*
   * Local `#include "x.h"` is resolved against the sketch folder, then its
   * parent (so a project can keep headers in a subdirectory next to the .ino),
   * which is enough for an Arduino-shaped project without pulling in a real
   * build system.
   */
  const resolveInclude = (name) => {
    const candidates = [
      path.resolve(sketchDir, name),
      path.resolve(sketchDir, "..", name),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        return { source: fs.readFileSync(file, "utf8"), path: path.relative(sketchDir, file) || path.basename(file) };
      }
    }
    return null;
  };

  let sketch;
  try {
    sketch = new Sketch(source, {
      resolveInclude,
      fileName: path.basename(opts.sketch),
    });
  } catch (e) {
    reportError(e, opts.sketch, source, null);
    process.exit(1);
  }

  for (const pin of Object.keys(opts.analog)) sketch.setAnalog(Number(pin), opts.analog[pin]);
  for (const pin of Object.keys(opts.digital)) sketch.setDigital(Number(pin), opts.digital[pin]);
  if (opts.i2cClock) sketch.interp.i2c.clock = opts.i2cClock;

  const wallMs = opts.timeout * 1000;
  const outputs = [];

  const advanceTo = (targetMs) => {
    if (targetMs === null) return sketch.nextFrame({ wallMs });
    return sketch.runUntil(targetMs, { wallMs });
  };

  let result;
  for (let f = 0; f < opts.frames; f++) {
    const target =
      opts.frames > 1
        ? (opts.at === null ? 0 : opts.at) + f * opts.every
        : opts.at;
    result = advanceTo(target);

    if (sketch.error) {
      reportError(sketch.error, opts.sketch, source, sketch);
      process.exit(1);
    }
    const snap = sketch.snapshot();
    if (!snap) {
      console.error(
        "This sketch never constructed a display.\n" +
          "Expected something like: Adafruit_SSD1306 display(128, 64, &Wire, -1);"
      );
      process.exit(1);
    }
    outputs.push({ snap, atMs: sketch.millis });

    if (result.reason === "wall") {
      console.error(
        "Timed out after " + opts.timeout + "s of real time at virtual t=" +
          sketch.millis + "ms. Raise --timeout, or check for a loop that never delays."
      );
      break;
    }
    if (result.reason === "done") break;
  }

  // ---- emit ----

  if (opts.ascii || (!opts.out && !opts.ascii)) {
    outputs.forEach((o, i) => {
      if (outputs.length > 1) console.log("--- frame " + (i + 1) + " @ " + o.atMs + "ms ---");
      console.log(toAscii(o.snap));
    });
  }

  if (opts.out) {
    const many = outputs.length > 1;
    if (many) fs.mkdirSync(opts.out, { recursive: true });
    outputs.forEach((o, i) => {
      const { width, height, rgb } = toRGB(o.snap, opts.scale, opts.grid);
      const file = many
        ? path.join(opts.out, "frame-" + String(i + 1).padStart(3, "0") + ".png")
        : opts.out;
      if (!many) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, encodePNG(width, height, rgb));
      console.log("wrote " + file + "  (" + width + "x" + height + ", t=" + o.atMs + "ms)");
    });
  }

  if (opts.serial) {
    sketch.interp.flushSerial();
    if (sketch.serial.length) {
      console.log("\n--- Serial ---");
      for (const line of sketch.serial) console.log("[" + line.t + "ms] " + line.text);
    } else {
      console.log("\n--- Serial --- (nothing printed)");
    }
  }

  if (opts.stats) {
    const panel = sketch.display;
    console.log("\n--- Stats ---");
    console.log("virtual time   : " + sketch.millis + " ms");
    console.log("loop() calls   : " + sketch.loops.toLocaleString());
    console.log("frames pushed  : " + sketch.frames);
    console.log("measured fps   : " + sketch.fps().toFixed(1));
    console.log("I2C clock      : " + (sketch.interp.i2c.clock / 1000) + " kHz");
    console.log("frame transfer : " + (sketch.interp.i2cFrameMicros() / 1000).toFixed(1) + " ms");
    console.log("max fps at bus : " + (1e6 / sketch.interp.i2cFrameMicros()).toFixed(1));
    if (panel) console.log("pixel writes   : " + panel.stats.pixelWrites.toLocaleString());
    console.log("interp steps   : " + sketch.interp.steps.toLocaleString());
  }
}

function reportError(e, file, source, sketch) {
  // With headers inlined, e.line indexes the flattened source; the sketch can
  // map it back to the file the author actually wrote.
  const where = sketch && e.file ? e.file : path.basename(file);
  const lineNo = sketch && e.sourceLine !== undefined ? e.sourceLine : e.line;

  console.error("\n" + (e.name || "Error") + " in " + (lineNo ? where + ":" + lineNo : where));
  console.error("  " + e.message);

  let text = source;
  if (sketch && e.file && e.file !== path.basename(file)) {
    const candidate = path.resolve(path.dirname(path.resolve(file)), e.file);
    if (fs.existsSync(candidate)) text = fs.readFileSync(candidate, "utf8");
    else text = null;
  }

  if (lineNo && text) {
    const lines = text.split("\n");
    const start = Math.max(0, lineNo - 3);
    const end = Math.min(lines.length, lineNo + 2);
    console.error("");
    for (let i = start; i < end; i++) {
      const marker = i + 1 === lineNo ? " >" : "  ";
      console.error(marker + String(i + 1).padStart(4) + " | " + lines[i]);
    }
  }
  console.error("");
}

main();

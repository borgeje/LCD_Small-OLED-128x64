#!/usr/bin/env node
/*
 * run-tests.js - no-dependency test suite for the simulator.
 *
 *   node simulator/test/run-tests.js
 *
 * The tests that matter most are the ones asserting device behaviour rather
 * than "does it run": integer division truncating, uint8_t wrapping, Arduino's
 * lossy map(), and the exact pixel counts GFX produces. Those are the places a
 * simulator quietly diverges from hardware and stops being worth trusting.
 */
"use strict";

const path = require("path");
const { SSD1306 } = require("../src/display.js");
const { FONT } = require("../src/glcdfont.js");
const { parse } = require("../src/parser.js");
const { Sketch } = require("../src/runtime.js");
const { toCBitmap } = require("../src/renderer.js");

let passed = 0;
const failures = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
}

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name: currentGroup + " › " + name, error: e });
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error((what ? what + ": " : "") + "expected " + b + ", got " + a);
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what || "expected truthy");
}

function near(actual, expected, tolerance, what) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      (what ? what + ": " : "") + "expected " + expected + " +/- " + tolerance +
        ", got " + actual
    );
  }
}

/*
 * Run a sketch and hand back the panel state. With ms = 0 that means "up to
 * the first latched frame" -- running to virtual time zero would stop before
 * setup() had executed a single statement.
 */
function run(source, ms, opts) {
  const s = new Sketch(source, opts);
  if (!ms) s.nextFrame({ wallMs: 10000 });
  else s.runUntil(ms, { wallMs: 10000 });
  if (s.error) throw s.error;
  return s;
}

function litCount(panel) {
  let n = 0;
  for (let y = 0; y < panel.HEIGHT; y++) {
    for (let x = 0; x < panel.WIDTH; x++) n += panel.getPixel(x, y);
  }
  return n;
}

// A minimal sketch wrapper, so each test is just the body of setup().
function sketchOf(body, loopBody) {
  return (
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  display.clearDisplay();\n" +
    "  display.setTextColor(SSD1306_WHITE);\n" +
    body +
    "\n  display.display();\n}\n" +
    "void loop() {" + (loopBody || "") + "}\n"
  );
}

/* ------------------------------------------------------------------ */
group("font");

check("table is 256 glyphs x 5 columns", () => {
  eq(FONT.length, 1280);
});

check("glyph 'A' matches Adafruit glcdfont", () => {
  eq(Array.from(FONT.slice(0x41 * 5, 0x41 * 5 + 5)), [0x7c, 0x12, 0x11, 0x12, 0x7c]);
});

check("space is blank", () => {
  eq(Array.from(FONT.slice(0x20 * 5, 0x20 * 5 + 5)), [0, 0, 0, 0, 0]);
});

/* ------------------------------------------------------------------ */
group("GFX primitives");

check("fillRect lights exactly w*h pixels", () => {
  const d = new SSD1306(128, 64);
  d.fillRect(10, 10, 20, 15, 1);
  eq(litCount(d), 300);
});

check("drawRect lights the perimeter only", () => {
  const d = new SSD1306(128, 64);
  d.drawRect(0, 0, 10, 8, 1);
  eq(litCount(d), 2 * 10 + 2 * 8 - 4);
});

check("fillScreen lights every pixel", () => {
  const d = new SSD1306(128, 64);
  d.fillScreen(1);
  eq(litCount(d), 128 * 64);
});

check("BLACK clears, INVERSE toggles", () => {
  const d = new SSD1306(128, 64);
  d.fillRect(0, 0, 8, 8, 1);
  d.fillRect(0, 0, 4, 8, 0);
  eq(litCount(d), 32);
  d.fillRect(0, 0, 8, 8, 2); // INVERSE
  eq(litCount(d), 32);
});

check("circle is symmetric about its centre", () => {
  const d = new SSD1306(128, 64);
  d.drawCircle(32, 32, 10, 1);
  for (let dx = -10; dx <= 10; dx++) {
    for (let dy = -10; dy <= 10; dy++) {
      eq(d.getPixel(32 + dx, 32 + dy), d.getPixel(32 - dx, 32 + dy), "mirror x");
      eq(d.getPixel(32 + dx, 32 + dy), d.getPixel(32 + dx, 32 - dy), "mirror y");
    }
  }
});

check("fillCircle covers its own outline", () => {
  const outline = new SSD1306(128, 64);
  outline.drawCircle(30, 30, 12, 1);
  const filled = new SSD1306(128, 64);
  filled.fillCircle(30, 30, 12, 1);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      if (outline.getPixel(x, y)) ok(filled.getPixel(x, y), "outline pixel " + x + "," + y);
    }
  }
});

check("drawLine is endpoint-inclusive", () => {
  const d = new SSD1306(128, 64);
  d.drawLine(0, 0, 0, 9, 1);
  eq(litCount(d), 10);
});

check("negative-width fast lines draw backwards", () => {
  const d = new SSD1306(128, 64);
  d.drawFastHLine(20, 5, -10, 1);
  eq(litCount(d), 10);
  eq(d.getPixel(20, 5), 1);
  eq(d.getPixel(11, 5), 1);
});

check("drawBitmap unpacks MSB-first rows", () => {
  const d = new SSD1306(128, 64);
  d.drawBitmap(0, 0, [0b10000001], 8, 1, 1);
  eq(d.getPixel(0, 0), 1);
  eq(d.getPixel(7, 0), 1);
  eq(litCount(d), 2);
});

check("drawXBitmap unpacks LSB-first rows", () => {
  const d = new SSD1306(128, 64);
  d.drawXBitmap(0, 0, [0b00000011], 8, 1, 1);
  eq(d.getPixel(0, 0), 1);
  eq(d.getPixel(1, 0), 1);
  eq(litCount(d), 2);
});

check("off-screen drawing is clipped, not wrapped", () => {
  const d = new SSD1306(128, 64);
  d.fillRect(120, 60, 20, 20, 1);
  eq(litCount(d), 8 * 4);
});

/* ------------------------------------------------------------------ */
group("text");

check("size 1 cell is 6x8 and advances the cursor", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("AB");
  eq(d.getCursorX(), 12);
});

check("'Hello, OLED' renders the expected pixel count", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("Hello, OLED");
  eq(litCount(d), 132);
});

check("newline returns to x=0 and drops 8*size", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setTextSize(2);
  d.setCursor(30, 4);
  d.printString("\n");
  eq([d.getCursorX(), d.getCursorY()], [0, 20]);
});

check("text wraps at the right edge when enabled", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("012345678901234567890"); // 21 chars = exactly 126 px
  eq(d.getCursorY(), 0, "21 chars still fit");
  d.printString("X");
  eq(d.getCursorY(), 8, "the 22nd wraps to the next line");
});

check("wrap can be turned off", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setTextWrap(false);
  d.setCursor(0, 0);
  d.printString("0123456789012345678901234");
  eq(d.getCursorY(), 0);
});

check("size scales glyphs by exactly N", () => {
  const one = new SSD1306(128, 64);
  one.setTextColor(1);
  one.setCursor(0, 0);
  one.printString("8");
  const three = new SSD1306(128, 64);
  three.setTextColor(1);
  three.setTextSize(3);
  three.setCursor(0, 0);
  three.printString("8");
  eq(litCount(three), litCount(one) * 9, "size 3 is 9x the area");
});

check("opaque background fills the whole cell", () => {
  const d = new SSD1306(128, 64);
  d.setTextColor(0, 1); // black on white
  d.setCursor(0, 0);
  d.printString(" ");
  eq(litCount(d), 6 * 8, "blank glyph, opaque background");
});

check("getTextBounds measures what print() draws", () => {
  const d = new SSD1306(128, 64);
  d.setTextSize(2);
  const b = d.getTextBounds("ABC", 0, 0);
  eq([b.w, b.h], [36, 16]);
});

/* ------------------------------------------------------------------ */
group("panel state");

check("rotation swaps the reported dimensions", () => {
  const d = new SSD1306(128, 64);
  d.setRotation(1);
  eq([d.width(), d.height()], [64, 128]);
  d.setRotation(2);
  eq([d.width(), d.height()], [128, 64]);
});

check("rotation 2 maps a corner to the opposite corner", () => {
  const d = new SSD1306(128, 64);
  d.setRotation(2);
  d.drawPixel(0, 0, 1);
  eq(d.getPixel(127, 63), 1);
});

check("invertDisplay flips the view, not the buffer", () => {
  const d = new SSD1306(128, 64);
  d.drawPixel(0, 0, 1);
  d.invertDisplay(true);
  const snap = d.snapshot();
  eq(snap.pixels[0], 0, "lit pixel reads dark when inverted");
  eq(snap.pixels[1], 1, "dark pixel reads lit when inverted");
  eq(d.getPixel(0, 0), 1, "buffer is untouched");
});

check("display off blanks the glass", () => {
  const d = new SSD1306(128, 64);
  d.fillScreen(1);
  d.ssd1306_command(0xae);
  eq(d.snapshot().pixels.reduce((a, b) => a + b, 0), 0);
});

/* ------------------------------------------------------------------ */
group("C++ semantics");

check("integer division truncates", () => {
  const s = run(sketchOf("  display.print(7 / 2);"), 0);
  eq(litCount(s.display) > 0, true);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("3");
  eq(litCount(s.display), litCount(d), "7/2 printed as 3");
});

check("float division does not truncate", () => {
  const s = run(sketchOf("  float a = 7.0;\n  display.print(a / 2);"), 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("3.50"); // Arduino prints 2 decimals by default
  eq(litCount(s.display), litCount(d));
});

check("uint8_t wraps at 256", () => {
  const s = run(sketchOf("  uint8_t v = 300;\n  display.print(v);"), 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("44");
  eq(litCount(s.display), litCount(d));
});

check("int8_t wraps signed", () => {
  const s = run(sketchOf("  int8_t v = 200;\n  display.print(v);"), 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("-56");
  eq(litCount(s.display), litCount(d));
});

check("map() truncates the way Arduino's does", () => {
  // map(3, 0, 10, 0, 3) is 0 on the device, not 0.9 rounded to 1.
  const s = run(sketchOf("  display.print(map(3, 0, 10, 0, 3));"), 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("0");
  eq(litCount(s.display), litCount(d));
});

check("static locals persist across loop() calls", () => {
  const src =
    "void setup() { Serial.begin(115200); }\n" +
    "void loop() {\n" +
    "  static int n = 0;\n" +
    "  n++;\n" +
    "  Serial.println(n);\n" +
    "  delay(100);\n" +
    "}\n";
  const s = run(src, 450);
  ok(s.serial.length >= 4, "expected 4+ lines, got " + s.serial.length);
  eq(s.serial.slice(0, 4).map((l) => l.text), ["1", "2", "3", "4"]);
});

check("a local without static resets every call", () => {
  const src =
    "void setup() { Serial.begin(115200); }\n" +
    "void loop() {\n" +
    "  int n = 0;\n" +
    "  n++;\n" +
    "  Serial.println(n);\n" +
    "  delay(100);\n" +
    "}\n";
  const s = run(src, 350);
  eq(s.serial.slice(0, 3).map((l) => l.text), ["1", "1", "1"]);
});

check("switch falls through without break", () => {
  const s = run(
    sketchOf(
      "  int hits = 0;\n" +
      "  switch (1) {\n" +
      "    case 1: hits++;\n" +
      "    case 2: hits++; break;\n" +
      "    case 3: hits++;\n" +
      "  }\n" +
      "  display.print(hits);"
    ),
    0
  );
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("2");
  eq(litCount(s.display), litCount(d));
});

check("structs and arrays of structs work", () => {
  const src = sketchOf(
    "  struct P { int x; int y; };\n" +
    "  P pts[3];\n" +
    "  for (int i = 0; i < 3; i++) { pts[i].x = i * 10; pts[i].y = i * 5; }\n" +
    "  for (int i = 0; i < 3; i++) display.drawPixel(pts[i].x, pts[i].y, SSD1306_WHITE);"
  );
  const s = run(src, 0);
  eq(litCount(s.display), 3);
  eq(s.display.getPixel(20, 10), 1);
});

check("struct assignment copies rather than aliases", () => {
  const src = sketchOf(
    "  struct P { int x; };\n" +
    "  P a; a.x = 1;\n" +
    "  P b = a; b.x = 9;\n" +
    "  display.print(a.x);"
  );
  const s = run(src, 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("1");
  eq(litCount(s.display), litCount(d));
});

check("pointers write through to the caller", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void bump(int *v) { *v = *v + 41; }\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  display.setTextColor(1);\n" +
    "  int n = 1; bump(&n);\n" +
    "  display.setCursor(0,0); display.print(n); display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  const d = new SSD1306(128, 64);
  d.setTextColor(1);
  d.setCursor(0, 0);
  d.printString("42");
  eq(litCount(s.display), litCount(d));
});

check("arrays pass by reference", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void fill(int a[], int n) { for (int i = 0; i < n; i++) a[i] = i; }\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  int buf[5]; fill(buf, 5);\n" +
    "  for (int i = 0; i < 5; i++) display.drawPixel(buf[i], 0, SSD1306_WHITE);\n" +
    "  display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  eq(litCount(s.display), 5);
});

check("PROGMEM arrays read back through pgm_read_byte", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "const uint8_t bits[] PROGMEM = { 0xFF, 0x00 };\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  display.drawBitmap(0, 0, bits, 8, 2, SSD1306_WHITE);\n" +
    "  uint8_t first = pgm_read_byte(&bits[0]);\n" +
    "  if (first == 0xFF) display.drawPixel(100, 40, SSD1306_WHITE);\n" +
    "  display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  eq(litCount(s.display), 9, "8 bitmap pixels + the pgm_read_byte probe");
});

/* ------------------------------------------------------------------ */
group("preprocessor");

check("#define substitutes into expressions", () => {
  const ast = parse("#define W 128\nint a = W;\n");
  eq(ast.decls[0].declarators[0].init.value, 128);
});

check("function-like macros expand with arguments", () => {
  const src = sketchOf(
    "#define HALF(x) ((x) / 2)\n  display.drawPixel(HALF(20), HALF(10), SSD1306_WHITE);"
  );
  const s = run(src, 0);
  eq(s.display.getPixel(10, 5), 1);
});

check("#ifdef excludes the untaken branch", () => {
  const ast = parse("#ifdef NOPE\nint dead = 1;\n#else\nint alive = 2;\n#endif\n");
  eq(ast.decls.length, 1);
  eq(ast.decls[0].declarators[0].name, "alive");
});

check("#include is recorded, not fetched", () => {
  const ast = parse("#include <Wire.h>\n#include \"local.h\"\nint a = 1;\n");
  eq(ast.includes, ["Wire.h", "local.h"]);
});

/* ------------------------------------------------------------------ */
group("timing model");

check("delay() advances the virtual clock", () => {
  const src =
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  Serial.println(millis());\n" +
    "  delay(250);\n" +
    "  Serial.println(millis());\n" +
    "  delay(1000);\n" +
    "  Serial.println(millis());\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 2000);
  near(Number(s.serial[0].text), 0, 2, "before any delay");
  near(Number(s.serial[1].text), 250, 2, "after delay(250)");
  near(Number(s.serial[2].text), 1250, 2, "after a further delay(1000)");
});

check("a frame's transfer time is charged on top of delay()", () => {
  // setup() delays 250 ms and then pushes a frame at the default 100 kHz,
  // which costs a further 93.6 ms of bus time.
  const s = run(sketchOf("  delay(250);"), 0);
  near(s.millis, 250 + 93.6, 3);
});

check("a frame costs the real I2C transfer time", () => {
  const at400 = run(sketchOf("  Wire.setClock(400000);"), 0);
  near(at400.interp.i2cFrameMicros(), 23400, 200, "400 kHz frame");

  const at100 = run(sketchOf("  Wire.setClock(100000);"), 0);
  near(at100.interp.i2cFrameMicros(), 93600, 500, "100 kHz frame");
});

check("frame rate is capped by the bus, not the sketch", () => {
  // No delay() at all: the ceiling should be the I2C transfer time.
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() { Wire.setClock(400000); display.begin(SSD1306_SWITCHCAPVCC, 0x3C); }\n" +
    "void loop() { display.clearDisplay(); display.display(); }\n";
  const s = run(src, 1000);
  ok(s.fps() < 45, "fps should be near the 42.7 ceiling, got " + s.fps().toFixed(1));
  ok(s.fps() > 30, "fps should not be far below the ceiling, got " + s.fps().toFixed(1));
});

check("millis() advances without any delay() call", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "unsigned long seen = 0;\n" +
    "void setup() { display.begin(SSD1306_SWITCHCAPVCC, 0x3C); }\n" +
    "void loop() { seen = millis(); }\n";
  const s = run(src, 50);
  ok(s.millis >= 50, "clock reached " + s.millis);
});

/* ------------------------------------------------------------------ */
group("I/O");

check("analogRead returns the seeded value", () => {
  const s = new Sketch(
    sketchOf("  int v = analogRead(A0);\n  display.drawPixel(v / 100, 0, SSD1306_WHITE);")
  );
  s.setAnalog(36, 2500); // A0 on the ESP32 map
  s.nextFrame({ wallMs: 5000 });
  eq(s.display.getPixel(25, 0), 1);
});

check("pins the sketch reads are tracked", () => {
  const s = run(sketchOf("  analogRead(A0);\n  digitalRead(4);"), 0);
  const pins = Array.from(s.interp.io.pinsRead).sort((a, b) => a - b);
  eq(pins, [4, 36]);
});

check("INPUT_PULLUP with nothing attached reads HIGH", () => {
  const s = run(
    sketchOf("  pinMode(4, INPUT_PULLUP);\n  if (digitalRead(4) == HIGH) display.drawPixel(1, 1, SSD1306_WHITE);"),
    0
  );
  eq(s.display.getPixel(1, 1), 1);
});

check("Serial output is captured with timestamps", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() { Serial.begin(115200); Serial.println(F(\"ready\")); }\n" +
    "void loop() { delay(100); Serial.print(\"tick \"); Serial.println(millis()); }\n";
  const s = run(src, 250);
  ok(s.serial.length >= 3, "got " + s.serial.length + " lines");
  eq(s.serial[0].text, "ready");
  ok(/^tick \d+$/.test(s.serial[1].text), "formatted line: " + s.serial[1].text);
});

check("Serial.printf formats like C", () => {
  const src =
    "void setup() { Serial.printf(\"%d %.2f %s %02X\\n\", 7, 1.5, \"hi\", 255); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  s.interp.flushSerial();
  eq(s.serial[0].text, "7 1.50 hi FF");
  ok(s.frames === 0, "this sketch has no display at all");
});

/* ------------------------------------------------------------------ */
group("errors");

check("an undeclared name reports its line", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  int a = undefinedThing;\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  eq(s.error.line, 5);
  ok(/undefinedThing/.test(s.error.message), s.error.message);
});

check("a syntax error is raised at construction with a line", () => {
  let err = null;
  try {
    new Sketch("void setup() { int x = ; }\nvoid loop() {}\n");
  } catch (e) {
    err = e;
  }
  ok(err, "expected a CompileError");
  eq(err.line, 1);
});

check("an out-of-bounds array index is caught", () => {
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "int a[4];\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  a[9] = 1;\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected a runtime error");
  eq(s.error.line, 6);
  ok(/out of bounds/.test(s.error.message), s.error.message);
});

check("a U8g2 sketch names the library, not the symbol", () => {
  const src =
    "#include <U8g2lib.h>\n" +
    "U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);\n" +
    "void setup() { u8g2.begin(); }\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  ok(/U8g2/.test(s.error.message), s.error.message);
  ok(/not emulated/.test(s.error.message), s.error.message);
  eq(s.error.line, 2);
});

check("a WiFi sketch says there is no network", () => {
  const src =
    "#include <WiFi.h>\n" +
    "void setup() { WiFi.begin(\"ssid\", \"pw\"); }\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  ok(/not emulated/.test(s.error.message), s.error.message);
});

check("an unrelated library handle stays inert instead of failing", () => {
  // The display code is the part under test; an unused handle must not stop it.
  const src =
    "#include <Adafruit_SSD1306.h>\n" +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "SomeVendorSensor sensor(1, 2);\n" +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  sensor.begin();\n" +
    "  display.fillRect(0, 0, 4, 4, SSD1306_WHITE);\n" +
    "  display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  eq(litCount(s.display), 16);
});

check("a sketch with no display reports no frames", () => {
  const s = new Sketch("void setup() {}\nvoid loop() { delay(10); }\n");
  s.runUntil(100, { wallMs: 5000 });
  ok(!s.error, "should not be an error, just nothing to draw");
  eq(s.snapshot(), null);
});

check("an unemulated method names itself", () => {
  const src = sketchOf("  display.setFont(NULL);\n  display.notARealMethod(1);");
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  ok(/notARealMethod/.test(s.error.message), s.error.message);
});

/* ------------------------------------------------------------------ */
group("export");

check("C bitmap round-trips through drawBitmap", () => {
  const d = new SSD1306(128, 64);
  d.fillCircle(64, 32, 20, 1);
  d.drawRect(2, 2, 40, 20, 1);
  const snap = d.snapshot();

  const text = toCBitmap(snap, "frame");
  const bytes = (text.match(/0x[0-9A-F]{2}/g) || []).map((h) => parseInt(h, 16));
  eq(bytes.length, (128 / 8) * 64, "byte count");

  const back = new SSD1306(128, 64);
  back.drawBitmap(0, 0, bytes, 128, 64, 1);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 128; x++) {
      eq(back.getPixel(x, y), d.getPixel(x, y), "pixel " + x + "," + y);
    }
  }
});

/* ------------------------------------------------------------------ */
group("bundled examples");

const fs = require("fs");
const exDir = path.join(__dirname, "..", "examples");
for (const file of fs.readdirSync(exDir).filter((f) => f.endsWith(".ino")).sort()) {
  check(file + " runs and draws", () => {
    const source = fs.readFileSync(path.join(exDir, file), "utf8");
    const s = new Sketch(source);
    s.runUntil(3000, { wallMs: 20000 });
    if (s.error) throw s.error;
    ok(s.display, "constructed a display");
    ok(s.frames > 0, "pushed at least one frame");
    ok(litCount(s.display) > 0, "lit at least one pixel");
  });
}

check("src/examples.js is in sync with examples/*.ino", () => {
  const { EXAMPLES } = require("../src/examples.js");
  const files = fs.readdirSync(exDir).filter((f) => f.endsWith(".ino")).sort();
  eq(EXAMPLES.map((e) => e.file), files, "file list");
  for (const e of EXAMPLES) {
    const onDisk = fs.readFileSync(path.join(exDir, e.file), "utf8");
    if (onDisk !== e.source) {
      throw new Error(
        e.file + " differs from the bundle. Run: node simulator/tools/bundle-examples.js"
      );
    }
  }
});

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.log("");
  for (const f of failures) {
    console.log("FAIL  " + f.name);
    console.log("      " + f.error.message.split("\n").join("\n      "));
  }
  console.log("\n" + passed + " passed, " + failures.length + " failed\n");
  process.exit(1);
}

console.log(passed + " tests passed");

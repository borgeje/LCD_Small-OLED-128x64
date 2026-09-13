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

const fs = require("fs");
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
group("classes");

// A class, a subclass overriding one method, and a shared base field.
const CLASS_SRC =
  "#include <Adafruit_SSD1306.h>\n" +
  "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
  "class Shape {\n" +
  "public:\n" +
  "  Shape(int x) : ox(x), drawn(0) {}\n" +
  "  virtual void draw() = 0;\n" +
  "  virtual const char *name() { return \"shape\"; }\n" +
  "  void tally() { drawn++; }\n" +
  "  int ox;\n" +
  "  int drawn;\n" +
  "};\n" +
  "class Box : public Shape {\n" +
  "public:\n" +
  "  Box(int x, int w) : Shape(x), width(w) {}\n" +
  "  void draw() override { tally(); display.fillRect(ox, 0, width, 4, SSD1306_WHITE); }\n" +
  "  const char *name() override { return \"box\"; }\n" +
  "  int width;\n" +
  "};\n" +
  "class Dot : public Shape {\n" +
  "public:\n" +
  "  Dot(int x) : Shape(x) {}\n" +
  "  void draw() override { this->tally(); display.drawPixel(this->ox, 20, SSD1306_WHITE); }\n" +
  "};\n";

check("a subclass overrides a virtual method", () => {
  const src = CLASS_SRC +
    "void setup() {\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  Shape *s = new Box(0, 10);\n" +
    "  s->draw();\n" +
    "  display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  eq(litCount(s.display), 40, "the Box override drew, not the base");
});

check("calls through a base pointer are dynamically bound", () => {
  const src = CLASS_SRC +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  Shape *shapes[2];\n" +
    "  shapes[0] = new Box(0, 10);\n" +
    "  shapes[1] = new Dot(50);\n" +
    "  for (int i = 0; i < 2; i++) { shapes[i]->draw(); Serial.println(shapes[i]->name()); }\n" +
    "  display.display();\n" +
    "}\nvoid loop() {}\n";
  const s = run(src, 0);
  eq(litCount(s.display), 41, "10x4 box plus one dot");
  eq(s.serial.map((l) => l.text), ["box", "shape"], "Dot inherits name()");
});

check("a base constructor runs through the member init list", () => {
  const src = CLASS_SRC +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  Box b(7, 3);\n" +
    "  Serial.println(b.ox);\n" +
    "  Serial.println(b.width);\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial.map((l) => l.text), ["7", "3"]);
});

check("a method reaches a sibling method and an inherited field", () => {
  const src = CLASS_SRC +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  Box b(0, 2);\n" +
    "  b.draw(); b.draw(); b.draw();\n" +
    "  Serial.println(b.drawn);\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "3", "tally() ran on the base field each time");
});

check("a constructor parameter shadows the field it initialises", () => {
  const src =
    "class Holder {\n" +
    "public:\n" +
    "  Holder(int value) : value(value) {}\n" +
    "  int value;\n" +
    "};\n" +
    "void setup() { Serial.begin(115200); Holder h(42); Serial.println(h.value); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "42");
});

check("out-of-line method definitions attach to their class", () => {
  const src =
    "class Counter {\n" +
    "public:\n" +
    "  Counter();\n" +
    "  void bump();\n" +
    "  int n;\n" +
    "};\n" +
    "Counter::Counter() : n(10) {}\n" +
    "void Counter::bump() { n = n + 5; }\n" +
    "void setup() { Serial.begin(115200); Counter c; c.bump(); Serial.println(c.n); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "15");
});

check("an object reached through a pointer is shared, not copied", () => {
  const src = CLASS_SRC +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    "  Box *a = new Box(0, 1);\n" +
    "  Box *b = a;\n" +
    "  b->draw();\n" +
    "  Serial.println(a->drawn);\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "1", "both names refer to one object");
});

check("a class-typed member is constructed with its owner", () => {
  const src =
    "class Inner { public: Inner() : v(9) {} int v; };\n" +
    "class Outer { public: Outer() {} Inner inner; };\n" +
    "void setup() { Serial.begin(115200); Outer o; Serial.println(o.inner.v); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "9");
});

check("calling a pure virtual says so", () => {
  const src = CLASS_SRC +
    "class Blank : public Shape { public: Blank() : Shape(0) {} };\n" +
    "void setup() { display.begin(SSD1306_SWITCHCAPVCC, 0x3C); Shape *s = new Blank(); s->draw(); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  ok(/pure virtual/.test(s.error.message), s.error.message);
});

check("an uninitialised object pointer is null and tests false", () => {
  const src =
    "class Thing { public: Thing() {} int v; };\n" +
    "Thing *slot[3];\n" +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  slot[1] = new Thing();\n" +
    "  int found = 0;\n" +
    "  for (int i = 0; i < 3; i++) if (slot[i]) found++;\n" +
    "  Serial.println(found);\n" +
    "}\nvoid loop() {}\n";
  const s = new Sketch(src);
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "1");
});

/* ------------------------------------------------------------------ */
group("multi-file sketches");

// Headers are supplied in memory, the same hook the CLI fills from disk.
const HEADERS = {
  "math.h": "#pragma once\nint twice(int v) { return v * 2; }\n",
  "bad.h": "#pragma once\nint oops(int v) { return v + missingName; }\n",
  "chain.h": '#pragma once\n#include "math.h"\nint quad(int v) { return twice(twice(v)); }\n',
};
const resolveInclude = (name) =>
  HEADERS[name] ? { source: HEADERS[name], path: name } : null;

check("a local #include is inlined and its functions callable", () => {
  const src =
    '#include <Adafruit_SSD1306.h>\n#include "math.h"\n' +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    "void setup() { Serial.begin(115200); Serial.println(twice(21)); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src, { resolveInclude, fileName: "test.ino" });
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "42");
});

check("nested includes resolve, and repeats are included once", () => {
  const src =
    '#include "math.h"\n#include "chain.h"\n#include "math.h"\n' +
    "void setup() { Serial.begin(115200); Serial.println(quad(3)); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src, { resolveInclude, fileName: "test.ino" });
  s.runUntil(10, { wallMs: 5000 });
  if (s.error) throw s.error;
  eq(s.serial[0].text, "12");
});

check("an error inside a header reports that header's own line", () => {
  const src =
    '#include "bad.h"\n' +
    "void setup() { Serial.begin(115200); Serial.println(oops(1)); }\n" +
    "void loop() {}\n";
  const s = new Sketch(src, { resolveInclude, fileName: "test.ino" });
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  eq(s.error.file, "bad.h", "blamed the right file");
  eq(s.error.sourceLine, 2, "line within bad.h");
});

check("a line in the main sketch still maps to the sketch", () => {
  const src =
    '#include "math.h"\n' +
    "void setup() { int a = alsoMissing; }\n" +
    "void loop() {}\n";
  const s = new Sketch(src, { resolveInclude, fileName: "test.ino" });
  s.runUntil(10, { wallMs: 5000 });
  ok(s.error, "expected an error");
  eq(s.error.file, "test.ino");
  eq(s.error.sourceLine, 2);
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
group("glance framework");

// Resolve the framework's real headers off disk, the same way the CLI does.
const firmwareDir = path.join(__dirname, "..", "..", "firmware", "glance");
const resolveFirmware = (name) => {
  const file = path.join(firmwareDir, name);
  return fs.existsSync(file)
    ? { source: fs.readFileSync(file, "utf8"), path: name }
    : null;
};

function firmwareSketch(body, globals) {
  return (
    "#include <Wire.h>\n#include <Adafruit_GFX.h>\n#include <Adafruit_SSD1306.h>\n" +
    '#include "WidgetHost.h"\n' +
    "Adafruit_SSD1306 display(128, 64, &Wire, -1);\n" +
    (globals || "") +
    "void setup() {\n" +
    "  Serial.begin(115200);\n" +
    "  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);\n" +
    body +
    "}\n"
  );
}

function runFirmware(src, ms) {
  const s = new Sketch(src, { resolveInclude: resolveFirmware, fileName: "test.ino" });
  s.runUntil(ms, { wallMs: 30000 });
  if (s.error) throw s.error;
  return s;
}

check("Series keeps the most recent SERIES_MAX samples", () => {
  const src = firmwareSketch(
    "  Series s;\n" +
    "  for (int i = 0; i < 70; i++) s.push(i);\n" +
    "  Serial.println(s.size());\n" +
    "  Serial.println(s.at(0));\n" +
    "  Serial.println(s.latest());\n" +
    "  Serial.println(s.minValue());\n" +
    "  Serial.println(s.maxValue());\n" +
    "  Serial.println(s.deltaOver(10));\n"
  ) + "void loop() {}\n";
  const s = runFirmware(src, 10);
  // 70 pushed, 64 retained: 6..69.
  eq(s.serial.map((l) => l.text), ["64", "6", "69", "6", "69", "10"]);
});

check("Ui.fitSize picks the largest text size that fits", () => {
  const src = firmwareSketch(
    "  Ui ui; ui.d = &display;\n" +
    "  Serial.println(ui.fitSize(\"1234\", 104));\n" +   // 4*6*4 = 96
    "  Serial.println(ui.fitSize(\"123456\", 104));\n" + // needs size 2
    "  Serial.println(ui.fitSize(\"88:88\", 128));\n"
  ) + "void loop() {}\n";
  const s = runFirmware(src, 10);
  eq(s.serial.map((l) => l.text), ["4", "2", "4"]);
});

check("the host rotates between widgets on their dwell time", () => {
  const globals =
    "class ProbeA : public Widget {\n" +
    "public:\n" +
    "  const char *name() override { return \"A\"; }\n" +
    "  unsigned long dwellMs() override { return 200; }\n" +
    "  void render(Ui &ui) override { Serial.println(\"A\"); ui.pixel(0, 0); }\n" +
    "};\n" +
    "class ProbeB : public Widget {\n" +
    "public:\n" +
    "  const char *name() override { return \"B\"; }\n" +
    "  unsigned long dwellMs() override { return 200; }\n" +
    "  void render(Ui &ui) override { Serial.println(\"B\"); ui.pixel(10, 0); }\n" +
    "};\n" +
    "WidgetHost host(display);\n" +
    "ProbeA a;\nProbeB b;\n";
  const src = firmwareSketch(
    "  host.add(&a);\n  host.add(&b);\n" +
    "  host.setFrameInterval(50);\n  host.begin();\n",
    globals
  ) + "void loop() { host.tick(millis()); delay(5); }\n";

  const s = runFirmware(src, 900);
  const seen = s.serial.map((l) => l.text);
  ok(seen.indexOf("A") >= 0, "A never rendered");
  ok(seen.indexOf("B") >= 0, "B never rendered");
});

check("an urgent widget takes the screen and keeps it", () => {
  const globals =
    "class Calm : public Widget {\n" +
    "public:\n" +
    "  unsigned long dwellMs() override { return 200; }\n" +
    "  void render(Ui &ui) override { Serial.println(\"calm\"); }\n" +
    "};\n" +
    "class Alarm : public Widget {\n" +
    "public:\n" +
    "  unsigned long dwellMs() override { return 200; }\n" +
    "  bool urgent() override { return millis() > 600; }\n" +
    "  void render(Ui &ui) override { Serial.println(\"alarm\"); }\n" +
    "};\n" +
    "WidgetHost host(display);\n" +
    "Calm calm;\nAlarm alarm;\n";
  const src = firmwareSketch(
    "  host.add(&calm);\n  host.add(&alarm);\n" +
    "  host.setFrameInterval(50);\n  host.begin();\n",
    globals
  ) + "void loop() { host.tick(millis()); delay(5); }\n";

  const s = runFirmware(src, 1400);
  const early = s.serial.filter((l) => l.t < 500).map((l) => l.text);
  const late = s.serial.filter((l) => l.t > 800).map((l) => l.text);
  ok(early.indexOf("calm") >= 0, "calm should show before the alarm trips");
  ok(late.length > 3, "expected frames after the alarm tripped");
  eq(
    late.filter((x) => x !== "alarm").length,
    0,
    "once urgent, nothing else gets the screen"
  );
});

check("a short button press advances, a long press pins", () => {
  const globals =
    "class One : public Widget {\n" +
    "public:\n" +
    "  unsigned long dwellMs() override { return 100000; }\n" +   // never rotates on its own
    "  void render(Ui &ui) override { Serial.println(\"one\"); }\n" +
    "};\n" +
    "class Two : public Widget {\n" +
    "public:\n" +
    "  unsigned long dwellMs() override { return 100000; }\n" +
    "  void render(Ui &ui) override { Serial.println(\"two\"); }\n" +
    "};\n" +
    "WidgetHost host(display);\n" +
    "One one;\nTwo two;\n";
  const src = firmwareSketch(
    "  host.add(&one);\n  host.add(&two);\n" +
    "  host.setButton(4);\n" +
    "  host.setFrameInterval(50);\n  host.begin();\n",
    globals
  ) + "void loop() { host.tick(millis()); delay(5); }\n";

  const s = new Sketch(src, { resolveInclude: resolveFirmware, fileName: "test.ino" });

  // The dwell is effectively infinite, so only the button can change screens.
  s.runUntil(300, { wallMs: 20000 });
  if (s.error) throw s.error;
  const before = s.serial.map((l) => l.text);
  eq(before[before.length - 1], "one", "starts on the first widget");

  s.setDigital(4, 0);                        // press
  s.runUntil(400, { wallMs: 20000 });
  s.setDigital(4, 1);                        // release, well under the long-press
  s.runUntil(700, { wallMs: 20000 });
  if (s.error) throw s.error;
  const after = s.serial.map((l) => l.text);
  eq(after[after.length - 1], "two", "a short press advanced the screen");
});

check("glance.ino runs, rotates, and reaches its alarm states", () => {
  const entry = path.join(firmwareDir, "glance.ino");
  const src = fs.readFileSync(entry, "utf8");
  const s = new Sketch(src, { resolveInclude: resolveFirmware, fileName: "glance.ino" });
  s.runUntil(30000, { wallMs: 60000 });
  if (s.error) throw s.error;
  ok(s.frames > 100, "expected a few hundred frames, got " + s.frames);
  ok(litCount(s.display) > 0, "something is on screen");
  // 10 fps requested via setFrameInterval(100).
  near(s.fps(), 10, 2.5, "frame pacing");
});

check("the flattened example matches the firmware it came from", () => {
  const { flatten } = require("../tools/flatten.js");
  const entry = path.join(firmwareDir, "glance.ino");
  const generated = flatten(entry);
  const onDisk = fs.readFileSync(
    path.join(__dirname, "..", "examples", "06-glance-framework.ino"), "utf8"
  );
  // The file on disk carries a generated-by banner ahead of the same body.
  if (onDisk.indexOf(generated) < 0) {
    throw new Error(
      "06-glance-framework.ino is stale. Run:\n" +
      "  node simulator/tools/flatten.js firmware/glance/glance.ino " +
      "simulator/examples/06-glance-framework.ino"
    );
  }
});

/* ------------------------------------------------------------------ */
group("bundled examples");

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

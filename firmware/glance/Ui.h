#pragma once
/*
 * Ui.h - the drawing vocabulary every widget shares.
 *
 * Two things live here. `Series` is a ring buffer of recent readings, because
 * almost every useful screen on this panel is "one number plus where it has
 * been". `Ui` wraps the display with helpers built around the one constraint
 * that matters at 0.96": the active area is 21.7 x 10.9 mm, so a glyph at
 * text size 1 is 1.4 mm tall and you cannot read it from more than about a
 * foot away.
 *
 * That is why bigValue() picks its own text size instead of taking one. You
 * tell it what to say and how much room it has; it uses the largest size that
 * fits, which is almost always the right call on a screen this small.
 *
 * Every helper offsets by (ox, oy). The host nudges that by a pixel now and
 * then so a screen left on for months does not etch itself into the panel.
 */

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SERIES_MAX 64

// A fixed-size ring of recent samples. No allocation, no growth.
class Series {
public:
  Series() : count(0), head(0) {}

  void push(int v) {
    values[head] = v;
    head = (head + 1) % SERIES_MAX;
    if (count < SERIES_MAX) count++;
  }

  int size() { return count; }

  // at(0) is the oldest retained sample, at(size()-1) the newest.
  int at(int i) {
    if (i < 0 || i >= count) return 0;
    int start = (count < SERIES_MAX) ? 0 : head;
    return values[(start + i) % SERIES_MAX];
  }

  int latest() { return count ? at(count - 1) : 0; }

  int minValue() {
    if (!count) return 0;
    int lo = at(0);
    for (int i = 1; i < count; i++) if (at(i) < lo) lo = at(i);
    return lo;
  }

  int maxValue() {
    if (!count) return 0;
    int hi = at(0);
    for (int i = 1; i < count; i++) if (at(i) > hi) hi = at(i);
    return hi;
  }

  // Change over the last n samples. The window matters: too short and a
  // trend label disagrees with the sparkline right below it.
  int deltaOver(int n) {
    if (count < n + 1) return 0;
    return at(count - 1) - at(count - 1 - n);
  }

private:
  int values[SERIES_MAX];
  int count;
  int head;
};

class Ui {
public:
  Ui() : d(0), ox(0), oy(0) {}

  Adafruit_SSD1306 *d;
  int ox;
  int oy;

  int width() { return 128; }
  int height() { return 64; }

  /* ---- primitives, all offset by the burn-in nudge ---- */

  void pixel(int x, int y) { d->drawPixel(x + ox, y + oy, SSD1306_WHITE); }

  void line(int x0, int y0, int x1, int y1) {
    d->drawLine(x0 + ox, y0 + oy, x1 + ox, y1 + oy, SSD1306_WHITE);
  }

  void hline(int x, int y, int w) { d->drawFastHLine(x + ox, y + oy, w, SSD1306_WHITE); }

  void rect(int x, int y, int w, int h) {
    d->drawRect(x + ox, y + oy, w, h, SSD1306_WHITE);
  }

  void fillRect(int x, int y, int w, int h) {
    d->fillRect(x + ox, y + oy, w, h, SSD1306_WHITE);
  }

  void clearRect(int x, int y, int w, int h) {
    d->fillRect(x + ox, y + oy, w, h, SSD1306_BLACK);
  }

  void circle(int x, int y, int r) {
    d->drawCircle(x + ox, y + oy, r, SSD1306_WHITE);
  }

  void fillCircle(int x, int y, int r) {
    d->fillCircle(x + ox, y + oy, r, SSD1306_WHITE);
  }

  /* ---- text ---- */

  void text(int x, int y, int size, const char *t) {
    d->setTextSize(size);
    d->setTextColor(SSD1306_WHITE);
    d->setCursor(x + ox, y + oy);
    d->print(t);
  }

  void label(int x, int y, const char *t) { text(x, y, 1, t); }

  void centered(int y, int size, const char *t) {
    int w = strlen(t) * 6 * size;
    text((128 - w) / 2, y, size, t);
  }

  // The largest text size whose rendered width fits maxW. A glyph cell is
  // 6*size wide, so this is exact rather than a guess.
  int fitSize(const char *t, int maxW) {
    int len = strlen(t);
    if (len < 1) return 1;
    for (int s = 4; s > 1; s--) {
      if (len * 6 * s <= maxW) return s;
    }
    return 1;
  }

  /*
   * The headline number, sized to fill the space it is given and centred with
   * its unit tucked against it. Pass unit = "" for no unit.
   */
  void bigValue(int y, const char *value, const char *unit) {
    int unitW = strlen(unit) * 6;
    int size = fitSize(value, 128 - unitW - 6);
    int valueW = strlen(value) * 6 * size;
    int totalW = valueW + (strlen(unit) ? unitW + 3 : 0);
    int x = (128 - totalW) / 2;

    text(x, y, size, value);
    if (strlen(unit)) {
      // Sit the unit on the number's baseline, not its top.
      text(x + valueW + 3, y + (size * 8) - 8, 1, unit);
    }
  }

  /* ---- charts ---- */

  /*
   * A sparkline scaled to its own min/max, with an optional dotted line at
   * `marker`. Pass marker = 0 to omit it. A flat series is given a minimum
   * span so it draws as a line through the middle rather than filling the box.
   */
  void sparkline(int x, int y, int w, int h, Series &s, int marker) {
    int n = s.size();
    if (n < 2) return;

    int lo = s.minValue();
    int hi = s.maxValue();
    if (marker > 0) {
      if (marker < lo) lo = marker;
      if (marker > hi) hi = marker;
    }
    if (hi - lo < 4) {
      int mid = (hi + lo) / 2;
      lo = mid - 2;
      hi = mid + 2;
    }

    int prevX = 0;
    int prevY = 0;
    for (int i = 0; i < n; i++) {
      int px = x + (i * (w - 1)) / (n - 1);
      int py = y + h - 1 - ((s.at(i) - lo) * (h - 1)) / (hi - lo);
      if (i > 0) line(prevX, prevY, px, py);
      prevX = px;
      prevY = py;
    }

    if (marker > 0 && marker > lo && marker < hi) {
      int my = y + h - 1 - ((marker - lo) * (h - 1)) / (hi - lo);
      for (int px = x; px < x + w; px += 4) pixel(px, my);
    }
  }

  // A bordered progress bar. pct is clamped, so callers need not.
  void bar(int x, int y, int w, int h, int pct) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    rect(x, y, w, h);
    int inner = w - 4;
    int filled = (inner * pct) / 100;
    if (filled > 0) fillRect(x + 2, y + 2, filled, h - 4);
  }

  /*
   * A full-screen alert. Lights the whole panel and cuts the text out of it,
   * which is what actually catches the eye from across a room -- a few lit
   * glyphs on black do not.
   */
  void banner(const char *t) {
    d->fillScreen(SSD1306_WHITE);
    int size = fitSize(t, 120);
    int w = strlen(t) * 6 * size;
    d->setTextSize(size);
    d->setTextColor(SSD1306_BLACK, SSD1306_WHITE);
    d->setCursor((128 - w) / 2 + ox, (64 - size * 8) / 2 + oy);
    d->print(t);
    d->setTextColor(SSD1306_WHITE);
  }

  // A one-line header with a rule under it, the layout most screens want.
  void header(const char *left, const char *right) {
    label(0, 0, left);
    if (strlen(right)) label(128 - strlen(right) * 6, 0, right);
    hline(0, 9, 128);
  }
};

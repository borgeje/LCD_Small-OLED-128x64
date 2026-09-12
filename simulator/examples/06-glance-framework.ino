/*
 * GENERATED FILE, do not edit.
 *
 * firmware/glance/glance.ino with its local headers inlined, so the
 * browser simulator can run it without a filesystem. Edit the originals in
 * firmware/glance/ and regenerate:
 *
 *   node simulator/tools/flatten.js firmware/glance/glance.ino simulator/examples/06-glance-framework.ino
 */
/*
 * glance.ino - one box, several screens.
 *
 * Wiring only: which widgets exist, in what order, and how the host behaves.
 * Everything else lives in the headers next to this file. Adding a screen is
 * a class with a render() and one host.add() line.
 *
 * Pick a profile below. The point of the framework is that the office box and
 * the garage box are the same firmware with a different three lines.
 *
 * Hardware (see ../../README.md for the full pinout):
 *   OLED VCC -> 3V3, GND -> GND
 *   ESP32 DevKit      SDA GPIO21, SCL GPIO22
 *   XIAO ESP32-C6     SDA D4,     SCL D5
 *   Optional button between BUTTON_PIN and GND (short press: next screen,
 *   long press: pin the current one).
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

/* ===== Ui.h ===== */
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

/* ===== end Ui.h ===== */
/* ===== Widget.h ===== */
/*
 * Widget.h - what a screen has to provide.
 *
 * Deliberately small. A widget samples in update() and draws in render(); it
 * never calls display() itself and never decides when it is on screen. The
 * host owns the panel, the rotation and the clock, which is what keeps
 * widgets to about fifty lines each.
 *
 * update() runs on every tick even when the widget is not showing, so a
 * sparkline keeps filling while other screens are up and urgent() can fire
 * from a widget nobody is looking at.
 */


class Widget {
public:
  // Called once at startup, after the display is up.
  virtual void begin() {}

  // Called every tick, showing or not. Keep it cheap and non-blocking:
  // no delay(), no long I2C reads.
  virtual void update(unsigned long now) {}

  // Draw one frame. The host has already cleared the buffer and will push it.
  virtual void render(Ui &ui) = 0;

  /*
   * Return true to demand the screen. The host switches immediately and stays
   * put while it holds -- this is the freezer alarm interrupting the CO2
   * reading, not a politeness request.
   */
  virtual bool urgent() { return false; }

  // How long this widget holds the screen in the rotation.
  virtual unsigned long dwellMs() { return 6000; }

  // Shown in the startup banner and in serial logs.
  virtual const char *name() { return "widget"; }
};

/* ===== end Widget.h ===== */
/* ===== WidgetHost.h ===== */
/*
 * WidgetHost.h - owns the panel so the widgets do not have to.
 *
 * Responsibilities, all of which are easy to get wrong once per widget and
 * easy to get right once here:
 *
 *   rotation    each widget holds the screen for its own dwell time
 *   urgency     a widget can demand the screen and keep it
 *   pinning     a button press holds the current screen; long press releases
 *   pacing      redraws are rate-limited, because a full frame costs ~23 ms
 *               of I2C time at 400 kHz and nothing glanceable needs 40 fps
 *   burn-in     the whole layout shifts by a pixel periodically, and the
 *               panel inverts briefly now and then, so a screen that sits lit
 *               for months wears evenly
 *   idle        the panel blanks after a period with nothing urgent, which is
 *               both the best burn-in defence and the best power saving
 *
 * update() is called on every widget every tick, not just the visible one, so
 * history keeps accumulating off-screen and urgent() can fire from a widget
 * nobody is currently looking at.
 */


#define MAX_WIDGETS       8
#define JITTER_PERIOD_MS  60000UL    // shift the layout every minute
#define INVERT_PERIOD_MS  1800000UL  // even out wear every 30 minutes
#define INVERT_HOLD_MS    3000UL
#define LONG_PRESS_MS     600UL
#define DEBOUNCE_MS       30UL

class WidgetHost {
public:
  WidgetHost(Adafruit_SSD1306 &display)
      : widgetCount(0), index(0), pinned(false), blanked(false),
        buttonPin(-1), buttonDown(false), buttonSince(0), lastButtonChange(0),
        lastSwitch(0), lastFrame(0), lastJitter(0), lastInvert(0),
        invertUntil(0), idleTimeoutMs(0), lastActivity(0),
        frameIntervalMs(100) {
    panel = &display;
    ui.d = &display;
  }

  void add(Widget *w) {
    if (widgetCount >= MAX_WIDGETS) return;
    widgets[widgetCount] = w;
    widgetCount++;
  }

  // A momentary switch to ground: short press advances, long press pins.
  void setButton(int pin) {
    buttonPin = pin;
    pinMode(pin, INPUT_PULLUP);
  }

  // Blank the panel after this long with nothing urgent. 0 disables.
  void setIdleTimeout(unsigned long ms) { idleTimeoutMs = ms; }

  void setFrameInterval(unsigned long ms) { frameIntervalMs = ms; }

  void begin() {
    for (int i = 0; i < widgetCount; i++) widgets[i]->begin();
    lastSwitch = millis();
    lastActivity = millis();
    splash();
  }

  int count() { return widgetCount; }

  Widget *active() {
    if (!widgetCount) return 0;
    return widgets[index];
  }

  void next() {
    if (!widgetCount) return;
    index = (index + 1) % widgetCount;
    lastSwitch = millis();
    wake();
  }

  void togglePin() {
    pinned = !pinned;
    wake();
  }

  void wake() {
    lastActivity = millis();
    if (blanked) {
      blanked = false;
      panel->ssd1306_command(SSD1306_DISPLAYON);
    }
  }

  /* ---- the loop ---- */

  void tick(unsigned long now) {
    readButton(now);

    for (int i = 0; i < widgetCount; i++) widgets[i]->update(now);

    // Urgency outranks the rotation and the pin both.
    int urgentIndex = findUrgent();
    if (urgentIndex >= 0) {
      if (urgentIndex != index) {
        index = urgentIndex;
        lastSwitch = now;
      }
      wake();
    } else if (!pinned && widgetCount > 1) {
      unsigned long dwell = widgets[index]->dwellMs();
      if (now - lastSwitch >= dwell) {
        index = (index + 1) % widgetCount;
        lastSwitch = now;
      }
    }

    maintainPanel(now);

    if (blanked) return;
    if (now - lastFrame < frameIntervalMs) return;
    lastFrame = now;
    draw();
  }

private:
  Adafruit_SSD1306 *panel;
  Ui ui;
  Widget *widgets[MAX_WIDGETS];
  int widgetCount;
  int index;
  bool pinned;
  bool blanked;

  int buttonPin;
  bool buttonDown;
  unsigned long buttonSince;
  unsigned long lastButtonChange;

  unsigned long lastSwitch;
  unsigned long lastFrame;
  unsigned long lastJitter;
  unsigned long lastInvert;
  unsigned long invertUntil;
  unsigned long idleTimeoutMs;
  unsigned long lastActivity;
  unsigned long frameIntervalMs;

  int findUrgent() {
    for (int i = 0; i < widgetCount; i++) {
      if (widgets[i]->urgent()) return i;
    }
    return -1;
  }

  void draw() {
    panel->clearDisplay();
    if (widgetCount) {
      widgets[index]->render(ui);
      if (pinned) pinMarker();
    } else {
      ui.centered(28, 1, "no widgets");
    }
    panel->display();
  }

  // A dot in the corner, so a pinned screen is distinguishable from a stuck one.
  void pinMarker() {
    panel->fillCircle(125, 3, 2, SSD1306_WHITE);
  }

  /*
   * Burn-in care and idle blanking. The jitter is the important one: an OLED
   * ages with per-pixel on-time, and a static label in the same place for a
   * year leaves a ghost. Moving the whole layout one pixel spreads that over
   * four times the area for no visible cost.
   */
  void maintainPanel(unsigned long now) {
    if (now - lastJitter >= JITTER_PERIOD_MS) {
      lastJitter = now;
      int phase = (now / JITTER_PERIOD_MS) % 4;
      ui.ox = (phase == 1 || phase == 2) ? 1 : 0;
      ui.oy = (phase == 2 || phase == 3) ? 1 : 0;
    }

    if (invertUntil && now >= invertUntil) {
      invertUntil = 0;
      panel->invertDisplay(false);
    } else if (!invertUntil && now - lastInvert >= INVERT_PERIOD_MS) {
      lastInvert = now;
      invertUntil = now + INVERT_HOLD_MS;
      panel->invertDisplay(true);
    }

    if (idleTimeoutMs && !blanked && now - lastActivity >= idleTimeoutMs) {
      blanked = true;
      panel->ssd1306_command(SSD1306_DISPLAYOFF);
    }
  }

  void readButton(unsigned long now) {
    if (buttonPin < 0) return;

    bool down = (digitalRead(buttonPin) == LOW);
    if (down != buttonDown) {
      if (now - lastButtonChange < DEBOUNCE_MS) return;
      lastButtonChange = now;
      buttonDown = down;
      if (down) {
        buttonSince = now;
      } else {
        // Released: short press advances, long press pins or unpins.
        if (now - buttonSince >= LONG_PRESS_MS) togglePin();
        else next();
      }
    }
  }

  void splash() {
    char line[24];
    panel->clearDisplay();
    ui.centered(18, 2, "glance");
    snprintf(line, sizeof(line), "%d screens", widgetCount);
    ui.centered(40, 1, line);
    panel->display();
  }
};

/* ===== end WidgetHost.h ===== */
/* ===== WidgetCo2.h ===== */
/*
 * WidgetCo2.h - office air quality.
 *
 * The canonical shape for this panel: a label, one number sized as large as
 * it will go, and a sparkline of the last half-minute with the threshold
 * marked. Past the alarm level it demands the screen.
 *
 * Hardware: Sensirion SCD40/SCD41 on the same I2C bus as the display
 * (sensor 0x62, display 0x3C - no conflict, no extra pins). Swap readPpm()
 * for scd4x.getCO2() and delete the synthetic curve.
 */


class Co2Widget : public Widget {
public:
  Co2Widget(int warnPpm) : warn(warnPpm), alarm(warnPpm + 400), lastSample(0) {}

  const char *name() override { return "co2"; }
  unsigned long dwellMs() override { return 7000; }

  void update(unsigned long now) override {
    if (lastSample && now - lastSample < 500) return;
    lastSample = now;
    history.push(readPpm(now));
  }

  // Past the alarm the room is genuinely bad; hold the screen until it clears.
  bool urgent() override {
    return history.size() > 0 && history.latest() >= alarm;
  }

  void render(Ui &ui) override {
    char buf[12];
    int ppm = history.latest();

    // A 10 s window, long enough to agree with the sparkline underneath.
    int delta = history.deltaOver(20);
    const char *trend = "steady";
    if (delta > 15) trend = "rising";
    else if (delta < -15) trend = "falling";

    ui.header("CO2", trend);

    snprintf(buf, sizeof(buf), "%d", ppm);
    ui.bigValue(12, buf, "ppm");

    ui.sparkline(0, 46, 128, 18, history, warn);
  }

private:
  /*
   * Stand-in for the sensor: a slow drift with a shorter ripple on top, so
   * the sparkline has something to show and the alarm eventually trips.
   */
  int readPpm(unsigned long now) {
    float t = now / 1000.0;
    return (int)(950.0 + sin(t / 21.0) * 480.0 + sin(t / 3.5) * 40.0);
  }

  Series history;
  int warn;
  int alarm;
  unsigned long lastSample;
};

/* ===== end WidgetCo2.h ===== */
/* ===== WidgetParking.h ===== */
/*
 * WidgetParking.h - garage stop sign.
 *
 * Mounted at windshield height you are about three feet away, so the distance
 * goes out at the largest size that fits and the stop state takes the whole
 * panel. It claims the screen while a car is arriving and gives it back once
 * the bay is empty again.
 *
 * Hardware: VL53L1X time-of-flight sensor (I2C 0x29, shares the bus with the
 * display). Replace readInches() with the library call.
 */


class ParkingWidget : public Widget {
public:
  ParkingWidget(int stopInches, int maxInches)
      : stopAt(stopInches), slowAt(stopInches * 3), maxAt(maxInches),
        inches(999), blinkOn(false), lastSample(0) {}

  const char *name() override { return "parking"; }
  unsigned long dwellMs() override { return 5000; }

  void update(unsigned long now) override {
    if (lastSample && now - lastSample < 50) return;
    lastSample = now;
    inches = readInches(now);
    blinkOn = ((now / 400) % 2) == 0;
  }

  // Anything inside range is the only thing worth showing.
  bool urgent() override { return inches <= maxAt; }

  void render(Ui &ui) override {
    if (inches <= stopAt) {
      // Blink by drawing the lit panel either way and the word only on-phase,
      // so the panel stays bright rather than flashing black.
      if (blinkOn) ui.banner("STOP");
      else ui.d->fillScreen(SSD1306_WHITE);
      return;
    }

    if (inches > maxAt) {
      ui.header("PARKING", "");
      ui.centered(30, 1, "bay empty");
      return;
    }

    char buf[8];
    snprintf(buf, sizeof(buf), "%d", inches);
    ui.header("PULL FORWARD", "");
    ui.bigValue(16, buf, "in");

    // The bar empties as the bumper closes on the mark.
    int span = slowAt - stopAt;
    int over = inches - stopAt;
    if (over < 0) over = 0;
    if (over > span) over = span;
    ui.bar(0, 52, 128, 10, (over * 100) / span);
  }

private:
  /*
   * Stand-in for the rangefinder: a 40 s cycle that leaves the bay empty most
   * of the time, then rolls in and holds at the mark. The long empty stretch
   * matters for the demo -- this widget claims the screen whenever a car is in
   * range, so a sensor that always sees one would starve the rotation.
   */
  int readInches(unsigned long now) {
    unsigned long t = now % 40000;
    if (t < 24000) return maxAt + 60;                 // bay empty
    if (t < 33000) {
      unsigned long k = t - 24000;                     // rolling in
      return maxAt - (int)((k * (maxAt - stopAt + 2)) / 9000);
    }
    return stopAt - 2;                                 // parked
  }

  int stopAt;
  int slowAt;
  int maxAt;
  int inches;
  bool blinkOn;
  unsigned long lastSample;
};

/* ===== end WidgetParking.h ===== */
/* ===== WidgetBuild.h ===== */
/*
 * WidgetBuild.h - CI on the desk.
 *
 * The mark is drawn as geometry rather than set in text, because at this size
 * a glyph is a smudge and a 30 px tick is not. A failure lights the whole
 * panel and cuts the mark out of it, which is what you notice peripherally.
 *
 * Hardware: any Wi-Fi capable ESP32. Poll the GitHub API for the latest check
 * suite conclusion every 30 s or so and map it onto setStatus().
 */


#define BUILD_PASSING 0
#define BUILD_FAILING 1
#define BUILD_RUNNING 2

class BuildWidget : public Widget {
public:
  BuildWidget(const char *branchName)
      : branch(branchName), status(BUILD_RUNNING), reviews(0), spin(0) {}

  const char *name() override { return "build"; }
  unsigned long dwellMs() override { return 6000; }

  // Call this from your polling code.
  void setStatus(int s) { status = s; }
  void setReviews(int n) { reviews = n; }

  void update(unsigned long now) override {
    spin = (now / 80) % 12;
    status = pollStatus(now);
  }

  bool urgent() override { return status == BUILD_FAILING; }

  void render(Ui &ui) override {
    char line[24];
    bool failing = (status == BUILD_FAILING);

    // On a failure everything is drawn in black on a lit panel.
    if (failing) ui.d->fillScreen(SSD1306_WHITE);
    int ink = failing ? SSD1306_BLACK : SSD1306_WHITE;
    ui.d->setTextColor(ink, failing ? SSD1306_WHITE : SSD1306_BLACK);

    if (status == BUILD_PASSING) drawTick(ui, 30, 26, ink);
    else if (failing) drawCross(ui, 30, 26, ink);
    else drawSpinner(ui, 30, 26, ink);

    ui.d->setTextSize(1);
    ui.d->setCursor(58 + ui.ox, 14 + ui.oy);
    ui.d->print(status == BUILD_PASSING ? "passing"
                : (failing ? "FAILED" : "running"));

    ui.d->setCursor(58 + ui.ox, 26 + ui.oy);
    ui.d->print(branch);

    ui.d->drawFastHLine(ui.ox, 48 + ui.oy, 128, ink);
    snprintf(line, sizeof(line), "%d PRs need review", reviews);
    ui.d->setCursor(ui.ox, 54 + ui.oy);
    ui.d->print(line);

    ui.d->setTextColor(SSD1306_WHITE);
  }

private:
  // Three strokes each, so the mark reads as a shape rather than a hairline.
  void drawTick(Ui &ui, int cx, int cy, int ink) {
    for (int i = 0; i < 3; i++) {
      ui.d->drawLine(cx - 14 + ui.ox, cy + i + ui.oy, cx - 5 + ui.ox, cy + 9 + i + ui.oy, ink);
      ui.d->drawLine(cx - 5 + ui.ox, cy + 9 + i + ui.oy, cx + 14 + ui.ox, cy - 9 + i + ui.oy, ink);
    }
  }

  void drawCross(Ui &ui, int cx, int cy, int ink) {
    for (int i = 0; i < 3; i++) {
      ui.d->drawLine(cx - 11 + i + ui.ox, cy - 11 + ui.oy, cx + 11 + i + ui.ox, cy + 11 + ui.oy, ink);
      ui.d->drawLine(cx + 11 + i + ui.ox, cy - 11 + ui.oy, cx - 11 + i + ui.ox, cy + 11 + ui.oy, ink);
    }
  }

  void drawSpinner(Ui &ui, int cx, int cy, int ink) {
    ui.d->drawCircle(cx + ui.ox, cy + ui.oy, 13, ink);
    for (int i = 0; i < 12; i++) {
      if (i != spin && i != (spin + 6) % 12) continue;
      float a = (i * 6.28318) / 12.0;
      ui.d->fillCircle(cx + (int)(cos(a) * 13.0) + ui.ox,
                       cy + (int)(sin(a) * 13.0) + ui.oy, 2, ink);
    }
  }

  // Stand-in for the API poll: cycle the three states.
  int pollStatus(unsigned long now) {
    unsigned long phase = (now / 7000) % 3;
    if (phase == 0) return BUILD_PASSING;
    if (phase == 1) return BUILD_RUNNING;
    return BUILD_FAILING;
  }

  const char *branch;
  int status;
  int reviews;
  int spin;
};

/* ===== end WidgetBuild.h ===== */
/* ===== WidgetFreezer.h ===== */
/*
 * WidgetFreezer.h - garage chest freezer watchdog.
 *
 * Probably the highest actual value on the list: it catches a dying
 * compressor or a door left ajar before a few hundred dollars of food does.
 *
 * The alarm only fires after the temperature has been over the line for a
 * sustained period, because every freezer crosses its threshold during a
 * defrost cycle and an alarm that cries wolf gets ignored.
 *
 * Hardware: DS18B20 probe on a 1-Wire pin, run inside the lid seal.
 */


class FreezerWidget : public Widget {
public:
  FreezerWidget(int alarmF, unsigned long holdMs)
      : alarmAt(alarmF), hold(holdMs), tempF(0), overSince(0),
        minF(999), maxF(-999), lastSample(0) {}

  const char *name() override { return "freezer"; }
  unsigned long dwellMs() override { return 5000; }

  void update(unsigned long now) override {
    if (lastSample && now - lastSample < 1000) return;
    lastSample = now;

    tempF = readTempF(now);
    if (tempF < minF) minF = tempF;
    if (tempF > maxF) maxF = tempF;
    history.push(tempF);

    // Start (or clear) the over-threshold stopwatch.
    if (tempF > alarmAt) {
      if (!overSince) overSince = now;
    } else {
      overSince = 0;
    }
  }

  bool urgent() override {
    return overSince && (millis() - overSince) >= hold;
  }

  void render(Ui &ui) override {
    char buf[16];

    if (urgent()) {
      ui.banner("THAWING");
      return;
    }

    ui.header("FREEZER", overSince ? "warming" : "ok");

    snprintf(buf, sizeof(buf), "%d", tempF);
    ui.bigValue(12, buf, "F");

    snprintf(buf, sizeof(buf), "min %d  max %d", minF, maxF);
    ui.label(0, 40, buf);

    ui.sparkline(0, 48, 128, 16, history, alarmAt);
  }

private:
  /*
   * Stand-in for the probe: a normal compressor duty cycle with one excursion
   * over the line per two-minute loop, so both the warning and the alarm path
   * are reachable -- and so the alarm clears again rather than pinning the
   * screen for the rest of the run.
   */
  int readTempF(unsigned long now) {
    float t = now / 1000.0;
    unsigned long phase = (now / 1000) % 120;
    int base = (int)(-2.0 + sin(t / 6.0) * 3.0);
    if (phase >= 55 && phase < 95) base += (int)((phase - 55) / 2);
    return base;
  }

  Series history;
  int alarmAt;
  unsigned long hold;
  int tempF;
  unsigned long overSince;
  int minF;
  int maxF;
  unsigned long lastSample;
};

/* ===== end WidgetFreezer.h ===== */
/* ===== WidgetClock.h ===== */
/*
 * WidgetClock.h - minutes until the next thing.
 *
 * One number that changes slowly and that you would actually act on, which is
 * about the highest bar a screen this size can clear. Under five minutes it
 * switches to MM:SS and claims the screen, because that is the point at which
 * you need to stand up.
 *
 * Hardware: any Wi-Fi capable ESP32. Fetch the next event from the Google
 * Calendar API on a slow poll and feed setNextEvent() the seconds remaining
 * and a title; NTP keeps the countdown honest between polls.
 */


class ClockWidget : public Widget {
public:
  ClockWidget() : secondsLeft(0), title("nothing scheduled") {}

  const char *name() override { return "calendar"; }
  unsigned long dwellMs() override { return 6000; }

  void setNextEvent(long seconds, const char *what) {
    secondsLeft = seconds;
    title = what;
  }

  void update(unsigned long now) override {
    // Stand-in for the calendar: a meeting every four minutes.
    long cycle = 240 - (long)((now / 1000) % 240);
    setNextEvent(cycle, "standup");
  }

  bool urgent() override { return secondsLeft > 0 && secondsLeft <= 60; }

  void render(Ui &ui) override {
    char buf[12];

    if (secondsLeft <= 0) {
      ui.header("NEXT", "");
      ui.centered(30, 1, "nothing scheduled");
      return;
    }

    ui.header("NEXT", title);

    if (secondsLeft < 300) {
      // Close in, seconds are what you care about.
      snprintf(buf, sizeof(buf), "%ld:%02ld", secondsLeft / 60, secondsLeft % 60);
      ui.bigValue(16, buf, "");
    } else {
      snprintf(buf, sizeof(buf), "%ld", secondsLeft / 60);
      ui.bigValue(16, buf, "min");
    }

    // A bar that drains over the last ten minutes.
    if (secondsLeft <= 600) {
      ui.bar(0, 52, 128, 10, (int)((secondsLeft * 100) / 600));
    }
  }

private:
  long secondsLeft;
  const char *title;
};

/* ===== end WidgetClock.h ===== */

/* ---- profile ---- */
// Exactly one. PROFILE_DEMO runs everything, which is what the simulator shows.
#define PROFILE_DEMO
// #define PROFILE_OFFICE
// #define PROFILE_GARAGE

#define OLED_RESET   -1
#define OLED_ADDR    0x3C
#define BUTTON_PIN   4      // to GND; comment out host.setButton() to omit

Adafruit_SSD1306 display(128, 64, &Wire, OLED_RESET);
WidgetHost host(display);

Co2Widget     co2(1000);            // ppm at which the room makes you sleepy
ClockWidget   calendar;
BuildWidget   build("main");
ParkingWidget parking(12, 96);      // stop at 12", ignore beyond 96"
// 8 s of sustained over-temperature here so the alarm is reachable in a short
// simulator run; on real hardware use 120000, since every freezer crosses its
// threshold during a defrost cycle.
FreezerWidget freezer(5, 8000);

void setup() {
  Serial.begin(115200);

  Wire.begin();             // ESP32: GPIO21/22 - XIAO ESP32-C6: D4/D5
  Wire.setClock(400000);    // 400 kHz: a frame costs 23 ms instead of 94 ms

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 not found - check wiring and address"));
    for (;;) delay(1000);
  }

#if defined(PROFILE_OFFICE)
  host.add(&co2);
  host.add(&calendar);
  host.add(&build);
#elif defined(PROFILE_GARAGE)
  host.add(&parking);
  host.add(&freezer);
#else
  host.add(&co2);
  host.add(&calendar);
  host.add(&build);
  host.add(&parking);
  host.add(&freezer);
#endif

  host.setButton(BUTTON_PIN);
  host.setFrameInterval(100);   // 10 fps is plenty for anything glanceable
  host.setIdleTimeout(0);       // e.g. 600000 to blank after 10 idle minutes
  host.begin();

  Serial.print(F("glance: "));
  Serial.print(host.count());
  Serial.println(F(" screens"));
}

void loop() {
  host.tick(millis());
  delay(5);
}


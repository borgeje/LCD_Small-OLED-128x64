#pragma once
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

#include "Widget.h"
#include "Ui.h"

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

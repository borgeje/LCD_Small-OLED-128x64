#pragma once
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

#include "Widget.h"

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

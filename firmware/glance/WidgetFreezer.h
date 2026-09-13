#pragma once
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

#include "Widget.h"

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

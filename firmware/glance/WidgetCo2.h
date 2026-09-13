#pragma once
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

#include "Widget.h"

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

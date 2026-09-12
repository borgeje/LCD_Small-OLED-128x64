# glance — a widget framework for the 0.96" OLED

One box, several screens. `firmware/glance/` is a small Arduino framework where
each screen is a class with a `render()` and one line of registration. The
office build and the garage build are the same firmware with three lines
changed.

It exists because eight of the nine project ideas for this panel are the same
shape — a label, one number sized as large as it will go, and a sparkline of
where it has been — and because the things that are easy to get wrong (burn-in,
frame pacing, an alarm that needs to interrupt) are worth getting right once
rather than once per project.

```
firmware/glance/
  glance.ino        which widgets, in what order
  Widget.h          what a screen must provide
  WidgetHost.h      rotation, urgency, pinning, burn-in, pacing
  Ui.h              Series ring buffer + the drawing vocabulary
  WidgetCo2.h       office air quality
  WidgetClock.h     minutes until the next meeting
  WidgetBuild.h     CI pass/fail
  WidgetParking.h   garage stop sign
  WidgetFreezer.h   chest-freezer watchdog
```

## Try it without hardware

Every widget ships with a synthetic data source, so the whole thing runs in the
[simulator](../simulator/README.md) as-is:

```bash
node simulator/cli/render.js firmware/glance/glance.ino --at 30000 --ascii --stats
node simulator/cli/render.js firmware/glance/glance.ino --frames 20 --every 2000 --out /tmp/glance/
```

Or open `simulator/index.html` and pick **glance framework** from the dropdown.
Watch it long enough and you will see the rotation, the parking sensor
interrupting it when a car arrives, the build widget inverting the panel on a
failure, and — after a minute — the whole layout shift by one pixel.

> **Compilation status:** this is verified in the simulator, which runs the
> real source. It has not been through `arduino-cli` or a hardware flash, since
> neither was available where it was written. Expect to fix includes or a
> narrowing conversion before it builds clean; the logic is exercised.

## Writing a widget

The whole contract:

```cpp
class Widget {
  virtual void begin() {}                        // once, after the display is up
  virtual void update(unsigned long now) {}      // every tick, showing or not
  virtual void render(Ui &ui) = 0;               // draw one frame
  virtual bool urgent() { return false; }        // demand the screen
  virtual unsigned long dwellMs() { return 6000; }
  virtual const char *name() { return "widget"; }
};
```

A widget never calls `display.display()` and never decides when it is on
screen. The host owns the panel, the clock and the rotation, which is what
keeps each widget to about fifty lines.

`update()` runs on **every** tick, not only when the widget is visible. That is
deliberate: a sparkline keeps filling while other screens are up, and
`urgent()` can fire from a widget nobody is currently looking at. Keep it cheap
and non-blocking — no `delay()`, no long I²C reads.

A complete widget:

```cpp
class DoorWidget : public Widget {
public:
  DoorWidget(int pin) : pin(pin), openSince(0) {}

  const char *name() override { return "door"; }

  void begin() override { pinMode(pin, INPUT_PULLUP); }

  void update(unsigned long now) override {
    bool open = digitalRead(pin) == HIGH;
    if (open && !openSince) openSince = now;
    if (!open) openSince = 0;
  }

  // Nag after fifteen minutes.
  bool urgent() override { return openSince && millis() - openSince > 900000UL; }

  void render(Ui &ui) override {
    char buf[12];
    if (!openSince) { ui.header("DOOR", ""); ui.centered(28, 2, "CLOSED"); return; }
    snprintf(buf, sizeof(buf), "%lu", (millis() - openSince) / 60000);
    ui.header("DOOR OPEN", "");
    ui.bigValue(20, buf, "min");
  }

private:
  int pin;
  unsigned long openSince;
};
```

Then one line in `glance.ino`:

```cpp
DoorWidget door(5);
...
host.add(&door);
```

## The drawing vocabulary

`Ui` exists so widgets do not each reinvent centring and scaling. The
important one is `bigValue()`, which **chooses its own text size** — you say
what to show and how much room it has, and it uses the largest size that fits.
On a panel whose active area is 21.7 × 10.9 mm that is nearly always the right
call, and it is the single decision that separates a readable screen from an
unreadable one.

| | |
|---|---|
| `header(left, right)` | one-line title with a rule under it |
| `bigValue(y, value, unit)` | the headline number, auto-sized and centred |
| `centered(y, size, text)` | centred text at a size you pick |
| `label(x, y, text)` / `text(x, y, size, t)` | placed text |
| `sparkline(x, y, w, h, series, marker)` | auto-scaled, with an optional threshold line |
| `bar(x, y, w, h, pct)` | bordered progress bar, clamps its own input |
| `banner(text)` | full-screen alert: lights the panel, cuts the text out of it |
| `fitSize(text, maxW)` | the largest text size that fits, if you want it yourself |
| `pixel` `line` `hline` `rect` `fillRect` `circle` `fillCircle` | primitives |

`Series` is a fixed 64-sample ring buffer — `push`, `at`, `size`, `latest`,
`minValue`, `maxValue`, `deltaOver(n)`. No allocation, no growth. `deltaOver`
takes a window because a trend label computed over two seconds will disagree
with the sparkline underneath it computed over thirty.

Every helper offsets by `ui.ox / ui.oy`. If you draw with raw
`ui.d->drawWhatever()`, add those yourself or your widget will be the one that
burns in.

## What the host handles

- **Rotation** — each widget holds the screen for its own `dwellMs()`.
- **Urgency** — `urgent()` takes the screen immediately and keeps it, over the
  rotation *and* over a pin. This is the freezer alarm interrupting the CO₂
  reading, not a politeness request.
- **Pinning** — short button press advances, long press (600 ms) pins the
  current screen; a dot in the corner shows it is held.
- **Pacing** — `setFrameInterval(100)` by default. A full frame is 1024 bytes,
  about 23 ms of I²C time at 400 kHz, and nothing glanceable needs 40 fps.
- **Burn-in** — the whole layout shifts one pixel every minute, cycling through
  four positions, and the panel inverts for three seconds every half hour.
  OLED pixels age with on-time; a static label in one place for a year leaves a
  ghost, and moving it spreads that over four times the area for free.
- **Idle blanking** — `setIdleTimeout(600000)` turns the panel off after ten
  quiet minutes. It is both the best burn-in defence and the best power saving.
  Off by default.

## Profiles

Pick one at the top of `glance.ino`:

| | |
|---|---|
| `PROFILE_DEMO` | everything, which is what the simulator shows |
| `PROFILE_OFFICE` | CO₂, next meeting, build status |
| `PROFILE_GARAGE` | parking sensor, freezer watchdog |

## Wiring

Per the [hardware reference](../README.md):

| OLED | ESP32 DevKit | XIAO ESP32-C6 |
|---|---|---|
| VCC | 3V3 | 3V3 |
| GND | GND | GND |
| SDA | GPIO21 | D4 |
| SCL | GPIO22 | D5 |

Optional momentary button between `BUTTON_PIN` (GPIO4 by default) and GND.
Comment out `host.setButton()` to omit it.

`Wire.setClock(400000)` matters: at the 100 kHz default a full frame costs
94 ms instead of 23 ms, which caps you near 11 fps before your code does
anything.

## Swapping in real sensors

Every widget's synthetic source is a single private method, marked in a
comment, that returns what the sensor would:

| Widget | Replace | With |
|---|---|---|
| `Co2Widget` | `readPpm()` | SCD40/SCD41 over I²C (0x62, shares the bus) |
| `ParkingWidget` | `readInches()` | VL53L1X time-of-flight (0x29) |
| `FreezerWidget` | `readTempF()` | DS18B20 probe on 1-Wire |
| `BuildWidget` | `pollStatus()` | GitHub API check-suite conclusion |
| `ClockWidget` | `update()`'s cycle | Calendar API → `setNextEvent(seconds, title)` |

Two of those want Wi-Fi, which the simulator does not emulate — keep the
network code behind a method that hands the widget a value, and the widget
stays testable either way.

One real change when you do: `FreezerWidget` is constructed with an 8-second
alarm hold so the alarm path is reachable in a short simulator run. Use
`120000` on hardware — every freezer crosses its threshold during a defrost
cycle, and an alarm that cries wolf gets ignored.

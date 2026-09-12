# LCD_Small-OLED-128x64

Project to test and deploy an initial simple project on this small OLED display:

> **Hosyond 5 Pcs 0.96 Inch OLED I2C IIC Display Module 12864 128x64 Pixel SSD1306
> Mini Self-Luminous OLED Screen Board Compatible with Arduino Raspberry Pi (White)**

Full reference: [`docs/hosyond-0.96in-oled-ssd1306-128x64.md`](docs/hosyond-0.96in-oled-ssd1306-128x64.md)

## Try a sketch without the hardware

[`simulator/`](simulator/README.md) runs an `.ino` file and shows you what this
panel would display. Open `simulator/index.html` in a browser — no server, no
build step, no dependencies — or render headlessly:

```bash
node simulator/cli/render.js simulator/examples/02-co2-monitor.ino --ascii
node simulator/cli/render.js my-sketch.ino --at 5000 --out frame.png
```

It is a port of the real Adafruit_GFX drawing algorithms against the actual
`glcdfont` table, so the output is pixel-identical to the panel. It also
charges the clock for the I²C frame transfer, which is how it can tell you the
frame rate you will really get (≈43 fps at 400 kHz, ≈11 fps at 100 kHz).

## Build something on it

[`firmware/glance/`](firmware/README.md) is a widget framework for this panel:
each screen is a class with a `render()`, and the host handles rotation,
alarms that interrupt, button pinning, frame pacing, and burn-in. Five screens
ship with it — CO₂, next meeting, build status, parking sensor, freezer
watchdog — each with a synthetic data source so the whole thing runs in the
simulator before you buy a sensor.

```bash
node simulator/cli/render.js firmware/glance/glance.ino --at 30000 --ascii --stats
```

## The display at a glance

| | |
|---|---|
| Controller | Solomon Systech **SSD1306** |
| Resolution | **128 × 64**, monochrome, white pixels |
| Panel | Self-luminous OLED — no backlight, > 160° viewing angle |
| Interface | **I²C**, 4 pins, default address **0x3C** (0x3D if the address resistor is moved) |
| Supply | 3.3 V – 5 V rated; **use 3.3 V on ESP32-class boards** — the SSD1306 is a 3.3 V part and there is no level shifter |
| Current | ≈ 10–25 mA (0.04 W typical, 0.08 W all pixels lit) |
| Bus speed | 100 kHz and 400 kHz guaranteed |
| Reset | Not broken out — pass `-1` (Adafruit) / `U8X8_PIN_NONE` (U8g2) |

## Pinout

Two pin orders ship on this board shape. **Read the silkscreen before wiring.**

| Variant | Pin 1 | Pin 2 | Pin 3 | Pin 4 |
|---|---|---|---|---|
| **A** (most common) | GND | VCC | SCL | SDA |
| **B** | VCC | GND | SCL | SDA |

SDA and SCL already have ~4.7 kΩ pull-ups on the module, so a single display needs no
external resistors.

## Best pins — ESP32 (WROOM DevKit)

| OLED | ESP32 | Why |
|---|---|---|
| VCC | **3V3** | Matches the panel's native logic level |
| GND | **GND** | |
| SDA | **GPIO21** | Arduino-ESP32 default SDA — plain `Wire.begin()` just works |
| SCL | **GPIO22** | Arduino-ESP32 default SCL |

Alternates if those are taken: GPIO25/26/27, GPIO32/33, GPIO18/19/23.
**Avoid:** GPIO6–11 (SPI flash), GPIO34–39 (input-only, no pull-ups — SDA cannot work
there), GPIO0/2/5/12/15 (strapping pins; a pull-up on GPIO12 can stop the board
booting), GPIO1/3 (USB serial).

## Best pins — Seeed Studio XIAO ESP32-C6

| OLED | XIAO pad | GPIO |
|---|---|---|
| VCC | **3V3** | — |
| GND | **GND** | — |
| SDA | **D4** | GPIO22 |
| SCL | **D5** | GPIO23 |

D4/D5 are the board's default I²C pins, so `Wire.begin()` needs no arguments, and they
sit next to 3V3/GND on the same edge — a clean 4-wire run with no crossing.
**Avoid:** GPIO15 (user LED), GPIO3 and GPIO14 (RF switch enable and antenna select —
driving them breaks Wi-Fi/BLE), and the `5V` pad (unregulated USB, absent on battery).
Any other pad works via `Wire.begin(sda, scl)`.

## Quick start (Arduino, both boards)

```cpp
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);   // -1 = no reset pin

void setup() {
  Wire.begin();            // ESP32: GPIO21/22 — XIAO ESP32-C6: D4/D5
  Wire.setClock(400000);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);    // try 0x3D if blank
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(F("Hello, OLED"));
  display.display();       // nothing shows until this is called
}

void loop() {}
```

The same sketch is in the simulator as
[`simulator/examples/01-hello-oled.ino`](simulator/examples/01-hello-oled.ino),
so you can see the result before the parts arrive.

Libraries: **Adafruit_SSD1306 + Adafruit_GFX** (simple, 1 KB frame buffer) or **U8g2**
(more fonts, page-buffered for low-RAM hosts). The simulator emulates the
Adafruit stack.

Nothing on screen? Run an I²C scanner first — a healthy board answers at 0x3C or 0x3D.
See the [troubleshooting table](docs/hosyond-0.96in-oled-ssd1306-128x64.md#6-troubleshooting)
for the rest.

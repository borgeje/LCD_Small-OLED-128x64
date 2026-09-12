# Hosyond 0.96" I2C OLED (SSD1306, 128×64) — Reference

Full reference for the module used in this project:

> **Hosyond 5 Pcs 0.96 Inch OLED I2C IIC Display Module 12864 128x64 Pixel SSD1306
> Mini Self-Luminous OLED Screen Board Compatible with Arduino Raspberry Pi (White)**

This is the ubiquitous 4-pin 0.96" SSD1306 breakout. Hosyond does not publish a
datasheet of its own; everything below is drawn from the seller's listing
specifications, the Solomon Systech SSD1306 datasheet, and the conventions shared by
this form factor. Where a number is *typical for the form factor* rather than
vendor-confirmed, it is marked as such.

---

## 1. Specifications

| Item | Value | Source |
|---|---|---|
| Driver / controller IC | Solomon Systech **SSD1306** | listing |
| Resolution | **128 × 64** pixels, monochrome (1 bpp) | listing |
| Panel | Passive-matrix OLED, **self-luminous** (no backlight) | listing |
| Pixel color | White (this SKU). Same board also sold in blue, and blue/yellow split | listing |
| Diagonal | 0.96 in | listing |
| Interface | **I²C / IIC**, 4 pins (2 signal lines) | listing |
| I²C address (7-bit) | **0x3C** default; 0x3D if the address resistor is moved | listing / community |
| Supply voltage | **3.3 V – 5 V DC** | listing |
| Power consumption | ~0.04 W typical, ~0.08 W all pixels lit (≈10–25 mA) | listing |
| Viewing angle | > 160° | listing |
| Contrast | Software-adjustable, 256 steps (SSD1306 `0x81` command) | SSD1306 datasheet |
| Display RAM | 1024 bytes GDDRAM (128 × 64 / 8) | SSD1306 datasheet |
| I²C clock | 100 kHz (standard) and 400 kHz (fast) guaranteed; 700 kHz–1 MHz often works but is out of spec | SSD1306 datasheet |
| Charge pump | Internal (7.5 V), enabled in software — no external boost needed | SSD1306 datasheet |
| Module outline | ≈ 27 × 27 mm, 4 pins on 2.54 mm pitch — *typical for form factor, measure yours* | form factor |
| Active area | ≈ 21.7 × 10.9 mm — *typical for form factor* | form factor |
| Operating temperature | ≈ −30 °C to +70 °C — *typical for form factor* | form factor |
| Host compatibility | Arduino (UNO/Nano/Mega), ESP32/ESP8266, Raspberry Pi, STM32, 8051 | listing |

### Logic-level note

The SSD1306 silicon is a **3.3 V part** (VDD 1.65–3.3 V, VCI up to 4.0 V). The
"3.3 V–5 V" rating of the breakout comes from the on-board regulator/level tolerance
of the carrier PCB, and there is no I²C level shifter on it. On an ESP32 or XIAO,
**power it from 3.3 V** — the supply and the logic levels then match and there is
nothing to shift. Only feed it 5 V when the host is a 5 V board such as an
Arduino UNO.

### Reset pin

The 4-pin I²C variant does **not** break out `RES`; the reset line is handled by an
on-board RC network. In software, pass "no reset pin" to the library
(`-1` in Adafruit_SSD1306, `U8X8_PIN_NONE` in U8g2).

---

## 2. Pinout

The board has **four** 2.54 mm pins. **Two pin orders exist in the wild for this exact
board shape — always read the silkscreen on your unit before wiring.**

| Variant | Pin 1 | Pin 2 | Pin 3 | Pin 4 |
|---|---|---|---|---|
| **A** (most common on this SKU) | GND | VCC | SCL | SDA |
| **B** | VCC | GND | SCL | SDA |

| Pin | Function | Notes |
|---|---|---|
| **GND** | Ground | Must share ground with the host |
| **VCC** | Supply | 3.3 V from an ESP32/XIAO; 5 V only on 5 V hosts |
| **SCL** | I²C clock | Open-drain; needs a pull-up (the module carries ~4.7 kΩ) |
| **SDA** | I²C data | Open-drain; needs a pull-up (the module carries ~4.7 kΩ) |

Pull-ups are already fitted on the module, so no external resistors are needed for a
single display on a short cable. If you chain several I²C devices the parallel
pull-ups get stiff — keep the total effective pull-up at or above ~2 kΩ.

### Changing the I²C address

Default is **0x3C** (7-bit; it appears as 0x78 write / 0x79 read in 8-bit notation).
To use two of these displays on one bus, move the small address-select resistor on the
back of one board from the 0x3C pad to the 0x3D pad. Some production runs ship
configured as 0x3D — if nothing appears, run an I²C scanner and check for both.

---

## 3. Wiring to an ESP32 (classic ESP32-WROOM DevKit)

The ESP32 routes I²C through the GPIO matrix, so **any** free GPIO can be SDA or SCL.
The Arduino core's defaults, and the best choice here, are:

| OLED pin | ESP32 pin | Why |
|---|---|---|
| VCC | **3V3** | Matches the SSD1306's native logic level |
| GND | **GND** | — |
| SDA | **GPIO21** | Arduino-ESP32 default SDA; not a strapping or flash pin |
| SCL | **GPIO22** | Arduino-ESP32 default SCL; not a strapping or flash pin |

Using the defaults means plain `Wire.begin()` works with no arguments.

**Good alternates** if 21/22 are taken: GPIO16/17 (only on modules *without* PSRAM —
on PSRAM parts these are tied to the RAM), GPIO25/26/27, GPIO32/33, GPIO18/19/23.

**Pins to avoid for I²C:**

- **GPIO6–11** — wired to the on-board SPI flash. Using them corrupts flash access.
- **GPIO34–39** — input-only, with no internal pull-ups; SDA must be bidirectional, so
  they cannot drive an I²C bus at all.
- **GPIO0, 2, 5, 12, 15** — strapping pins, sampled at reset to pick boot mode and
  flash voltage. An I²C pull-up on GPIO12 in particular can stop the board booting.
- **GPIO1 / GPIO3** — the USB-serial UART; using them breaks flashing and the monitor.

A second bus is available if you need it: `Wire1.begin(sda, scl)`.

---

## 4. Wiring to a Seeed Studio XIAO ESP32-C6

| OLED pin | XIAO ESP32-C6 pad | GPIO |
|---|---|---|
| VCC | **3V3** | — |
| GND | **GND** | — |
| SDA | **D4** | GPIO22 |
| SCL | **D5** | GPIO23 |

D4/D5 are the board's **default I²C pins** in the Arduino core, so `Wire.begin()` with
no arguments is enough. They are the right choice for a second reason: they sit next to
3V3 and GND on the same edge of the board, so the display connects as a clean 4-wire
run with no crossing.

Full XIAO ESP32-C6 pad-to-GPIO map, for picking alternates:

| Pad | GPIO | Default peripheral function |
|---|---|---|
| D0 | GPIO0 | ADC |
| D1 | GPIO1 | ADC |
| D2 | GPIO2 | ADC |
| D3 | GPIO21 | SPI SS |
| **D4** | **GPIO22** | **I²C SDA** |
| **D5** | **GPIO23** | **I²C SCL** |
| D6 | GPIO16 | UART TX |
| D7 | GPIO17 | UART RX |
| D8 | GPIO19 | SPI SCK |
| D9 | GPIO20 | SPI MISO |
| D10 | GPIO18 | SPI MOSI |

**Do not repurpose these for the display:**

- **GPIO15** — the on-board yellow user LED.
- **GPIO3** — RF switch power enable. **GPIO14** — antenna select (on-board ceramic vs.
  external u.FL). Both are internal to the module; driving them breaks Wi-Fi/BLE range.
- The `5V` pad is USB bus voltage, unregulated and absent on battery power. Use `3V3`.

If D4/D5 are already committed, remap with `Wire.begin(SDA_pin, SCL_pin)` onto any free
pad — D0–D3 and D6–D10 all work. The C6 also exposes a low-power `LP_I2C` peripheral on
back-side pads, which is only worth the trouble for deep-sleep sensor polling.

---

## 5. Software

Two mainstream Arduino libraries drive this panel:

- **Adafruit_SSD1306** + **Adafruit_GFX** — friendly API, buffers the whole 1 KB frame
  in RAM. The easy default.
- **U8g2 / U8x8** — many more fonts, and a page-buffer mode that fits in a few hundred
  bytes of RAM. Worth it on memory-tight hosts; on an ESP32 the RAM cost is irrelevant.

### Minimal sketch (Adafruit, works unchanged on ESP32 and XIAO ESP32-C6)

```cpp
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1     // no reset pin broken out on this module
#define OLED_ADDR     0x3C   // 0x3D on some units

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

void setup() {
  Serial.begin(115200);

  Wire.begin();          // ESP32: GPIO21/22 — XIAO ESP32-C6: D4/D5
  // Wire.begin(sda, scl);  // use this form for custom pins
  Wire.setClock(400000); // 400 kHz fast mode

  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println(F("SSD1306 not found — check wiring and address"));
    for (;;) delay(1000);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(F("Hello, OLED"));
  display.display();     // nothing appears until this is called
}

void loop() {}
```

`SSD1306_SWITCHCAPVCC` tells the driver to run its internal charge pump off the logic
supply — the correct setting for this module.

### I²C scanner

When in doubt, confirm the address before blaming the code:

```cpp
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  Wire.begin();
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { Serial.printf("Found 0x%02X\n", a); }
  }
}
void loop() {}
```

A healthy board answers at **0x3C** (or 0x3D).

---

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Scanner finds nothing | SDA/SCL swapped, or the pin order is variant B and VCC/GND are reversed |
| Found at 0x3D, blank screen | Address-select resistor is on the other pad — pass 0x3D to `begin()` |
| Flash of pixels at boot, then blank | `display.display()` never called after drawing |
| Garbled or intermittent output | I²C clock too high for the cable, or pull-ups too stiff from stacked devices — drop to 100 kHz |
| Whole panel lit white | Init failed or the panel is in test mode; check the return value of `begin()` |
| Dim or flickering | Supplied from a weak 3.3 V rail; peaks approach 25 mA with all pixels on |
| Burn-in after long static display | Inherent to OLED — invert or shift the content periodically, or blank when idle |

---

## 7. Sources

- [Hosyond 0.96" OLED I2C module (Amazon listing, same board family)](https://www.amazon.com/Hosyond-Display-Self-Luminous-Compatible-Raspberry/dp/B09C5K91H7)
- [Hosyond 0.96" OLED, White (NeweggBusiness listing)](https://www.neweggbusiness.com/product/product.aspx?item=9b-2ru-03ne-000k4)
- [SSD1306 0.96" I2C OLED datasheet summary — DatasheetHub](https://www.datasheethub.com/ssd1306-128x64-mono-0-96-inch-i2c-oled-display/)
- [Display OLED I2C 0.96" SSD1306 datasheet (Mouser / Soldered PN 333099)](https://www.mouser.com/datasheet/2/1398/Soldered_333099-3395096.pdf)
- [In-Depth: Interface OLED Graphic Display Module with Arduino — Last Minute Engineers](https://lastminuteengineers.com/oled-display-arduino-tutorial/)
- [I2C — Arduino-ESP32 documentation (Espressif)](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2c.html)
- [ESP32 Pinout Reference: Which GPIO pins should you use? — Random Nerd Tutorials](https://randomnerdtutorials.com/esp32-pinout-reference-gpios/)
- [GPIO & RTC GPIO — ESP-IDF Programming Guide (ESP32)](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/gpio.html)
- [Pin Multiplexing With Seeed Studio XIAO ESP32C6 — Seeed Studio Wiki](https://wiki.seeedstudio.com/xiao_pin_multiplexing_esp32c6/)
- [Getting Started with Seeed Studio XIAO ESP32C6 — Seeed Studio Wiki](https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/)
- [XIAO ESP32C6 pinout and specifications — espboards.dev](https://www.espboards.dev/esp32/xiao-esp32c6/)
- [First Look at the Seeed Studio XIAO ESP32C6 — sigmdel.ca](https://www.sigmdel.ca/michel/ha/xiao/xiao_esp32c6_intro_en.html)

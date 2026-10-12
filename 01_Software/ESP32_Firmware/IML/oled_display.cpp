#include "oled_display.h"
#include "ble_link.h"
#include "sensors.h"

#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// OLED
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64

#define OLED_MOSI 9
#define OLED_CLK  10
#define OLED_RST  13
#define OLED_DC  11
#define OLED_CS   12

#define OLED_UPDATE_MS 1000

static Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  OLED_MOSI,
  OLED_CLK,
  OLED_DC,
  OLED_RST,
  OLED_CS
);

// Bluetooth icon 16x16
static const unsigned char bluetoothIcon16[] PROGMEM = {
  0x06, 0x00,
  0x07, 0x00,
  0x05, 0x80,
  0x04, 0xC0,
  0x84, 0x60,
  0x44, 0xC0,
  0x25, 0x80,
  0x17, 0x00,
  0x17, 0x00,
  0x25, 0x80,
  0x44, 0xC0,
  0x84, 0x60,
  0x04, 0xC0,
  0x05, 0x80,
  0x07, 0x00,
  0x06, 0x00
};

enum OledScreenState {
  OLED_BOOT,
  OLED_WAITING,
  OLED_ONLINE
};

static OledScreenState oledScreen = OLED_BOOT;
static uint32_t lastOledUpdate = 0;
static int lastOledCaps = -1;

// Outer frame + header divider, shared by all screens
static void drawFrame() {
  display.drawRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
  display.drawFastHLine(1, 13, SCREEN_WIDTH - 2, SSD1306_WHITE);
}

// "IML SENSOR" wordmark + a status badge top-right (e.g. BOOT / WAIT / LIVE)
static void drawHeader(const char* badge, bool filled) {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(4, 3);
  display.print("IML SENSOR");

  const int16_t bx = 90, by = 2, bw = 34, bh = 9;

  if (filled) {
    display.fillRoundRect(bx, by, bw, bh, 2, SSD1306_WHITE);
    display.setTextColor(SSD1306_BLACK);
  } else {
    display.drawRoundRect(bx, by, bw, bh, 2, SSD1306_WHITE);
  }

  display.setCursor(bx + 5, by + 1);
  display.print(badge);
  display.setTextColor(SSD1306_WHITE);
}

// Bottom divider + channel/rate readout, shared by waiting/online screens
static void drawFooter() {
  display.drawFastHLine(1, 50, SCREEN_WIDTH - 2, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(4, 54);
  display.print("50Hz");

  char buf[16];
  int len = snprintf(buf, sizeof(buf), "A4 D4 C%d", numCaps);
  display.setCursor(SCREEN_WIDTH - 2 - len * 6, 54);
  display.print(buf);
}

// Bordered channel chip: small label top-left, large value below
static void drawChannelChip(int16_t x, int16_t y, const char* label, int value) {
  const int16_t w = 32, h = 30;

  display.drawRoundRect(x, y, w, h, 2, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(x + 3, y + 3);
  display.print(label);

  display.setTextSize(2);
  display.setCursor(x + 6, y + 12);
  display.print(value);
}

static void drawBootScreen() {
  display.clearDisplay();
  drawFrame();
  drawHeader("BOOT", false);

  display.setTextSize(2);
  display.setCursor(46, 22);
  display.print("IML");

  display.setTextSize(1);
  display.setCursor(28, 42);
  display.print("INITIALIZING");

  display.drawRoundRect(4, 54, 120, 6, 2, SSD1306_WHITE);
  display.fillRect(6, 56, 90, 2, SSD1306_WHITE);

  display.display();
}

static void drawWaitingScreen() {
  display.clearDisplay();
  drawFrame();
  drawHeader("WAIT", false);

  display.drawBitmap(10, 22, bluetoothIcon16, 16, 16, SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(34, 22);
  display.print("PAIRING");

  // searching indicator
  display.fillRect(50, 44, 4, 4, SSD1306_WHITE);
  display.drawRect(60, 44, 4, 4, SSD1306_WHITE);
  display.drawRect(70, 44, 4, 4, SSD1306_WHITE);

  drawFooter();
  display.display();
}

static void drawOnlineScreen() {
  display.clearDisplay();
  drawFrame();
  drawHeader("LIVE", true);

  drawChannelChip(4, 16, "A", 4);
  drawChannelChip(48, 16, "D", 4);
  drawChannelChip(92, 16, "C", numCaps);

  drawFooter();
  display.display();
}

void oledInit() {
  if (!display.begin(SSD1306_SWITCHCAPVCC)) {
    Serial.println("[OLED] SSD1306 init failed");
    return;
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  drawBootScreen();
}

void oledUpdateStatus() {
  uint32_t now = millis();

  OledScreenState target = clientReady ? OLED_ONLINE : OLED_WAITING;

  bool screenChanged = target != oledScreen;
  bool capsChanged = numCaps != lastOledCaps;
  bool timeElapsed = now - lastOledUpdate >= OLED_UPDATE_MS;

  if (!screenChanged && !capsChanged && !timeElapsed) return;

  if (target == OLED_ONLINE) {
    drawOnlineScreen();
  } else {
    drawWaitingScreen();
  }

  oledScreen = target;
  lastOledCaps = numCaps;
  lastOledUpdate = now;
}

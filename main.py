# main.py — Smart 7-11 Door (ESP32 + MicroPython, Wokwi)
# ต้องมีไฟล์ Cloud_connect.py อยู่ในโปรเจกต์ Wokwi ด้วย (กด "+" เพิ่มไฟล์ใหม่ แล้ววางโค้ด)
from machine import Pin, PWM, ADC, I2C
import time
import json
from Cloud_connect import Cloud

# --- 1. ตั้งค่า ---
MQTT_SERVER = "61286afe29624375903af5c7efec2060.s1.eu.hivemq.cloud"
MQTT_USER = "esp32_door"
MQTT_PASSWORD = "esp32_door"
MQTT_CLIENT_ID = "esp32_711_door"
TOPIC_STATUS = "smart_home/door/status"
TOPIC_CMD = "smart_home/door/cmd"
TOPIC_LDR = "smart_home/door/ldr_cmd"

OPEN_MS = 3000      # เปิดค้างหลังเจอคนล่าสุด (ส่งไปบอกเว็บด้วย hold_ms)
THANKS_MS = 1000    # แสดง "Thank You" ก่อนกลับ Standby (ไม่บล็อกลูปแล้ว)
NIGHT_LDR = 2000    # LDR > ค่านี้ = กลางคืน

customer_count = 0
mode = "AUTO"
web_triggered = False
remote_ldr = None
last_source = "wokwi"
last_physical_ldr = 0


net_off_until = None    # ทดสอบตัดเน็ต: เวลาที่จะต่อกลับ (ticks)


def sub_cb(topic, msg):
    """รับคำสั่งจากเว็บ — ข้อมูลผิดรูปแบบ/นอกช่วงจะถูกละเลยหรือจำกัดค่า ไม่ทำให้ระบบล้ม"""
    global mode, web_triggered, remote_ldr, last_source, net_off_until
    try:
        text = msg.decode().strip()
        if topic == b"smart_home/door/cmd":
            if text in ("AUTO", "HOLD_OPEN", "LOCKED"):
                mode = text
                print("Mode ->", mode)
            elif text == "TRIGGER":
                web_triggered = True
                print("TRIGGER from web")
            elif text.startswith("NET_OFF"):      # NET_OFF หรือ NET_OFF:30 (วินาที 5-120)
                secs = int(text.split(":")[1]) if ":" in text else 20
                secs = max(5, min(120, secs))
                net_off_until = time.ticks_add(time.ticks_ms(), secs * 1000)
                print("Network cut test for", secs, "s")
            else:
                print("Ignored cmd:", text)
        elif topic == b"smart_home/door/ldr_cmd":
            remote_ldr = max(0, min(4095, int(text)))   # จำกัดช่วง 0-4095
            last_source = "web"
            print("LDR from web:", remote_ldr)
    except Exception as e:
        print("Bad message ignored:", e)


# --- 2. เชื่อมต่อ Wi-Fi + HiveMQ (ต่อใหม่อัตโนมัติถ้าหลุด) ---
cloud = Cloud(MQTT_SERVER, MQTT_USER, MQTT_PASSWORD, MQTT_CLIENT_ID,
              status_topic=TOPIC_STATUS,
              subscribe=[TOPIC_CMD, TOPIC_LDR],
              on_message=sub_cb)
while True:
    try:
        cloud.wifi_connect()
        break
    except OSError as e:
        print("WiFi retry:", e)
cloud.connect()


def pub(d):
    d["mode"] = mode
    cloud.count = customer_count
    cloud.publish(TOPIC_STATUS, d)


# --- 3. LCD 1602 I2C ---
class I2cLcd:
    def __init__(self, i2c, addr, lines, cols):
        self.i2c = i2c
        self.addr = addr
        self.backlight = 0x08
        time.sleep(0.02)
        for c in (0x33, 0x32, 0x28, 0x0C, 0x06):
            self._init(c)
        self.clear()

    def _init(self, cmd):
        for nib in (cmd & 0xF0, (cmd << 4) & 0xF0):
            self.i2c.writeto(self.addr, bytes([nib | 0x04 | self.backlight]))
            time.sleep(0.001)
            self.i2c.writeto(self.addr, bytes([nib | self.backlight]))
            time.sleep(0.001)

    def _send(self, val, rs):
        for nib in (val & 0xF0, (val << 4) & 0xF0):
            self.i2c.writeto(self.addr, bytes([nib | 0x04 | rs | self.backlight]))
            self.i2c.writeto(self.addr, bytes([nib | rs | self.backlight]))

    def write_cmd(self, cmd):
        self._send(cmd, 0)

    def write_data(self, data):
        self._send(data, 1)

    def clear(self):
        self.write_cmd(0x01)
        time.sleep(0.002)

    def putstr(self, string):
        for ch in string:
            if ch == "\n":
                self.write_cmd(0xC0)
            else:
                self.write_data(ord(ch))


# --- 4. ฮาร์ดแวร์ ---
i2c = I2C(0, scl=Pin(22), sda=Pin(21))
lcd = I2cLcd(i2c, 0x27, 2, 16)
pir = Pin(33, Pin.IN)
led = PWM(Pin(16), freq=1000, duty=0)
ldr = ADC(Pin(34))
ldr.atten(ADC.ATTN_11DB)
buzzer = PWM(Pin(17), freq=1000, duty=0)
servo = PWM(Pin(15), freq=50)


def set_servo_angle(angle):
    servo.duty(int(40 + (angle / 180) * 75))


def play_711_chime():
    for freq, dur in ((659, 0.08), (523, 0.08), (659, 0.08), (784, 0.15)):
        buzzer.freq(freq)
        buzzer.duty(512)
        time.sleep(dur)
        buzzer.duty(0)
        time.sleep(0.01)


_last_lcd = ("", "")


def update_lcd(l1, l2):
    global _last_lcd
    if (l1, l2) != _last_lcd:
        lcd.clear()
        lcd.putstr(l1 + "\n" + l2)
        _last_lcd = (l1, l2)


# --- 5. State machine ---
STATE_IDLE, STATE_OPEN, STATE_THANKS = 0, 1, 2
state = STATE_IDLE
timer_start = 0
last_ldr_publish = 0
prev_mode = "AUTO"

set_servo_angle(0)
update_lcd("Smart Door", "Standby...")
print("Smart 7-11 Door started")

while True:
    now = time.ticks_ms()

    # ทดสอบตัดเน็ต (NFR-01): ตัดตามเวลาที่สั่ง แล้วต่อกลับเอง — ระหว่างนั้นประตูต้องยังทำงานปกติ
    if net_off_until is not None:
        if cloud.enabled:
            cloud.go_offline()
            print("NETWORK CUT (test)")
        elif time.ticks_diff(now, net_off_until) >= 0:
            net_off_until = None
            cloud.go_online()
            print("NETWORK RESTORED")

    cloud.loop()                       # รับคำสั่งจากเว็บ + reconnect

    # เลือกค่าแสง: อันที่เปลี่ยนล่าสุดชนะ (Wokwi vs เว็บ)
    physical_ldr = ldr.read()
    if abs(physical_ldr - last_physical_ldr) > 40:
        last_physical_ldr = physical_ldr
        last_source = "wokwi"
    active_ldr = remote_ldr if (last_source == "web" and remote_ldr is not None) else physical_ldr

    if time.ticks_diff(now, last_ldr_publish) >= 2000:
        last_ldr_publish = now
        pub({"ldr": active_ldr, "count": customer_count})

    # --- เปลี่ยนโหมด: รีเซ็ตสถานะให้สะอาด ---
    if mode != prev_mode:
        state = STATE_IDLE
        web_triggered = False
        if mode == "AUTO":
            set_servo_angle(0)         # แก้บั๊ก: ออกจาก HOLD_OPEN แล้วประตูต้องปิด
            led.duty(0)
            update_lcd("Smart Door", "Standby...")
        prev_mode = mode

    if mode == "LOCKED":
        set_servo_angle(0)
        led.duty(0)
        update_lcd("Door Locked", "System Secured")
        web_triggered = False
        time.sleep(0.05)
        continue
    if mode == "HOLD_OPEN":
        set_servo_angle(180)
        led.duty(1023)
        update_lcd("Hold Open Mode", "Door Unlocked")
        web_triggered = False
        time.sleep(0.05)
        continue

    # --- โหมด AUTO ---
    if state == STATE_IDLE:
        brightness = 0 if active_ldr < 1000 else min(int(active_ldr / 5), 800)
        led.duty(brightness)
        update_lcd("Smart Door", "Cust:%d%s" % (customer_count, "" if cloud.connected else " OFFLINE"))

        if pir.value() == 1 or web_triggered:
            web_triggered = False
            customer_count += 1
            print("Motion! Customer #%d (LDR %d)" % (customer_count, active_ldr))
            pub({"event": "OPEN", "count": customer_count, "ldr": active_ldr, "hold_ms": OPEN_MS})
            play_711_chime()
            set_servo_angle(180)
            if active_ldr > NIGHT_LDR:
                led.duty(1023)
                update_lcd("Welcome! (Night)", "Cust #%d" % customer_count)
            else:
                led.duty(0)
                update_lcd("Welcome! (Day)", "Cust #%d" % customer_count)
            state = STATE_OPEN
            timer_start = time.ticks_ms()

    elif state == STATE_OPEN:
        if pir.value() == 1:
            timer_start = now          # เจอคนอีก -> ต่อเวลา
        if time.ticks_diff(now, timer_start) >= OPEN_MS:
            print("Closing door")
            pub({"event": "CLOSED", "count": customer_count, "ldr": active_ldr})
            set_servo_angle(0)
            led.duty(0)
            update_lcd("Thank You", "See you again")
            state = STATE_THANKS
            timer_start = now

    elif state == STATE_THANKS:        # แทน time.sleep(1) เดิม: ยังรับคำสั่งเว็บได้ระหว่างรอ
        if time.ticks_diff(now, timer_start) >= THANKS_MS:
            state = STATE_IDLE

    time.sleep(0.01)
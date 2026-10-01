# Cloud_connect.py  (MicroPython / ESP32)
# โมดูลเชื่อมต่อ Wi-Fi + HiveMQ Cloud (MQTT over TLS)
#  - auto-reconnect แบบไม่บล็อกลูปหลักนาน (connect timeout)
#  - ไม่พยายามต่อ MQTT ตอน Wi-Fi หลุด (กันค้าง)
#  - go_offline()/go_online() สำหรับทดสอบตัดเน็ต (NFR-01)
import network
import time
import json
from umqtt.simple import MQTTClient

try:
    import usocket as _sock
except ImportError:
    import socket as _sock


class Cloud:
    def __init__(self, server, user, password, client_id,
                 status_topic, subscribe=(), on_message=None,
                 port=8883, connect_timeout=6, retry_ms=5000):
        self.server = server
        self.user = user
        self.password = password
        self.client_id = client_id
        self.status_topic = status_topic
        self.subscribe_topics = subscribe
        self.on_message = on_message
        self.port = port
        self.connect_timeout = connect_timeout
        self.retry_ms = retry_ms
        self.client = None
        self.connected = False
        self.enabled = True          # False = จำลองเครือข่ายขัดข้อง
        self.count = 0               # ใช้ใส่ใน last will
        self._wlan = None
        self._ssid = None
        self._wpass = None
        self._wifi_try = None
        self._mqtt_try = None

    # ---------- Wi-Fi ----------
    def wifi_connect(self, ssid="Wokwi-GUEST", password="", timeout_s=20):
        self._ssid, self._wpass = ssid, password
        wlan = network.WLAN(network.STA_IF)
        wlan.active(True)
        self._wlan = wlan
        if not wlan.isconnected():
            wlan.connect(ssid, password)
            t0 = time.ticks_ms()
            while not wlan.isconnected():
                if time.ticks_diff(time.ticks_ms(), t0) > timeout_s * 1000:
                    raise OSError("WiFi timeout")
                time.sleep(0.3)
        print("WiFi OK:", wlan.ifconfig()[0])
        return wlan

    def wifi_ok(self):
        return self._wlan is not None and self._wlan.isconnected()

    def _due(self, attr):
        last = getattr(self, attr)
        now = time.ticks_ms()
        if last is None or time.ticks_diff(now, last) >= self.retry_ms:
            setattr(self, attr, now)
            return True
        return False

    # ---------- MQTT ----------
    def connect(self):
        """เชื่อมต่อ HiveMQ; คืน True/False (ไม่ throw) และมี timeout"""
        orig = _sock.socket

        def limited(*a, **k):          # ใส่ timeout ให้ socket ที่ umqtt สร้าง
            s = orig(*a, **k)
            s.settimeout(self.connect_timeout)
            return s

        _sock.socket = limited
        try:
            c = MQTTClient(
                client_id=self.client_id,
                server=self.server,
                port=self.port,
                user=self.user,
                password=self.password,
                keepalive=60,
                ssl=True,
                ssl_params={"server_hostname": self.server},
            )
            c.set_last_will(
                self.status_topic,
                json.dumps({"event": "OFFLINE", "count": self.count}),
                retain=True,
            )
            if self.on_message:
                c.set_callback(self.on_message)
            c.connect()
            for t in self.subscribe_topics:
                c.subscribe(t)
            self.client = c
            self.connected = True
            # retain เฉพาะ ONLINE/OFFLINE (ห้าม retain OPEN/CLOSED)
            c.publish(self.status_topic,
                      json.dumps({"event": "ONLINE", "count": self.count}),
                      retain=True)
            print("MQTT connected")
            return True
        except Exception as e:
            print("MQTT connect failed:", e)
            self.connected = False
            return False
        finally:
            _sock.socket = orig

    def ensure(self):
        """เรียกในลูปหลัก: ต่อใหม่เมื่อหลุด ทุก retry_ms โดยไม่ลองต่อ MQTT ถ้า Wi-Fi ยังไม่มา"""
        if not self.enabled:
            return False
        if self.connected:
            if self.wifi_ok():
                return True
            self.connected = False
        if not self.wifi_ok():
            if self._wlan and self._due("_wifi_try"):
                try:
                    self._wlan.connect(self._ssid, self._wpass)
                except Exception:
                    pass
            return False
        if self._due("_mqtt_try"):
            return self.connect()
        return False

    def loop(self):
        """เรียกทุกรอบของ while True: รับคำสั่งจากเว็บ + reconnect"""
        if not self.ensure():
            return
        try:
            self.client.check_msg()
        except Exception as e:
            print("MQTT lost:", e)
            self.connected = False

    def publish(self, topic, payload, retain=False):
        if not (self.connected and self.enabled):
            return False
        if not isinstance(payload, (str, bytes)):
            payload = json.dumps(payload)
        try:
            self.client.publish(topic, payload, retain=retain)
            return True
        except Exception as e:
            print("Publish error:", e)
            self.connected = False
            return False

    # ---------- จำลองเครือข่ายขัดข้อง ----------
    def go_offline(self):
        """แจ้ง OFFLINE แล้วตัด MQTT + Wi-Fi (ระบบควบคุมในพื้นที่ต้องยังทำงาน)"""
        if self.connected and self.client:
            try:
                self.client.publish(
                    self.status_topic,
                    json.dumps({"event": "OFFLINE", "count": self.count}),
                    retain=True)
            except Exception:
                pass
        try:
            self.client.sock.close()
        except Exception:
            pass
        self.connected = False
        self.enabled = False
        try:
            self._wlan.disconnect()
        except Exception:
            pass

    def go_online(self):
        self.enabled = True
        self._wifi_try = None
        self._mqtt_try = None
        try:
            self._wlan.connect(self._ssid, self._wpass)
        except Exception:
            pass
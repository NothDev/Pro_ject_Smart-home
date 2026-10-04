// --- ตั้งค่าการเชื่อมต่อ HiveMQ Cloud ผ่าน WebSocket ---
const MQTT_HOST = "wss://61286afe29624375903af5c7efec2060.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_OPTIONS = {
    clientId: "web_client_" + Math.random().toString(16).substring(2, 8),
    username: "esp32_door",
    password: "esp32_door",
    clean: true,
};

console.log("Connecting to HiveMQ Cloud via WebSocket...");
const client = mqtt.connect(MQTT_HOST, MQTT_OPTIONS);

client.on("connect", () => {
    console.log("Connected to HiveMQ Cloud successfully!");
    setConn('cloud');
    log('☁️ เชื่อมต่อ HiveMQ Cloud สำเร็จ');
    client.subscribe("smart_home/door/status", (err) => {
        if (!err) {
            console.log("Subscribed to smart_home/door/status");
        }
    });
});

client.on("reconnect", () => setConn('connecting'));
client.on("close", () => setConn('down'));
client.on("offline", () => setConn('down'));
client.on("error", (e) => console.error("MQTT error:", e));

client.on("message", (topic, payload, packet) => {
    if (topic !== "smart_home/door/status") return;

    let data;
    try { data = JSON.parse(payload.toString()); }
    catch (e) { console.error("JSON Parse Error:", e); return; }

    lastSeen = Date.now();

    // ESP32 หลุด (Last Will ของ MQTT)
    if (data.event === "OFFLINE") {
        setConn('offline');
        if (data.off_secs && !(packet && packet.retain)) {      // ถูกสั่งทดสอบตัดเน็ต -> นับถอยหลัง
            startOffCountdown(data.off_secs);
            log(`⚠️ [Wokwi] ESP32 ถูกสั่งออฟไลน์ ${data.off_secs} วินาที (ทดสอบตัดเน็ต)`);
        } else {
            log('⚠️ [Wokwi] ESP32 ออฟไลน์ (ขาดการเชื่อมต่อ)');
        }
        return;
    }
    if (data.event === "ONLINE" && connState !== 'online') log('📥 [Wokwi] ESP32 ออนไลน์');
    setConn('online');
    stopOffCountdown();

    if (data.count !== undefined) { count = data.count; $('cnt').textContent = count; }
    if (data.ldr !== undefined && !cycle) setLdr(data.ldr, true);
    if (data.hold_ms) HOLD = data.hold_ms;                       // เวลาถือประตูเปิดจาก ESP32 (แหล่งเดียว)
    if (data.mode && data.mode !== mode && Date.now() - lastModeSet > 3000) {
        setMode(data.mode, true);                                // ซิงก์โหมดจริงของ ESP32 (ไม่ส่งกลับ)
    }

    if (data.event === "OPEN") {
        openedAt = Date.now();
        pendingClose.forEach(clearTimeout); pendingClose = [];
        if (!busy) {
            busy = true;
            setLook();
            resetPeople();
            void P.offsetWidth;
            P.className = 'ppl go pA';

            later(() => {
                door(true);
                led(isNight());
                oled('Welcome!', `Cust #${count}`);
                const f = $('fill');
                f.style.transition = 'none';
                f.style.width = '100%';
                void f.offsetWidth;
                f.style.transition = `width ${HOLD}ms linear`;
                f.style.width = '0%';
            }, 1300);

            later(() => { P.className = 'ppl go turn pB'; }, 2400);
            later(() => { P.className = 'ppl'; I.className = 'ppl go turn in'; }, 3100);
            later(() => { I.classList.add('fade'); }, 6000);
            later(() => { busy = false; }, MIN_OPEN_VISIBLE + 800);
        }
        log(`📥 [Wokwi] ตรวจพบคน! ลูกค้าคนที่ #${count}`);
    }
    else if (data.event === "CLOSED") {
        // ESP32 ปิดประตูที่ ~3 วิ แต่แอนิเมชันคนเดินเข้าใช้เวลานานกว่า → รอให้คนเดินผ่านก่อนค่อยปิดบนเว็บ
        const wait = Math.max(0, openedAt + MIN_OPEN_VISIBLE - Date.now());
        pendingClose.push(setTimeout(() => {
            if (mode !== 'AUTO') return;
            door(false);
            led(false);
            oled('Thank You', `Total: ${count}`);
            log('📥 [Wokwi] ปิดประตูเรียบร้อย');
        }, wait));
    }
});

function setMode(m, silent) {
    mode = m;
    if (!silent) lastModeSet = Date.now();
    $('mode-badge').textContent = 'MODE: ' + m;
    ['AUTO', 'HOLD_OPEN', 'LOCKED'].forEach(x => $('b-' + x).classList.toggle('sel', x===m));
    
    if (!silent) {
        if (client.connected) {
            client.publish("smart_home/door/cmd", m);
            log(`📤 [Web] ส่งคำสั่งโหมด: ${m}`);
        } else {
            log(`⚠️ MQTT ยังไม่เชื่อมต่อ`);
        }
    }

    if (m === 'AUTO') { door(false); led(false); oled('Smart Door', 'Standby...'); }
    if (m === 'HOLD_OPEN') { door(true); led(isNight()); oled('Hold Open', 'Door Unlocked'); }
    if (m === 'LOCKED') { door(false); led(false); oled('Door Locked', 'System Secured'); }
}

const $=id=>document.getElementById(id), log_=$('log');
let HOLD=3000;                     // ซิงก์กับ OPEN_MS ใน main.py (ESP32 ส่ง hold_ms มาทับให้)
const MIN_OPEN_VISIBLE=4200;       // เวลาขั้นต่ำที่ประตูเปิดบนเว็บ ให้แอนิเมชันคนเดินเข้าเล่นจบ
let count=0, mode='AUTO', busy=false, ldr=500, cycle=null, timers=[];
let openedAt=0, pendingClose=[], lastSeen=0, lastModeSet=0, connState='';

// ----- นับถอยหลังตอน ESP32 ถูกสั่งตัดเน็ต (NET_OFF) -----
let offTimer=null, offEnd=0, offTotal=0;
function startOffCountdown(secs){
  stopOffCountdown();
  offTotal=secs; offEnd=Date.now()+secs*1000;
  $('off-banner').classList.remove('hidden');
  $('off-text').textContent=`ESP32 ถูกสั่งให้ออฟไลน์ ${secs} วินาที (ทดสอบตัดเน็ต)`;
  tickOff();
  offTimer=setInterval(tickOff,200);
}
function tickOff(){
  const ms=Math.max(0,offEnd-Date.now());
  $('off-count').textContent=Math.ceil(ms/1000);
  $('off-bar').style.width=(offTotal>0 ? ms/(offTotal*1000)*100 : 0)+'%';
  if(ms===0) $('off-text').textContent='ครบเวลาแล้ว กำลังรอ ESP32 เชื่อมต่อกลับ...';
}
function stopOffCountdown(){
  if(offTimer){ clearInterval(offTimer); offTimer=null; }
  $('off-banner').classList.add('hidden');
}

// ----- สถานะการเชื่อมต่อ (ป้ายมุมขวาบน) -----
const CONN={
  connecting:['กำลังเชื่อมต่อ HiveMQ…','amber'],
  cloud:['เชื่อม Cloud แล้ว · รอ ESP32','sky'],
  online:['ESP32 ออนไลน์','emerald'],
  offline:['ESP32 ออฟไลน์','rose'],
  down:['หลุดการเชื่อมต่อ MQTT','rose']
};
function setConn(st){
  if(st===connState) return;
  connState=st;
  const [t,c]=CONN[st];
  $('conn-badge').className='conn '+c;
  $('conn-text').textContent=t;
  applyConnUI();
}
// ปุ่มควบคุมใช้ได้เฉพาะตอน ESP32 ออนไลน์ (ตอนออฟไลน์คำสั่งจะหายและไม่ถึง ESP32)
// และถ้าออฟไลน์/หลุด ฉากหน้าร้านจะเทาลงและมีป้าย "แสดงข้อมูลล่าสุด" เพราะไม่มีข้อมูลสดเข้ามา
function applyConnUI(){
  const live = connState==='online';
  const stale = connState==='offline' || connState==='down';
  document.querySelectorAll('[onclick^="setMode"],[onclick^="triggerMotion"],[onclick^="onSliderInput"],[onclick^="toggleCycle"],[onclick^="netCut"]')
    .forEach(b => { b.disabled = !live; });
  ['slider','net-secs'].forEach(id => { $(id).disabled = !live; });
  $('scene').classList.toggle('stale', stale);
  $('stale-note').classList.toggle('hidden', !stale);
  if(stale && cycle) toggleCycle();
}

function log(m){
    const d=document.createElement('div');
    d.className = m.includes('⚠️') ? 'lg-w' : m.includes('📤') ? 'lg-out' : m.includes('📥') ? 'lg-in' : '';
    d.innerHTML=`<span class="text-slate-500">[${new Date().toLocaleTimeString('th-TH')}]</span> ${m}`;
    log_.prepend(d);
    while(log_.children.length>30) log_.lastChild.remove();
}

function oled(a,b){
    $('oled').innerHTML=`<div class="m text-2xl font-bold tracking-wider">${a}</div><div class="s text-lg mt-1">${b}</div>`;
}

const isNight=()=>ldr>2000;
const door=(o)=>{$('scene').classList.toggle('opened',o)};
const led=(o)=>$('led').classList.toggle('on',o);

// ฟังก์ชันเมื่อเลื่อนสไลเดอร์บนเว็บ (ซ้าย = มืด 0%, ขวา = สว่าง 100%)
function onSliderInput(sliderVal){
  let val = parseInt(sliderVal);
  if (isNaN(val)) return;
  val = Math.max(0, Math.min(4095, val));
  const ldrVal = 4095 - val;
  
  if (client.connected) {
      client.publish("smart_home/door/ldr_cmd", ldrVal.toString());
  }
  setLdr(ldrVal, true);
}

function setLdr(v, fromServer){
  const wasNight=$('scene').classList.contains('night');
  if(!fromServer && cycle) toggleCycle();
  const num = parseInt(v);
  if(isNaN(num)) return;
  ldr = Math.max(0, Math.min(4095, num));   // จำกัดช่วง 0-4095

  const sliderVal = 4095 - ldr;
  $('slider').value = sliderVal;

  const percent = Math.max(0, Math.min(100, Math.round(((4095 - ldr) / 4095) * 100)));
  $('ldr').textContent = percent + '%';

  const n = isNight();
  $('ldr-label').textContent = `แสงสว่าง: ${percent}% (${n ? '🌙 มืด' : '☀️ สว่าง'})`;
  $('scene').classList.toggle('night', n);$('dn-badge').textContent = n ? '🌙 กลางคืน' : '☀️ กลางวัน';
  $('b-day').classList.toggle('sel', !n);$('b-night').classList.toggle('sel', n);
  
  if(n !== wasNight){
    log(n ? '🌙 เข้าสู่โหมดกลางคืน' : '☀️ เข้าสู่โหมดกลางวัน');
    if($('scene').classList.contains('opened')) led(n);
  }
}

// ทดสอบ NFR-01: สั่งให้ ESP32 ตัดเน็ต 20 วินาที (ประตูต้องยังทำงานในพื้นที่ แล้วเชื่อมต่อกลับเอง)
function netCut(secs){
  secs = Math.max(5, Math.min(120, parseInt(secs) || 20));       // ESP32 รองรับ 5-120 วินาที
  if(!client.connected){ log('⚠️ MQTT ยังไม่เชื่อมต่อ'); return }
  client.publish("smart_home/door/cmd","NET_OFF:"+secs);
  log(`📤 [Web] สั่งทดสอบตัดเน็ต ESP32 ${secs} วินาที — กด PIR ใน Wokwi เพื่อดูว่าประตูยังเปิดได้`);
}
function netCutCustom(){
  const inp=$('net-secs'), raw=parseInt(inp.value);
  if(isNaN(raw)){ log('⚠️ กรอกจำนวนวินาทีเป็นตัวเลข (5–120)'); return }
  const secs=Math.max(5, Math.min(120, raw));
  if(secs!==raw){ inp.value=secs; log(`⚠️ ปรับเวลาเป็น ${secs} วินาที (ช่วงที่รองรับ 5–120)`); }
  netCut(secs);
}

function toggleCycle(){
  if(cycle){clearInterval(cycle); cycle=null; $('b-cycle').classList.remove('sel'); log('⏹ หยุดการวนกลางวัน/กลางคืน'); return}
  $('b-cycle').classList.add('sel'); log('🔄 เริ่มวนกลางวัน/กลางคืนอัตโนมัติ');
  let t = ldr<2000 ? 0 : Math.PI;
  let tick=0;
  cycle = setInterval(()=>{
    t+=0.03;
    const v=Math.round(2047+Math.sin(t-Math.PI/2)*2047);
    setLdr(v, true);
    if(client.connected && ++tick%10===0) client.publish("smart_home/door/ldr_cmd", String(v)); // ส่งให้ ESP32 วินาทีละครั้ง
  }, 100);
}

const later=(f,ms)=>timers.push(setTimeout(f,ms));
const clearTimers=()=>timers.forEach(clearTimeout);

const P=$('person'), I=$('insider');
const looks=[
  {shirt:'#f8fafc',shirtd:'#cbd5e1',pants:'#1e293b',pantsd:'#0f172a',hair:'#111827',skin:'#f1c9a5'},
  {shirt:'#ffffff',shirtd:'#e2e8f0',pants:'#1d4ed8',pantsd:'#1e40af',hair:'#1f2937',skin:'#e0ac82'},
  {shirt:'#f97316',shirtd:'#c2410c',pants:'#374151',pantsd:'#1f2937',hair:'#111827',skin:'#c68a5e'},
  {shirt:'#a855f7',shirtd:'#7e22ce',pants:'#475569',pantsd:'#334155',hair:'#0f172a',skin:'#f1c9a5'},
  {shirt:'#facc15',shirtd:'#ca8a04',pants:'#111827',pantsd:'#030712',hair:'#1f2937',skin:'#d9a273'},
  {shirt:'#0ea5e9',shirtd:'#0369a1',pants:'#334155',pantsd:'#1e293b',hair:'#78350f',skin:'#e0ac82'},
  {shirt:'#d4b28c',shirtd:'#bc8a5f',pants:'#654321',pantsd:'#4a3319',hair:'#3d2314',skin:'#f1c9a5'},
  {shirt:'#334155',shirtd:'#1e293b',pants:'#0f172a',pantsd:'#020617',hair:'#000000',skin:'#e0ac82'},
  {shirt:'#ffffff',shirtd:'#cbd5e1',pants:'#0f172a',pantsd:'#020617',hair:'#451a03',skin:'#f1c9a5'},
  {shirt:'#15803d',shirtd:'#166534',pants:'#1e293b',pantsd:'#0f172a',hair:'#111827',skin:'#e0ac82'},
  {shirt:'#dc2626',shirtd:'#b91c1c',pants:'#1f2937',pantsd:'#111827',hair:'#78350f',skin:'#c68a5e'},
  {shirt:'#f472b6',shirtd:'#db2777',pants:'#4b5563',pantsd:'#374151',hair:'#111827',skin:'#f1c9a5'}
];

const pSvg=`<svg viewBox="0 0 60 130">
<ellipse cx="30" cy="127" rx="17" ry="3.5" fill="rgba(0,0,0,.28)"/>
<g class="side">
<g class="armB"><rect x="27" y="40" width="7" height="30" rx="3.5" fill="var(--shirtd)"/><circle cx="30.5" cy="71" r="3.6" fill="var(--skin)"/></g>
<g class="legB"><rect x="26" y="66" width="10" height="52" rx="4" fill="var(--pantsd)"/><path d="M25 116h17a3 3 0 0 1 0 8H25z" fill="#1f2937"/></g>
<g class="legF"><rect x="26" y="66" width="11" height="52" rx="4" fill="var(--pants)"/><path d="M25 116h18a3 3 0 0 1 0 8H25z" fill="#111827"/></g>
<rect x="22" y="36" width="20" height="36" rx="8" fill="var(--shirt)"/>
<g class="armF"><rect x="27" y="40" width="7" height="30" rx="3.5" fill="var(--shirt)"/><circle cx="30.5" cy="71" r="3.6" fill="var(--skin)"/></g>
<rect x="27" y="28" width="7" height="9" rx="3" fill="var(--skin)"/><circle cx="31" cy="20" r="10" fill="var(--skin)"/>
<path d="M21 19c-1-9 6-13 12-12 6 1 9 6 8 11-3-4-8-5-12-4-3 1-6 3-8 5z" fill="var(--hair)"/><circle cx="37" cy="21" r="1.3" fill="#1f2937"/>
</g>
<g class="back">
<g class="bArmL"><rect x="11" y="40" width="7" height="30" rx="3.5" fill="var(--shirtd)"/><circle cx="14.5" cy="71" r="3.6" fill="var(--skin)"/></g>
<g class="bArmR"><rect x="42" y="40" width="7" height="30" rx="3.5" fill="var(--shirtd)"/><circle cx="45.5" cy="71" r="3.6" fill="var(--skin)"/></g>
<g class="bLegL"><rect x="19" y="66" width="11" height="52" rx="4" fill="var(--pants)"/><rect x="18" y="116" width="13" height="8" rx="3" fill="#111827"/></g>
<g class="bLegR"><rect x="30" y="66" width="11" height="52" rx="4" fill="var(--pantsd)"/><rect x="29" y="116" width="13" height="8" rx="3" fill="#111827"/></g>
<rect x="15" y="36" width="30" height="36" rx="10" fill="var(--shirt)"/><rect x="26" y="28" width="8" height="9" rx="3" fill="var(--skin)"/>
<circle cx="30" cy="19" r="10.5" fill="var(--hair)"/>
</g></svg>`;

P.innerHTML=I.innerHTML=pSvg;
let lk=0;
function setLook(){const l=looks[lk++%looks.length];[P,I].forEach(e=>Object.entries(l).forEach(([k,v])=>e.style.setProperty('--'+k,v)))}
function resetPeople(){P.className='ppl';I.className='ppl'}

function triggerMotion(){
  if(mode!=='AUTO'){log(`⚠️ อยู่ในโหมด ${mode} ไม่เปิดอัตโนมัติ`);return}
  if(client.connected){
      client.publish("smart_home/door/cmd", "TRIGGER");
      log(`📤 [Web] ส่งคำสั่งจำลองคนเดินผ่านไปยัง Wokwi`);
  } else {
      log(`⚠️ MQTT ยังไม่เชื่อมต่อ`);
  }
}

setMode('AUTO', true);
setLdr(500, true);
setConn('connecting');
log('[System] กำลังเชื่อมต่อ HiveMQ Cloud...');

// ถ้า ESP32 เงียบเกิน 8 วินาที (ปกติส่งทุก 2 วิ) ถือว่าออฟไลน์
setInterval(()=>{
  if(connState==='online' && Date.now()-lastSeen>8000){
    setConn('offline');
    log('⚠️ ไม่ได้รับสัญญาณจาก ESP32 เกิน 8 วินาที');
  }
},1000);
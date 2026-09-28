var $=function(i){return document.getElementById(i)},HOLD=4000,MOVE=1400,busy=false,ctx;
function tile(id,txt,on){var e=$(id);e.className='t'+(on?' on':'');e.querySelector('b').textContent=txt}
function log(m){var d=document.createElement('div');d.innerHTML='<time>'+new Date().toLocaleTimeString('th-TH')+'</time>'+m;$('log').prepend(d);while($('log').children.length>25)$('log').lastChild.remove()}
function oled(a,b){$('oled').innerHTML='<div class="l1">'+a+'</div><div class="l2">'+b+'</div>'}
function step(n){document.querySelectorAll('.st').forEach(function(s){s.classList.toggle('on',+s.dataset.s===n)})}

function chime(){
  try{
    ctx=ctx||new(window.AudioContext||window.webkitAudioContext)();
    [784,659,523].forEach(function(f,i){
      var o=ctx.createOscillator(),g=ctx.createGain(),t=ctx.currentTime+i*.28;
      o.type='sine';o.frequency.value=f;o.connect(g);g.connect(ctx.destination);
      g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.16,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.7);
      o.start(t);o.stop(t+.75);
    });
  }catch(e){}
  tile('tSnd','Playing…',true);setTimeout(function(){tile('tSnd','Silent')},1200);
}

function swing(from,to,cb){
  var t0=performance.now();
  (function f(t){
    var p=Math.min((t-t0)/MOVE,1),e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2,a=from+(to-from)*e;
    $('door').style.setProperty('--a',a);
    tile('tDoor',(a>1?'OPEN':'CLOSED')+' · '+Math.round(a)+'°',a>1);
    p<1?requestAnimationFrame(f):cb&&cb();
  })(t0);
}

// ฟังก์ชันหลักรับเหตุการณ์จาก ESP32 ผ่าน MQTT (รองรับ JSON)
function handleCloudEvent(eventData) {
  var st=$('stage');
  var eventType = eventData.event;
  var count = eventData.count || 0;

  if(eventType === 'OPEN') {
    if(busy) return;
    busy = true;
    st.classList.add('busy','lit','opened');
    step(2);
    tile('tPir','Motion!',true);
    tile('tLed','ON',true);
    chime();
    oled('Welcome!', 'Customer #' + count);
    log('MQTT [OPEN] → ลูกค้าคนที่ #' + count + ' เข้าร้าน');
    
    swing(0, 90, function(){
      var f=$('fill');
      f.style.transition='none';
      f.style.width='100%';
      void f.offsetWidth;
      f.style.transition='width '+HOLD+'ms linear';
      f.style.width='0%';
      tile('tPir','Idle');
    });
    
  } else if(eventType === 'CLOSED') {
    step(3);
    st.classList.remove('opened');
    oled('Thank You', 'Total: ' + count + ' cust');
    log('MQTT [CLOSED] → ปิดประตูเรียบร้อย');
    
    swing(90, 0, function(){
      setTimeout(function(){
        st.classList.remove('lit','busy');
        tile('tLed','OFF');
        step(1);
        oled('Smart Door','Standby...');
        busy = false;
      }, 1500);
    });
  } else if(eventType === 'OFFLINE') {
    log('⚠️ เตือน: ฮาร์ดแวร์ ESP32 ออฟไลน์ (Last Will Triggered)');
    oled('Device Offline', 'Check Connection');
  }
}

// --- เชื่อมต่อ MQTT.js ผ่าน WebSocket (พอร์ต 8884) ---
const MQTT_HOST = 'wss://61286afe29624375903af5c7efec2060.s1.eu.hivemq.cloud:8884/mqtt';
const MQTT_OPTIONS = {
    clientId: 'web_dashboard_' + Math.random().toString(16).substring(2, 8),
    username: 'esp32_door', 
    password: 'รหัสผ่านของคุณ', // <--- ใส่ Password ของคุณ
    clean: true,
};

const client = mqtt.connect(MQTT_HOST, MQTT_OPTIONS);

client.on('connect', () => {
    log('เชื่อมต่อ HiveMQ Cloud สำเร็จผ่าน WebSocket!');
    client.subscribe('smart_home/door/status', (err) => {
        if (!err) log('ติดตาม Topic สถานะสำเร็จ');
    });
});

client.on('message', (topic, payload) => {
    try {
        const data = JSON.parse(payload.toString());
        handleCloudEvent(data);
    } catch(e) {
        log('รับข้อความดิบ: ' + payload.toString());
    }
});

// ฟังก์ชันส่งคำสั่งควบคุมโหมดจากหน้าเว็บกลับไปหา ESP32 (Two-way control)
function sendCommand(modeName) {
    client.publish('smart_home/door/cmd', modeName, (err) => {
        if (!err) {
            log('📤 ส่งคำสั่งสำเร็จ: Mode -> ' + modeName);
        } else {
            log('❌ ส่งคำสั่งไม่สำเร็จ');
        }
    });
}

// ผูกปุ่มจำลองบนหน้าเว็บแบบเดิม
$('pir').addEventListener('click', function(){
    handleCloudEvent({ event: 'OPEN', count: 99 });
    setTimeout(function(){
        handleCloudEvent({ event: 'CLOSED', count: 99 });
    }, HOLD + 1500);
});

log('ระบบเว็บพร้อม · รอรับข้อมูลจากฮาร์ดแวร์');
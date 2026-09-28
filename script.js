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
function trigger(){
  if(busy)return;busy=true;
  var st=$('stage');st.classList.add('busy','lit','opened');
  step(2);tile('tPir','Motion!',true);tile('tLed','ON',true);
  chime();oled('Welcome!','Please come in');
  log('PIR ทริก → เล่นเสียงต้อนรับ + LED ติด + ประตูเริ่มเปิด');
  swing(0,90,function(){
    log('ประตูเปิดสุด 90° → เปิดค้าง 4 วินาที');
    var f=$('fill');f.style.transition='none';f.style.width='100%';void f.offsetWidth;f.style.transition='width '+HOLD+'ms linear';f.style.width='0%';
    tile('tPir','Idle');
    setTimeout(function(){
      step(3);st.classList.remove('opened');oled('Thank You','See you again');
      log('ครบเวลา → ประตูเริ่มปิดกลับ 0° · OLED: Thank You');
      swing(90,0,function(){
        setTimeout(function(){
          st.classList.remove('lit','busy');tile('tLed','OFF');step(1);
          oled('Smart Door','Standby...');busy=false;
          log('LED ดับ · รีเซ็ตกลับสู่ Standby รอการทริกครั้งถัดไป');
        },1500);
      });
    },HOLD);
  });
}
$('pir').addEventListener('click',trigger);
$('sw').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;document.body.dataset.v=b.dataset.v;this.querySelectorAll('button').forEach(function(x){x.setAttribute('aria-pressed',x===b)})});
log('ระบบพร้อม · สถานะ Standby');

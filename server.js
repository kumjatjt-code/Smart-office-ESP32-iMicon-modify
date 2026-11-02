const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

let relayStates = [false, false, false, false];
let autoMode = true; // เปิดใช้งานโหมดอัตโนมัติเป็นค่าเริ่มต้น
let lastAutoResetDate = ''; // ตัวแปรบันทึกวันที่ที่เปิดโหมด Auto ตอน 07:45 น.

app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------------
// ฟังก์ชันกระจายสถานะล่าสุดให้ทุก Client (ESP32 และ Web Dashboard)
// -------------------------------------------------------------------------
function broadcastState() {
    const payload = JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// -------------------------------------------------------------------------
// ฟังก์ชันคำนวณเวลาประเทศไทย (UTC+7) และสลับการทำงานอัตโนมัติ
// -------------------------------------------------------------------------
function checkAutoSchedule() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // เวลาไทย (UTC+7)

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const dateStr = `${thTime.getFullYear()}-${thTime.getMonth() + 1}-${thTime.getDate()}`;

    // ---------------------------------------------------------------------
    // เงื่อนไข: เวลา 07:45 น. ของทุกวัน ให้เปิดโหมดอัตโนมัติเสมอ
    // ---------------------------------------------------------------------
    if (hours === 7 && minutes === 45 && lastAutoResetDate !== dateStr) {
        lastAutoResetDate = dateStr;
        if (!autoMode) {
            autoMode = true;
            console.log(`[Auto Schedule] ⏰ เวลา 07:45 น. (${dateStr}): รีเซ็ตเข้าสู่โหมดทำงานอัตโนมัติประจำวันเรียบร้อย`);
            broadcastState(); // สั่งอัปเดตสวิตช์บนหน้าเว็บให้เปิดอัตโนมัติ
        }
    }

    // หากผู้ใช้สั่งปิดโหมด Auto (หลัง 07:45 น.) จะไม่ปรับสถานะแอร์ทับการควบคุมแบบ Manual
    if (!autoMode) return;

    let air1 = false;
    let air2 = false;
    let air3 = false;

    // ตารางเวลาทำงานสลับแอร์ (08:00 - 16:00 น.)
    if (totalMinutes >= 480 && totalMinutes < 510) {          // 08:00 - 08:30 [Air1]
        air1 = true;
    } else if (totalMinutes >= 510 && totalMinutes < 540) {   // 08:30 - 09:00 [Air2]
        air2 = true;
    } else if (totalMinutes >= 540 && totalMinutes < 570) {   // 09:00 - 09:30 [Air1]
        air1 = true;
    } else if (totalMinutes >= 570 && totalMinutes < 600) {   // 09:30 - 10:00 [Air2]
        air2 = true;
    } else if (totalMinutes >= 600 && totalMinutes < 630) {   // 10:00 - 10:30 [Air1]
        air1 = true;
    } else if (totalMinutes >= 630 && totalMinutes < 660) {   // 10:30 - 11:00 [Air1, Air2]
        air1 = true; air2 = true;
    } else if (totalMinutes >= 660 && totalMinutes < 690) {   // 11:00 - 11:30 [Air2, Air3]
        air2 = true; air3 = true;
    } else if (totalMinutes >= 690 && totalMinutes < 720) {   // 11:30 - 12:00 [Air1, Air3]
        air1 = true; air3 = true;
    } else if (totalMinutes >= 720 && totalMinutes < 750) {   // 12:00 - 12:30 [Air2, Air3]
        air2 = true; air3 = true;
    } else if (totalMinutes >= 750 && totalMinutes < 840) {   // 12:30 - 14:00 [Air2, Air3]
        air2 = true; air3 = true;
    } else if (totalMinutes >= 840 && totalMinutes < 870) {   // 14:00 - 14:30 [Air1, Air2]
        air1 = true; air2 = true;
    } else if (totalMinutes >= 870 && totalMinutes < 900) {   // 14:30 - 15:00 [Air3]
        air3 = true;
    } else if (totalMinutes >= 900 && totalMinutes < 930) {   // 15:00 - 15:30 [Air2, Air3]
        air2 = true; air3 = true;
    } else if (totalMinutes >= 930 && totalMinutes < 960) {   // 15:30 - 16:00 [Air1]
        air1 = true;
    }

    let isChanged = false;
    if (relayStates[0] !== air1) { relayStates[0] = air1; isChanged = true; }
    if (relayStates[1] !== air2) { relayStates[1] = air2; isChanged = true; }
    if (relayStates[2] !== air3) { relayStates[2] = air3; isChanged = true; }

    if (isChanged) {
        console.log(`[Auto Schedule] ปรับตามตาราง: Air1=${air1}, Air2=${air2}, Air3=${air3}`);
        broadcastState();
    }
}

// ตรวจสอบตารางเวลาทุกๆ 10 วินาที
setInterval(checkAutoSchedule, 10000);

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'GET_STATE') {
                ws.send(JSON.stringify({
                    type: 'INIT_STATE',
                    relays: relayStates,
                    autoMode: autoMode
                }));
            }
            else if (data.type === 'CONTROL') {
                const { ch, state } = data;
                if (ch >= 0 && ch < 4) {
                    relayStates[ch] = state;
                    broadcastState();
                }
            }
            else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = data.state;
                }
                broadcastState();
            }
            else if (data.type === 'TOGGLE_AUTO') {
                autoMode = Boolean(data.state);
                console.log(`[Auto Schedule] สลับสถานะเป็น: ${autoMode ? 'เปิดทำงาน' : 'ปิดทำงาน'}`);
                if (autoMode) {
                    checkAutoSchedule();
                }
                broadcastState();
            }
            else if (data.type === 'STATE_UPDATE' && Array.isArray(data.relays)) {
                if (data.relays.length === 4) {
                    relayStates = data.relays;
                    broadcastState();
                }
            }
        } catch (err) {
            console.error('JSON Error:', err.message);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
    checkAutoSchedule();
});
2. อัปเดตข้อความบนหน้าเว็บ public/index.html
สามารถปรับข้อความใต้หัวข้อโหมด Auto Schedule ใน public/index.html ให้แสดงรายละเอียดช่วงเวลาและเงื่อนไข 07:45 น. ได้ดังนี้:

HTML
    <!-- โหมดอัตโนมัติ -->
    <div class="glass-card rounded-2xl p-4 border-l-4 border-l-sky-500 relative overflow-hidden">
      <div class="flex items-start justify-between gap-3">
        <div class="flex gap-3">
          <div class="mt-0.5 w-9 h-9 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 shrink-0">
            <i class="fa-solid fa-calendar-check text-sm"></i>
          </div>
          <div>
            <h2 class="text-sm font-semibold text-white leading-tight">โหมดทำงานอัตโนมัติตามเวลา (Auto Schedule)</h2>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">
              เปิด-ปิด Air 1, Air 2, Air 3 อัตโนมัติ<br>
              <span class="text-sky-300 font-medium">ช่วงเวลา 08:00 - 16:00 น. (เปิดโหมด 07:45 น. | รีเซ็ต 07:50 น.)</span>
            </p>
          </div>
        </div>
        <div class="relative inline-block w-12 align-middle select-none mt-1">
          <input type="checkbox" id="scheduleToggle" checked class="toggle-checkbox absolute block w-6 h-6 rounded-full bg-white border-2 border-slate-700 appearance-none cursor-pointer focus:outline-none"/>
          <label for="scheduleToggle" class="toggle-label block overflow-hidden h-6 rounded-full bg-slate-700/80 cursor-pointer transition-colors duration-200"></label>
        </div>
      </div>
    </div>

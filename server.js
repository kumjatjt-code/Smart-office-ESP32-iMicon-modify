const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

let relayStates = [false, false, false, false];
// ตั้งค่าเริ่มต้นเป็น true เพื่อให้โหมดอัตโนมัติทำงานทันทีที่เปิดระบบ
let autoMode = true; 

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
    // หากถูกสั่งปิดโหมด Auto จะไม่คำนวณทับการควบคุมแบบ Manual
    if (!autoMode) return;

    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // ปรับเวลาเป็นเวลาไทย (UTC+7)

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;

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
    // ส่งสถานะปัจจุบันและ autoMode ให้ Client ทันทีที่เชื่อมต่อ
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
            // สั่งควบคุมรายช่อง (Manual)
            else if (data.type === 'CONTROL') {
                const { ch, state } = data;
                if (ch >= 0 && ch < 4) {
                    relayStates[ch] = state;
                    broadcastState();
                }
            }
            // สั่งเปิด-ปิดทั้งหมด (Manual All)
            else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = data.state;
                }
                broadcastState();
            }
            // สลับสถานะโหมด Auto (เปิด/ปิดตามคำสั่งจากสวิตช์หน้าเว็บ)
            else if (data.type === 'TOGGLE_AUTO') {
                autoMode = Boolean(data.state);
                console.log(`[Auto Schedule] สลับสถานะเป็น: ${autoMode ? 'เปิดทำงาน' : 'ปิดทำงาน'}`);
                if (autoMode) {
                    checkAutoSchedule(); // คำนวณเวลาทันทีที่เปิดสวิตช์
                }
                broadcastState();
            }
            // ESP32 รายงานสถานะจริงกลับมา
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
    // คำนวณสถานะเวลาอัตโนมัติรอบแรกทันทีตอนเปิดเซิร์ฟเวอร์
    checkAutoSchedule();
});

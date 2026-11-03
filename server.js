const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

// ตัวแปรเก็บสถานะ Relay ทั้ง 4 ช่อง [Air1, Air2, Air3, Relay4]
let relayStates = [false, false, false, false];
let autoMode = true; // เปิดใช้งานโหมดอัตโนมัติเป็นค่าเริ่มต้น

// -------------------------------------------------------------------------
// ตัวแปรส่วนกลางสำหรับนับเวลาสะสม (หน่วยเป็นวินาที) บน Server
// -------------------------------------------------------------------------
let deviceTotalSeconds = [0, 0, 0, 0];
let lastAutoResetDate = '';  // บันทึกวันที่เพื่อเปิดโหมด Auto ตอน 07:45 น.
let lastDailyResetDate = ''; // บันทึกวันที่เพื่อรีเซ็ตเวลาเป็น 0 ตอน 07:50 น.

// ให้บริการไฟล์ Static จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------------
// ฟังก์ชันกระจายสถานะล่าสุด (Broadcast) ไปยังทุก Client (ESP32 และ Web UI)
// -------------------------------------------------------------------------
function broadcastState() {
    const payload = JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds // ส่งค่าเวลากลางไปให้ทุกเครื่องพร้อมกัน
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// -------------------------------------------------------------------------
// ฟังก์ชันตรวจสอบตารางเวลาสลับแอร์ (08:00 - 16:00 น.)
// -------------------------------------------------------------------------
function checkAutoSchedule(hours, minutes) {
    if (!autoMode) return; // หากผู้ใช้ปิดโหมด Auto จะไม่ปรับสถานะแอร์ทับ

    const totalMinutes = hours * 60 + minutes;
    let air1 = false;
    let air2 = false;
    let air3 = false;

    // ตารางเวลาทำงานสลับเครื่องปรับอากาศ (08:00 - 16:00 น.)
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
    // หลัง 16:00 น. แอร์ทั้ง 3 เครื่องจะดับทั้งหมด

    let isChanged = false;
    if (relayStates[0] !== air1) { relayStates[0] = air1; isChanged = true; }
    if (relayStates[1] !== air2) { relayStates[1] = air2; isChanged = true; }
    if (relayStates[2] !== air3) { relayStates[2] = air3; isChanged = true; }

    if (isChanged) {
        console.log(`[Auto Schedule] สลับสถานะ: Air1=${air1}, Air2=${air2}, Air3=${air3}`);
        broadcastState();
    }
}

// -------------------------------------------------------------------------
// ลูปหลักบน Server ทำงานทุกๆ 1 วินาที (Master Heartbeat & Counter)
// -------------------------------------------------------------------------
setInterval(() => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // เวลาไทย (UTC+7)

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const dateStr = `${thTime.getFullYear()}-${thTime.getMonth() + 1}-${thTime.getDate()}`;

    // 1. เงื่อนไขเวลา 07:45 น. บังคับเข้าโหมด Auto ประจำวันเสมอ
    if (hours === 7 && minutes === 45 && lastAutoResetDate !== dateStr) {
        lastAutoResetDate = dateStr;
        if (!autoMode) {
            autoMode = true;
            console.log(`[Auto Schedule] ⏰ เวลา 07:45 น. (${dateStr}): เข้าสู่โหมดอัตโนมัติประจำวัน`);
            broadcastState();
        }
    }

    // 2. เงื่อนไขเวลา 07:50 น. รีเซ็ตเวลานับสะสมและพลังงานเป็น 0 อัตโนมัติ
    if (hours === 7 && minutes === 50 && lastDailyResetDate !== dateStr) {
        lastDailyResetDate = dateStr;
        deviceTotalSeconds = [0, 0, 0, 0];
        console.log(`[Daily Reset] 🔄 เวลา 07:50 น. (${dateStr}): รีเซ็ตเวลาและพลังงานสะสมเป็น 0`);
        broadcastState();
    }

    // 3. ตรวจสอบตารางการทำงานแอร์
    checkAutoSchedule(hours, minutes);

    // 4. บันทึกวินาทีสะสมเฉพาะช่วงเวลา 08:00 - 16:00 น. (และแอร์กำลังต่อวงจรทำงานจริง)
    const isWorkingHours = totalMinutes >= 480 && totalMinutes < 960;
    let secondsChanged = false;

    if (isWorkingHours) {
        for (let i = 0; i < 4; i++) {
            if (relayStates[i] === true) {
                deviceTotalSeconds[i] += 1;
                secondsChanged = true;
            }
        }
    }

    // ถ้ามีการนับเวลาเพิ่มขึ้น ให้ Broadcast อัปเดตไปยังหน้าเว็บทุกเครื่องแบบเรียลไทม์
    if (secondsChanged) {
        broadcastState();
    }
}, 1000);

// -------------------------------------------------------------------------
// WebSocket Event Handlers
// -------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
    console.log(`[WS] Client เชื่อมต่อ: ${req.socket.remoteAddress}`);

    // ส่งสถานะปัจจุบันและเวลากลางล่าสุดให้ Client ทันทีที่เชื่อมต่อ
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'GET_STATE') {
                ws.send(JSON.stringify({
                    type: 'INIT_STATE',
                    relays: relayStates,
                    autoMode: autoMode,
                    deviceTotalSeconds: deviceTotalSeconds
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
                console.log(`[Auto Schedule] ผู้ใช้สลับโหมด Auto: ${autoMode ? 'เปิด' : 'ปิด'}`);
                if (autoMode) {
                    const now = new Date();
                    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                    const thTime = new Date(utc + (3600000 * 7));
                    checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
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
            console.error('[WS] ข้อความ JSON ผิดพลาด:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client ตัดการเชื่อมต่อ');
    });

    ws.on('error', (error) => {
        console.error('[WS] เกิดข้อผิดพลาด:', error.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
    console.log(`🌐 Web URL: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Endpoint: ws://localhost:${PORT}/esp`);
});

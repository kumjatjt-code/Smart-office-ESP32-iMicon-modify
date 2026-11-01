const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// สร้าง Express App และ HTTP Server
const app = express();
const server = http.createServer(app);

// สร้าง WebSocket Server ที่ Path '/esp' ให้ตรงกับ ESP32 และ Web Dashboard
const wss = new WebSocket.Server({ server, path: '/esp' });

// ตัวแปรเก็บสถานะ Relay ทั้ง 4 ช่อง [Air1, Air2, Air3, Motor/Other]
let relayStates = [false, false, false, false];
let autoMode = true; // เปิดใช้งานโหมด Auto Schedule เป็นค่าเริ่มต้น

// ให้บริการไฟล์ Static (เช่น index.html) จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------------
// ฟังก์ชันกระจายสถานะ (Broadcast) ไปยังทุก Client (ESP32 และ Web Dashboard)
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
    if (!autoMode) return; // หากปิดโหมด Auto จะไม่คำนวณทับการควบคุมแบบ Manual

    // แปลงเวลาเซิร์ฟเวอร์เป็นเวลาประเทศไทย (UTC+7) ป้องกันปัญหาเวลาบน Cloud (Render เป็น UTC)
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7));

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes; // แปลงเวลาเป็นจำนวนนาทีนับจาก 00:00 น.

    let air1 = false;
    let air2 = false;
    let air3 = false;

    // เงื่อนไขตารางเวลาทำงานสลับแอร์ (08:00 - 16:00 น.)
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
    // นอกช่วง 08:00 - 16:00 น. แอร์ทั้ง 3 ตัวจะดับทั้งหมด (false)

    // ตรวจสอบว่าสถานะแอร์ (ช่อง 0, 1, 2) เปลี่ยนไปจากเดิมหรือไม่
    let isChanged = false;
    if (relayStates[0] !== air1) { relayStates[0] = air1; isChanged = true; }
    if (relayStates[1] !== air2) { relayStates[1] = air2; isChanged = true; }
    if (relayStates[2] !== air3) { relayStates[2] = air3; isChanged = true; }

    // กระจายสถานะเมื่อมีการเปลี่ยนแปลงเท่านั้น เพื่อไม่ให้ส่งคำสั่งถี่เกินความจำเป็น
    if (isChanged) {
        console.log(`[Auto Schedule] ปรับสถานะตามเวลา: Air1=${air1}, Air2=${air2}, Air3=${air3}`);
        broadcastState();
    }
}

// ตรวจสอบตารางเวลาอัตโนมัติทุกๆ 10 วินาที
setInterval(checkAutoSchedule, 10000);

// -------------------------------------------------------------------------
// WebSocket Server Events
// -------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
    console.log(`[WS] Client เชื่อมต่อเข้ามา: ${req.socket.remoteAddress}`);

    // ส่งสถานะปัจจุบันและโหมด Auto ทันทีที่ Client เชื่อมต่อ
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[WS] ได้รับคำสั่ง:', data);

            // 1. Client ขอทราบสถานะล่าสุด
            if (data.type === 'GET_STATE') {
                ws.send(JSON.stringify({
                    type: 'INIT_STATE',
                    relays: relayStates,
                    autoMode: autoMode
                }));
            }

            // 2. สั่งเปิด-ปิดรายช่อง (Manual Control)
            else if (data.type === 'CONTROL') {
                const { ch, state } = data;
                if (ch >= 0 && ch < 4) {
                    relayStates[ch] = state;
                    broadcastState();
                }
            }

            // 3. สั่งเปิด-ปิดทั้งหมด
            else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = data.state;
                }
                broadcastState();
            }

            // 4. สลับโหมดการทำงาน Auto / Manual
            else if (data.type === 'TOGGLE_AUTO') {
                autoMode = data.state;
                console.log(`[WS] สลับโหมด Auto Schedule: ${autoMode ? 'เปิด' : 'ปิด'}`);
                if (autoMode) {
                    checkAutoSchedule(); // คำนวณเวลาทันทีที่เปิดโหมด
                }
                broadcastState();
            }

            // 5. ESP32 ส่งสถานะจริงกลับมารายงาน (Two-way Sync)
            else if (data.type === 'STATE_UPDATE' && Array.isArray(data.relays)) {
                if (data.relays.length === 4) {
                    relayStates = data.relays;
                    broadcastState();
                }
            }

        } catch (err) {
            console.error('[WS] ข้อความ JSON ไม่ถูกต้อง:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client ตัดการเชื่อมต่อ');
    });

    ws.on('error', (error) => {
        console.error('[WS] เกิดข้อผิดพลาด:', error);
    });
});

// เริ่มต้นการทำงานของ HTTP & WebSocket Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
    console.log(`🌐 Web URL: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Endpoint: ws://localhost:${PORT}/esp`);
    
    // เรียกคำนวณสถานะเวลาอัตโนมัติรอบแรกทันทีตอนเปิดเซิร์ฟเวอร์
    checkAutoSchedule();
});

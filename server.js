const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

// สถานะ Relay ทั้ง 4 ช่อง [Air1, Air2, Air3, Relay4]
let relayStates = [false, false, false, false];
let autoMode = true; // โหมดทำงานอัตโนมัติตามเวลา

// ตัวแปรเก็บเวลานับสะสม (วินาที) ส่วนกลางบน Server
let deviceTotalSeconds = [0, 0, 0, 0];
let lastAutoResetDate = '';  // ตรวจสอบเปิดโหมด Auto 07:45 น.
let lastDailyResetDate = ''; // ตรวจสอบรีเซ็ตค่าเป็น 0 ตอน 07:50 น.

// ตัวแปรระบุสถานะฮาร์ดแวร์ ESP32 ตัวจริง
let isHardwareOnline = false;
let espClientSocket = null; // เก็บ Reference ของ Socket ปัจจุบันที่ ESP32 ใช้งานอยู่

// ให้บริการหน้าเว็บจากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------------------
// ฟังก์ชันส่งกระจายข้อมูลสถานะ (Broadcast) ให้ทุกหน้าจอและอุปกรณ์
// -------------------------------------------------------------------------
function broadcastState() {
    const payload = JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds,
        hardwareOnline: isHardwareOnline
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// -------------------------------------------------------------------------
// ฟังก์ชันคำนวณตารางเวลาสลับแอร์ (08:00 - 16:00 น.)
// -------------------------------------------------------------------------
function checkAutoSchedule(hours, minutes) {
    if (!autoMode) return;

    // หากบอร์ด ESP32 ไม่ได้เชื่อมต่ออยู่จริง จะไม่อนุญาตให้เปิดแอร์
    if (!isHardwareOnline) {
        const wasOn = relayStates.some(state => state === true);
        if (wasOn) {
            relayStates = [false, false, false, false];
            broadcastState();
        }
        return;
    }

    const totalMinutes = hours * 60 + minutes;
    let air1 = false;
    let air2 = false;
    let air3 = false;

    // ตารางเวลาทำงานสลับแอร์ 08:00 - 16:00 น.
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
        console.log(`[Auto Schedule] สลับสถานะ: Air1=${air1}, Air2=${air2}, Air3=${air3}`);
        broadcastState();
    }
}

// -------------------------------------------------------------------------
// Master Loop บน Server ทำงานทุก 1 วินาที
// -------------------------------------------------------------------------
setInterval(() => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // เวลาประเทศไทย (UTC+7)

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const dateStr = `${thTime.getFullYear()}-${thTime.getMonth() + 1}-${thTime.getDate()}`;

    // 1. เวลา 07:45 น. บังคับเปิดโหมด Auto อัตโนมัติทุกวัน
    if (hours === 7 && minutes === 45 && lastAutoResetDate !== dateStr) {
        lastAutoResetDate = dateStr;
        if (!autoMode) {
            autoMode = true;
            console.log(`[Auto Schedule] ⏰ 07:45 น. (${dateStr}): รีเซ็ตเปิดโหมด Auto ประจำวัน`);
            broadcastState();
        }
    }

    // 2. เวลา 07:50 น. รีเซ็ตเวลานับสะสมและพลังงานเป็น 0
    if (hours === 7 && minutes === 50 && lastDailyResetDate !== dateStr) {
        lastDailyResetDate = dateStr;
        deviceTotalSeconds = [0, 0, 0, 0];
        console.log(`[Daily Reset] 🔄 07:50 น. (${dateStr}): ล้างค่าวินาทีและพลังงานเป็น 0`);
        broadcastState();
    }

    // 3. ตรวจสอบตารางการสลับแอร์
    checkAutoSchedule(hours, minutes);

    // 4. บันทึกเวลานับสะสม:
    // ต้องอยู่ในช่วง 08:00 - 16:00 น. AND ฮาร์ดแวร์ ESP32 ออนไลน์จริง AND รีเลย์ช่องนั้น ON จริง
    const isWorkingHours = totalMinutes >= 480 && totalMinutes < 960;
    let secondsChanged = false;

    if (isWorkingHours && isHardwareOnline) {
        for (let i = 0; i < 4; i++) {
            if (relayStates[i] === true) {
                deviceTotalSeconds[i] += 1;
                secondsChanged = true;
            }
        }
    }

    if (secondsChanged) {
        broadcastState();
    }
}, 1000);

// -------------------------------------------------------------------------
// WebSocket Server Handlers
// -------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
    // ส่งสถานะปัจจุบันให้ Client ทันทีที่เชื่อมต่อ
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds,
        hardwareOnline: isHardwareOnline
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // เมื่อบอร์ด ESP32 ส่งคำสั่งยืนยันตัวตน หรือรายงานสถานะรีเลย์
            if (data.type === 'ESP_CONNECT' || data.type === 'STATE_UPDATE') {
                espClientSocket = ws; // บันทึก Socket ตัวล่าสุดว่าเป็น ESP32 จริง
                isHardwareOnline = true;
                console.log(`[WS] 🟢 บอร์ด ESP32 ยืนยันตัวตนสำเร็จ (${data.type})`);

                if (Array.isArray(data.relays) && data.relays.length === 4) {
                    relayStates = data.relays;
                }

                // สั่งประมวลผลตารางเวลาตามเวลาปัจจุบันทันที
                const now = new Date();
                const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                const thTime = new Date(utc + (3600000 * 7));
                checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                broadcastState();
                return;
            }

            // ตอบกลับสัญญาณ PING ระดับ Application จาก ESP32
            if (data.type === 'PING') {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'PONG' }));
                }
                return;
            }

            if (data.type === 'GET_STATE') {
                ws.send(JSON.stringify({
                    type: 'INIT_STATE',
                    relays: relayStates,
                    autoMode: autoMode,
                    deviceTotalSeconds: deviceTotalSeconds,
                    hardwareOnline: isHardwareOnline
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
                console.log(`[Auto Schedule] สลับโหมด Auto: ${autoMode ? 'เปิด' : 'ปิด'}`);
                if (autoMode) {
                    const now = new Date();
                    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                    const thTime = new Date(utc + (3600000 * 7));
                    checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                }
                broadcastState();
            }
        } catch (err) {
            console.error('[WS] JSON Parse Error:', err.message);
        }
    });

    // ---------------------------------------------------------------------
    // จุดแก้ไขสำคัญ: ป้องกัน Socket เก่ามาตัดสถานะบอร์ดปัจจุบัน
    // ---------------------------------------------------------------------
    ws.on('close', () => {
        // ตรวจสอบอย่างเจาะจงว่า socket ที่ปิดตัวลงนี้คือ espClientSocket ตัวปัจจุบันจริงหรือไม่
        if (ws === espClientSocket) {
            espClientSocket = null;
            isHardwareOnline = false;
            console.log('[WS] 🔴 บอร์ด ESP32 ขาดการเชื่อมต่อจริง (ถอดปลั๊กหรือออฟไลน์)');

            // ปรับสถานะรีเลย์จำลองเป็นปิดทั้งหมด และหยุดการนับพลังงาน
            relayStates = [false, false, false, false];
            broadcastState();
        } else {
            console.log('[WS] 📱 หน้าเว็บ Dashboard หรือ Session เก่าถูกปิดการเชื่อมต่อ');
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
    console.log(`🌐 Web URL: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Endpoint: ws://localhost:${PORT}/esp`);
});

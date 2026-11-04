const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

// -------------------------------------------------------------------------
// สถานะหลัก (Server คือ Single Source of Truth)
// -------------------------------------------------------------------------
let relayStates = [false, false, false, false]; // [Air1, Air2, Air3, Relay4]
let autoMode = true;
let deviceTotalSeconds = [0, 0, 0, 0];
let lastAutoResetDate = '';
let lastDailyResetDate = '';

let isHardwareOnline = false;
let espClientSocket = null;
let offlineTimer = null;
let lastRelaysSentToEsp = '';

const OFFLINE_GRACE_MS = 20000;  // ผ่อนผัน 20 วินาทีก่อนประกาศว่า ESP32 ออฟไลน์
const HEARTBEAT_MS = 30000;      // Ping ตรวจจับ Socket ค้างทุก 30 วินาที

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------
function getThaiTime() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + 3600000 * 7); // UTC+7
}

// Payload สำหรับหน้าเว็บ: หาก ESP32 ออฟไลน์จะแสดงสถานะรีเลย์เป็น OFF ทั้งหมด
function webPayload() {
    return JSON.stringify({
        type: 'INIT_STATE',
        relays: isHardwareOnline ? relayStates : [false, false, false, false],
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds,
        hardwareOnline: isHardwareOnline
    });
}

// ส่งสถานะให้เฉพาะหน้าเว็บ Dashboard (ไม่ส่งกวน ESP32)
function broadcastState() {
    const payload = webPayload();
    wss.clients.forEach((client) => {
        if (client !== espClientSocket && client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// ส่งคำสั่งรีเลย์ให้ ESP32 เฉพาะตอนที่สถานะเปลี่ยนจริง (แพ็กเก็ตเล็ก)
function syncRelaysToEsp(force = false) {
    if (!espClientSocket || espClientSocket.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ type: 'RELAYS', relays: relayStates });
    if (!force && msg === lastRelaysSentToEsp) return;
    lastRelaysSentToEsp = msg;
    espClientSocket.send(msg);
}

// -------------------------------------------------------------------------
// ตารางเวลาสลับแอร์ (08:00 - 16:00 น.)
// -------------------------------------------------------------------------
function checkAutoSchedule(hours, minutes) {
    if (!autoMode) return;

    const totalMinutes = hours * 60 + minutes;
    const isWorkingHours = totalMinutes >= 480 && totalMinutes < 960; // 08:00 - 16:00 น.

    // นอกเวลาทำงาน: สั่งปิดแอร์ทั้งหมด
    if (!isWorkingHours) {
        let changed = false;
        for (let i = 0; i < 3; i++) {
            if (relayStates[i] !== false) {
                relayStates[i] = false;
                changed = true;
            }
        }
        if (changed) {
            syncRelaysToEsp();
            broadcastState();
        }
        return;
    }

    let air1 = false;
    let air2 = false;
    let air3 = false;

    // ตารางเวลาทำงานสลับแอร์ทั้ง 3 เครื่องตาม Timing Diagram
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
        syncRelaysToEsp();
        broadcastState();
    }
}

// -------------------------------------------------------------------------
// Master Loop ทุก 1 วินาที
// -------------------------------------------------------------------------
setInterval(() => {
    const thTime = getThaiTime();
    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const dateStr = `${thTime.getFullYear()}-${thTime.getMonth() + 1}-${thTime.getDate()}`;

    // 07:45 น. บังคับเปิดโหมด Auto
    if (hours === 7 && minutes === 45 && lastAutoResetDate !== dateStr) {
        lastAutoResetDate = dateStr;
        if (!autoMode) {
            autoMode = true;
            console.log(`[Auto Schedule] ⏰ 07:45 น. (${dateStr}): เปิดโหมด Auto ประจำวัน`);
            broadcastState();
        }
    }

    // 07:50 น. รีเซ็ตเวลานับสะสม
    if (hours === 7 && minutes === 50 && lastDailyResetDate !== dateStr) {
        lastDailyResetDate = dateStr;
        deviceTotalSeconds = [0, 0, 0, 0];
        console.log(`[Daily Reset] 🔄 07:50 น. (${dateStr}): ล้างค่าวินาทีและพลังงานเป็น 0`);
        broadcastState();
    }

    checkAutoSchedule(hours, minutes);

    // นับเวลาเฉพาะช่วงทำงาน (08:00 - 16:00 น.) + ESP32 ออนไลน์ + รีเลย์ ON
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
// Heartbeat: ตรวจจับและตัด Socket ค้างทุก 30 วินาที
// -------------------------------------------------------------------------
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[WS] ⏱️ ไม่มีการตอบสนอง ตัด Socket ทิ้ง');
            return ws.terminate();
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) { /* ignore */ }
    });
}, HEARTBEAT_MS);

// -------------------------------------------------------------------------
// WebSocket Server Handlers
// -------------------------------------------------------------------------
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        ws.isAlive = true;
        try {
            const data = JSON.parse(message);

            // เมื่อ ESP32 ยืนยันตัวตน
            if (data.type === 'ESP_CONNECT') {
                const old = espClientSocket;
                espClientSocket = ws;
                if (old && old !== ws) old.terminate(); // ตัด socket เก่าทิ้ง

                if (offlineTimer) {
                    clearTimeout(offlineTimer);
                    offlineTimer = null;
                }
                isHardwareOnline = true;
                lastRelaysSentToEsp = '';
                console.log('[WS] 🟢 บอร์ด ESP32 ยืนยันตัวตนสำเร็จ');

                const thTime = getThaiTime();
                checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                syncRelaysToEsp(true); // ซิงค์สถานะที่ต้องการให้ ESP32 ทำตามทันที
                broadcastState();
                return;
            }

            // ESP32 รายงานสถานะ (Server เป็น Source of Truth จึงไม่รับค่ามาทับ)
            if (data.type === 'STATE_UPDATE') {
                return;
            }

            // ตอบกลับสัญญาณ Application PING
            if (data.type === 'PING') {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'PONG' }));
                }
                return;
            }

            // คำสั่งจาก Dashboard
            if (data.type === 'GET_STATE') {
                ws.send(webPayload());
            }
            else if (data.type === 'CONTROL') {
                const ch = Number(data.ch);
                if (Number.isInteger(ch) && ch >= 0 && ch < 4) {
                    relayStates[ch] = Boolean(data.state);
                    syncRelaysToEsp();
                    broadcastState();
                }
            }
            else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = Boolean(data.state);
                }
                syncRelaysToEsp();
                broadcastState();
            }
            else if (data.type === 'TOGGLE_AUTO') {
                autoMode = Boolean(data.state);
                console.log(`[Auto Schedule] สลับโหมด Auto: ${autoMode ? 'เปิด' : 'ปิด'}`);
                if (autoMode) {
                    const thTime = getThaiTime();
                    checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                }
                broadcastState();
            }
        } catch (err) {
            console.error('[WS] JSON Parse Error:', err.message);
        }
    });

    ws.on('close', () => {
        if (ws === espClientSocket) {
            espClientSocket = null;
            console.log(`[WS] 🟠 ESP32 หลุด รอ ${OFFLINE_GRACE_MS / 1000} วินาทีก่อนประกาศออฟไลน์`);

            // หน่วงเวลาผ่อนผันก่อนประกาศออฟไลน์ ป้องกันการรีเซ็ตรีเลย์ตอนสัญญาณสะดุด
            if (offlineTimer) clearTimeout(offlineTimer);
            offlineTimer = setTimeout(() => {
                offlineTimer = null;
                if (!espClientSocket) {
                    isHardwareOnline = false;
                    console.log('[WS] 🔴 ESP32 ออฟไลน์จริง');
                    broadcastState();
                }
            }, OFFLINE_GRACE_MS);
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
    console.log(`🔌 WebSocket Endpoint: /esp`);
});

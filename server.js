const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

// สถานะ Relay ทั้ง 4 ช่อง [Air1, Air2, Air3, Relay4]
let relayStates = [false, false, false, false];
let autoMode = true;

// ตัวแปรเวลานับสะสม (วินาที) ประจำวัน
let deviceTotalSeconds = [0, 0, 0, 0];
let lastAutoResetDate = '';
let lastDailyResetDate = '';

// การเชื่อมต่อฮาร์ดแวร์ทั้ง 2 บอร์ด
let isHardwareOnline = false; // บอร์ดที่ 1 (Relay)
let espRelaySocket = null;

let isSolarOnline = false;    // บอร์ดที่ 2 (Solar Sensor)
let espSolarSocket = null;

// ตรรกะ Solar Cell สำหรับ Air 3 (53,000 BTU)
let solarCurrent = 0.0;
let solarThreshold = 15.0;         // เกณฑ์สั่งเปิด (แอมป์)
const SOLAR_HYSTERESIS_OFF = 10.0; // เกณฑ์สั่งปิด (แอมป์)

let solarAboveCounter = 0;
let solarBelowCounter = 0;
let air3MinRunTimer = 0;           // หน่วงเวลาเปิดขั้นต่ำ 10 นาที (ป้องกันเมฆบัง)
let air3MinOffTimer = 0;           // หน่วงเวลาห้ามเปิดซ้ำ 3 นาที (ถนอมคอมเพรสเซอร์)

app.use(express.static(path.join(__dirname, 'public')));

// ฟังก์ชันส่งกระจายข้อมูลสถานะไปยังทุกอุปกรณ์
function broadcastState() {
    const payload = JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds,
        hardwareOnline: isHardwareOnline,
        solarOnline: isSolarOnline,
        solarCurrent: solarCurrent,
        solarThreshold: solarThreshold
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

// คำนวณตารางเวลาสลับแอร์และเงื่อนไข Solar
function checkAutoSchedule(hours, minutes) {
    if (!autoMode) return;

    if (!isHardwareOnline) {
        const wasOn = relayStates.some(state => state === true);
        if (wasOn) {
            relayStates = [false, false, false, false];
            broadcastState();
        }
        return;
    }

    const totalMinutes = hours * 60 + minutes;
    const isWorkingHours = totalMinutes >= 480 && totalMinutes < 960; // 08:00 - 16:00 น.

    if (!isWorkingHours) {
        let changed = false;
        for (let i = 0; i < 3; i++) {
            if (relayStates[i] !== false) {
                relayStates[i] = false;
                changed = true;
            }
        }
        if (changed) broadcastState();
        return;
    }

    // 1. ตารางสลับ Air 1 และ Air 2
    let air1 = false;
    let air2 = false;

    if (totalMinutes >= 480 && totalMinutes < 510) {          // 08:00 - 08:30
        air1 = true;
    } else if (totalMinutes >= 510 && totalMinutes < 540) {   // 08:30 - 09:00
        air2 = true;
    } else if (totalMinutes >= 540 && totalMinutes < 570) {   // 09:00 - 09:30
        air1 = true;
    } else if (totalMinutes >= 570 && totalMinutes < 600) {   // 09:30 - 10:00
        air2 = true;
    } else if (totalMinutes >= 600 && totalMinutes < 630) {   // 10:00 - 10:30
        air1 = true;
    } else if (totalMinutes >= 630 && totalMinutes < 660) {   // 10:30 - 11:00 [Air1, Air2]
        air1 = true; air2 = true;
    } else if (totalMinutes >= 660 && totalMinutes < 720) {   // 11:00 - 12:00
        air1 = true; air2 = true;
    } else if (totalMinutes >= 720 && totalMinutes < 840) {   // 12:00 - 14:00
        air2 = true;
    } else if (totalMinutes >= 840 && totalMinutes < 870) {   // 14:00 - 14:30 [Air1, Air2]
        air1 = true; air2 = true;
    } else if (totalMinutes >= 870 && totalMinutes < 930) {   // 14:30 - 15:30
        air2 = true;
    } else if (totalMinutes >= 930 && totalMinutes < 960) {   // 15:30 - 16:00
        air1 = true;
    }

    // 2. ควบคุม Air 3 ตามกระแส Solar
    let air3 = relayStates[2];

    if (isSolarOnline && solarAboveCounter >= 45 && !air3 && air3MinOffTimer === 0) {
        air3 = true;
        air3MinRunTimer = 600; // ล็อกให้แอร์ทำงานอย่างน้อย 10 นาที
        console.log(`[Solar] ☀️ กระแสโซลาร์ถึงเกณฑ์ (${solarCurrent} A) สั่งเปิด Air 3`);
    } else if (air3 && (solarBelowCounter >= 120 || !isSolarOnline) && air3MinRunTimer === 0) {
        air3 = false;
        air3MinOffTimer = 180; // พักคอมเพรสเซอร์อย่างน้อย 3 นาที
        console.log(`[Solar] ☁️ กระแสโซลาร์ไม่พอ (${solarCurrent} A) สั่งปิด Air 3`);
    }

    let isChanged = false;
    if (relayStates[0] !== air1) { relayStates[0] = air1; isChanged = true; }
    if (relayStates[1] !== air2) { relayStates[1] = air2; isChanged = true; }
    if (relayStates[2] !== air3) { relayStates[2] = air3; isChanged = true; }

    if (isChanged) {
        console.log(`[Schedule] สลับสถานะ: Air1=${air1}, Air2=${air2}, Air3=${air3}`);
        broadcastState();
    }
}

// Master Loop ทุก 1 วินาที
setInterval(() => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7)); // UTC+7

    const hours = thTime.getHours();
    const minutes = thTime.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    const dateStr = `${thTime.getFullYear()}-${thTime.getMonth() + 1}-${thTime.getDate()}`;

    if (air3MinRunTimer > 0) air3MinRunTimer--;
    if (air3MinOffTimer > 0) air3MinOffTimer--;

    // ตรวจจับแดดสะสม
    if (isSolarOnline && solarCurrent >= solarThreshold) {
        solarAboveCounter++;
        solarBelowCounter = 0;
    } else if (isSolarOnline && solarCurrent < SOLAR_HYSTERESIS_OFF) {
        solarBelowCounter++;
        solarAboveCounter = 0;
    } else {
        solarAboveCounter = 0;
    }

    // 07:45 น. บังคับเปิด Auto
    if (hours === 7 && minutes === 45 && lastAutoResetDate !== dateStr) {
        lastAutoResetDate = dateStr;
        if (!autoMode) {
            autoMode = true;
            console.log(`[Auto Schedule] ⏰ 07:45 น. (${dateStr}): รีเซ็ตเปิดโหมด Auto`);
            broadcastState();
        }
    }

    // 07:50 น. รีเซ็ตเวลาและพลังงานเป็น 0
    if (hours === 7 && minutes === 50 && lastDailyResetDate !== dateStr) {
        lastDailyResetDate = dateStr;
        deviceTotalSeconds = [0, 0, 0, 0];
        console.log(`[Daily Reset] 🔄 07:50 น. (${dateStr}): ล้างค่าวินาทีและพลังงานเป็น 0`);
        broadcastState();
    }

    checkAutoSchedule(hours, minutes);

    // บันทึกเวลาสะสม
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

    if (secondsChanged) broadcastState();
}, 1000);

// WebSocket Handlers
wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({
        type: 'INIT_STATE',
        relays: relayStates,
        autoMode: autoMode,
        deviceTotalSeconds: deviceTotalSeconds,
        hardwareOnline: isHardwareOnline,
        solarOnline: isSolarOnline,
        solarCurrent: solarCurrent,
        solarThreshold: solarThreshold
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // บอร์ดที่ 1 (Relay Board)
            if (data.type === 'ESP_CONNECT' || data.type === 'STATE_UPDATE') {
                espRelaySocket = ws;
                isHardwareOnline = true;
                console.log(`[WS] 🟢 บอร์ดที่ 1 (Relay) ออนไลน์ (${data.type})`);

                if (Array.isArray(data.relays) && data.relays.length === 4) {
                    relayStates = data.relays;
                }

                const now = new Date();
                const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                const thTime = new Date(utc + (3600000 * 7));
                checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                broadcastState();
                return;
            }

            // บอร์ดที่ 2 (Solar Sensor)
            if (data.type === 'SOLAR_BOARD_CONNECT') {
                espSolarSocket = ws;
                isSolarOnline = true;
                console.log(`[WS] ☀️ บอร์ดที่ 2 (Solar) ออนไลน์`);
                broadcastState();
                return;
            }

            if (data.type === 'SOLAR_DATA') {
                espSolarSocket = ws;
                isSolarOnline = true;
                if (typeof data.current === 'number') {
                    solarCurrent = data.current;
                }
                broadcastState();
                return;
            }

            // สัญญาณเลี้ยงสาย
            if (data.type === 'PING') {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'PONG' }));
                }
                return;
            }

            // สั่งการจาก Dashboard
            if (data.type === 'GET_STATE') {
                broadcastState();
            } else if (data.type === 'CONTROL') {
                const { ch, state } = data;
                if (ch >= 0 && ch < 4) {
                    relayStates[ch] = state;
                    broadcastState();
                }
            } else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = data.state;
                }
                broadcastState();
            } else if (data.type === 'TOGGLE_AUTO') {
                autoMode = Boolean(data.state);
                console.log(`[Auto Schedule] สลับโหมด Auto: ${autoMode ? 'เปิด' : 'ปิด'}`);
                if (autoMode) {
                    const now = new Date();
                    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
                    const thTime = new Date(utc + (3600000 * 7));
                    checkAutoSchedule(thTime.getHours(), thTime.getMinutes());
                }
                broadcastState();
            } else if (data.type === 'SET_SOLAR_THRESHOLD') {
                if (typeof data.threshold === 'number' && data.threshold > 0) {
                    solarThreshold = data.threshold;
                    console.log(`[Solar] เกณฑ์กระแสใหม่ Air 3: ${solarThreshold} A`);
                    broadcastState();
                }
            }
        } catch (err) {
            console.error('[WS] Parse Error:', err.message);
        }
    });

    ws.on('close', () => {
        if (ws === espRelaySocket) {
            espRelaySocket = null;
            isHardwareOnline = false;
            console.log('[WS] 🔴 บอร์ดที่ 1 (Relay) หลุดการเชื่อมต่อ');
            relayStates = [false, false, false, false];
            broadcastState();
        } else if (ws === espSolarSocket) {
            espSolarSocket = null;
            isSolarOnline = false;
            solarCurrent = 0.0;
            console.log('[WS] ☁️ บอร์ดที่ 2 (Solar) หลุดการเชื่อมต่อ');
            broadcastState();
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Smart Office Server กำลังทำงานที่พอร์ต ${PORT}`);
});

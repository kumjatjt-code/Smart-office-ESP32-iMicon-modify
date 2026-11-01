const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// สร้าง Express App และ HTTP Server
const app = express();
const server = http.createServer(app);

// สร้าง WebSocket Server ที่ Path '/esp' ให้ตรงกับฝั่ง ESP32 และหน้าเว็บ
const wss = new WebSocket.Server({ server, path: '/esp' });

// ตัวแปรเก็บสถานะของ Relay ทั้ง 4 ช่อง (ค่าเริ่มต้นคือ false/ปิด)
let relayStates = [false, false, false, false];

// ให้ Express ให้บริการไฟล์ Static (เช่น index.html) จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// ฟังก์ชันสำหรับกระจายสถานะล่าสุด (Broadcast) ไปยังทุก Client ที่เชื่อมต่ออยู่
function broadcastState() {
    const message = JSON.stringify({ relays: relayStates });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// เมื่อมี Client (ESP32 หรือ Web Dashboard) เข้ามาเชื่อมต่อ
wss.on('connection', (ws, req) => {
    console.log(`[WS] Client connected from: ${req.socket.remoteAddress}`);

    // รับข้อความจาก Client
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[WS] Received:', data);

            // 1. Client ขอทราบสถานะล่าสุด (ตอนเชื่อมต่อใหม่ๆ)
            if (data.type === 'GET_STATE') {
                ws.send(JSON.stringify({ relays: relayStates }));
            }
            
            // 2. หน้าเว็บสั่งควบคุมทีละช่อง
            else if (data.type === 'CONTROL') {
                if (data.ch >= 0 && data.ch < 4) {
                    relayStates[data.ch] = data.state;
                    broadcastState(); // กระจายอัปเดตให้ทุกคน (รวมถึง ESP32)
                }
            }
            
            // 3. หน้าเว็บสั่งเปิด-ปิดทั้งหมด
            else if (data.type === 'CONTROL_ALL') {
                for (let i = 0; i < 4; i++) {
                    relayStates[i] = data.state;
                }
                broadcastState(); // กระจายอัปเดตให้ทุกคน
            }
            
            // 4. ESP32 ส่งสถานะของจริงกลับมาอัปเดต (Two-way Sync)
            else if (data.type === 'STATE_UPDATE' && Array.isArray(data.relays)) {
                if (data.relays.length === 4) {
                    relayStates = data.relays;
                    broadcastState(); // กระจายให้หน้าเว็บแสดงผลตรงกับฮาร์ดแวร์จริง
                }
            }

        } catch (err) {
            console.error('[WS] Error parsing message:', err.message);
        }
    });

    // จัดการเมื่อ Client ตัดการเชื่อมต่อ
    ws.on('close', () => {
        console.log('[WS] Client disconnected');
    });

    // ป้องกันแอปแครชจาก Error ของ WebSocket
    ws.on('error', (error) => {
        console.error('[WS] Error:', error);
    });
});

// กำหนดพอร์ต (บน Render จะใช้ process.env.PORT อัตโนมัติ)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🌐 Web URL: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Endpoint: ws://localhost:${PORT}/esp`);
});

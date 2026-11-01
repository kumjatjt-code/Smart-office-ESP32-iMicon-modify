const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'state_data.json');

// สถานะเริ่มต้นของอุปกรณ์
let resortData = {
  villa1: {
    name: "บ้านพักพูลวิลล่า 1",
    relays: [false, false, false, false, false, false, false, false],
    deviceNames: [
      "ไฟห้องนอน", "แอร์ห้องนอน", "ไฟห้องน้ำ", "ไฟห้องครัว",
      "ไฟนั่งเล่น", "ไฟบันได", "เสาไฟสวน", "ไฟประดับสวน"
    ],
    timers: Array(8).fill(null).map(() => ({ onH: -1, onM: -1, offH: -1, offM: -1, enabled: false })),
    stats: {
      daily: Array(7).fill(0).map(() => Array(8).fill(0)),
      monthly: Array(12).fill(0).map(() => Array(8).fill(0)),
      yearly: Array(3).fill(0).map(() => Array(8).fill(0)),
      lastDay: new Date().getDate(),
      lastMonth: new Date().getMonth(),
      lastYear: new Date().getFullYear()
    }
  }
};

// โหลดข้อมูลเก่าจากไฟล์ถ้ามี
if (fs.existsSync(DB_FILE)) {
  try {
    resortData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error("Error reading database file:", e);
  }
}

function saveData() {
  fs.writeFile(DB_FILE, JSON.stringify(resortData, null, 2), err => {
    if (err) console.error("Error saving database:", err);
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API ดูสถานะปัจจุบัน
app.get('/api/status', (req, res) => {
  res.json(resortData.villa1);
});

// WebSocket Connection
let espClients = new Set();
let webClients = new Set();

wss.on('connection', (ws, req) => {
  const url = req.url;

  if (url === '/esp') {
    console.log('[ESP] บอร์ดเชื่อมต่อเข้ามาแล้ว');
    espClients.add(ws);

    // ส่งสถานะปัจจุบันไปให้ ESP
    ws.send(JSON.stringify({
      type: 'INIT_STATE',
      relays: resortData.villa1.relays
    }));

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'STATUS_UPDATE') {
          resortData.villa1.relays = data.relays;
          broadcastToWeb({ type: 'UPDATE', relays: data.relays });
          saveData();
        }
      } catch (err) {
        console.error("ESP Message parse error:", err);
      }
    });

    ws.on('close', () => {
      console.log('[ESP] บอร์ดหลุดการเชื่อมต่อ');
      espClients.delete(ws);
      broadcastToWeb({ type: 'ESP_STATUS', connected: false });
    });

  } else {
    webClients.add(ws);
    ws.send(JSON.stringify({
      type: 'FULL_DATA',
      data: resortData.villa1,
      espConnected: espClients.size > 0
    }));

    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        // สั่งเปิด-ปิดช่องเดี่ยว
        if (msg.type === 'SET_RELAY') {
          const { ch, state } = msg;
          if (ch >= 0 && ch < 8) {
            resortData.villa1.relays[ch] = state;
            broadcastToESP({ type: 'CONTROL', ch, state });
            broadcastToWeb({ type: 'UPDATE', relays: resortData.villa1.relays });
            saveData();
          }
        }

        // สั่งเปิด-ปิดทั้งหมด (Check-in / Check-out Mode)
        if (msg.type === 'SET_ALL') {
          const state = msg.state;
          for (let i = 0; i < 8; i++) resortData.villa1.relays[i] = state;
          broadcastToESP({ type: 'CONTROL_ALL', state });
          broadcastToWeb({ type: 'UPDATE', relays: resortData.villa1.relays });
          saveData();
        }

        // บันทึกเวลาเปิด-ปิดอัตโนมัติ
        if (msg.type === 'SET_TIMER') {
          const { ch, timer } = msg;
          resortData.villa1.timers[ch] = timer;
          saveData();
          broadcastToWeb({ type: 'TIMER_UPDATE', timers: resortData.villa1.timers });
        }
      } catch (err) {
        console.error("Web Client Message error:", err);
      }
    });

    ws.on('close', () => webClients.delete(ws));
  }
});

function broadcastToWeb(payload) {
  const json = JSON.stringify(payload);
  webClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

function broadcastToESP(payload) {
  const json = JSON.stringify(payload);
  espClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

// Timer & Usage Tracker Task
setInterval(() => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const currentSec = now.getSeconds();

  const v1 = resortData.villa1;

  for (let i = 0; i < 8; i++) {
    if (v1.relays[i]) {
      v1.stats.daily[0][i]++;
      v1.stats.monthly[0][i]++;
      v1.stats.yearly[0][i]++;
    }
  }

  if (currentSec === 0) {
    v1.timers.forEach((t, ch) => {
      if (t.enabled) {
        if (t.onH === currentHour && t.onM === currentMin && !v1.relays[ch]) {
          v1.relays[ch] = true;
          broadcastToESP({ type: 'CONTROL', ch, state: true });
          broadcastToWeb({ type: 'UPDATE', relays: v1.relays });
        }
        if (t.offH === currentHour && t.offM === currentMin && v1.relays[ch]) {
          v1.relays[ch] = false;
          broadcastToESP({ type: 'CONTROL', ch, state: false });
          broadcastToWeb({ type: 'UPDATE', relays: v1.relays });
        }
      }
    });

    if (currentMin % 5 === 0) saveData();
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`🚀 Smart Resort Server running at http://localhost:${PORT}`);
});

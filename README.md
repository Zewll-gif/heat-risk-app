# 🌡️ HeatGuard Chiang Mai — เว็บแผนที่ความเสี่ยง Heat Stroke

## โครงสร้างโฟลเดอร์
```
heat_risk_app/
├── app.py                  ← FastAPI backend หลัก
├── start.bat               ← ดับเบิลคลิกเพื่อเปิดเซิร์ฟเวอร์
├── requirements.txt        ← dependencies
├── .env                    ← ใส่ ANTHROPIC_API_KEY ที่นี่
├── config.json             ← จาก Colab export
├── model.keras             ← จาก Colab export
├── scaler.pkl              ← จาก Colab export
├── grid.geojson            ← จาก Colab export
├── population_summary.csv  ← จาก Colab export
├── rag_docs/
│   └── knowledge_base.md  ← ฐานความรู้ Heat Stroke
├── static/
│   ├── css/style.css
│   └── js/main.js
└── templates/
    └── index.html
```

## วิธีติดตั้ง

### ขั้นตอนที่ 1 — วางไฟล์จาก Colab
แตก `heat_risk_export.zip` แล้วคัดลอกไฟล์เหล่านี้มาไว้ในโฟลเดอร์นี้:
- `model.keras` (หรือ `model.h5`)
- `scaler.pkl`
- `config.json`
- `grid.geojson`
- `population_summary.csv`

### ขั้นตอนที่ 2 — ตั้งค่า API Key
เปิดไฟล์ `.env` แล้วแก้:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```
รับ API Key ได้ที่: https://console.anthropic.com

### ขั้นตอนที่ 3 — รันเซิร์ฟเวอร์
ดับเบิลคลิก `start.bat` แล้วรอสักครู่

### ขั้นตอนที่ 4 — เปิดเว็บ
ไปที่: http://localhost:8000

---

## ฟีเจอร์ทั้งหมด

| หน้า | ฟีเจอร์ |
|------|---------|
| 🗺️ แผนที่ | แผนที่ realtime 3 layer สลับดูได้ |
| 📊 พยากรณ์ | กราฟ 24h + ตารางรายตำบล realtime |
| 🎛️ จำลอง | ปรับอุณหภูมิ/ความชื้น/ลม แล้วดูแผนที่เปลี่ยน |
| 👤 ตรวจสอบตัวเอง | ถ่ายภาพประมาณอายุ + วิเคราะห์ความเสี่ยงด้วย AI |
| 💬 ถามผู้ช่วย AI | RAG chatbot ตอบจากฐานความรู้จริง |

---

## หมายเหตุ
- ถ้า DeepFace (ประมาณอายุจากภาพ) ติดตั้งนานหรือช้า ให้รอสักครู่
- API Key ต้องมี quota เพียงพอสำหรับ Claude API
- ข้อมูลอุณหภูมิดึงจาก Open-Meteo (ฟรี ไม่ต้อง key)

# 🌡️ HeatGuard Bangkok

เว็บแอปแสดงแผนที่ความเสี่ยง Heat Stroke รายเขตในกรุงเทพฯ แบบ realtime

🔗 **https://heat-risk-app-production.up.railway.app**

---

## โครงสร้างโฟลเดอร์

```
heat_risk_app/
├── app.py
├── requirements.txt
├── .env                    ← ใส่ ANTHROPIC_API_KEY (ห้าม commit)
├── config.json
├── model.keras
├── scaler.pkl
├── grid.geojson
├── population_summary.csv
├── rag_docs/
│   └── knowledge_base.md
├── static/
│   ├── css/style.css
│   └── js/main.js
└── templates/
    └── index.html
```

---

## รันในเครื่อง

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

แล้วเปิด http://localhost:8000

ต้องมีไฟล์ `.env` ที่มี:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

---

## Deploy

ใช้ Railway เชื่อมกับ GitHub repo นี้ไว้แล้ว push ครั้งไหนก็ deploy อัตโนมัติ

```bash
git add .
git commit -m "..."
git push
```

Environment variable `ANTHROPIC_API_KEY` ตั้งไว้ใน Railway Dashboard

---

## ฟีเจอร์

- **แผนที่** — แสดงระดับความเสี่ยงรายเขต พร้อม top 5 เขตเสี่ยงสูงสุด
- **พยากรณ์ 24h** — กราฟและตารางอุณหภูมิล่วงหน้า
- **จำลองสถานการณ์** — ปรับค่าอุณหภูมิ ความชื้น ลม แล้วดูผลบนแผนที่
- **ความเสี่ยงส่วนตัว** — วิเคราะห์ความเสี่ยงจากข้อมูลสุขภาพส่วนตัว
- **AI ผู้ช่วย** — ถาม-ตอบเรื่อง Heat Stroke

---

## ข้อมูล

- อุณหภูมิ/สภาพอากาศ: [Open-Meteo](https://open-meteo.com)
- แผนที่: Mapbox
HeatGuard Bangkok
Real-time Heat Stroke Risk Map for Bangkok Districts

เว็บแอปพลิเคชันสำหรับตรวจสอบความเสี่ยงฮีทสโตรกรายเขตในกรุงเทพมหานครแบบเรียลไทม์ โดยคำนวณจากข้อมูลสภาพอากาศจริงร่วมกับโมเดลวิเคราะห์ความเสี่ยงรายบุคคล

Live Demo: heat-risk-app-production.up.railway.app

Project Structure
โปรเจกต์นี้พัฒนาด้วย FastAPI และใช้ Mapbox สำหรับการแสดงผลแผนที่

Plaintext
heat_risk_app/
├── app.py                # Main backend logic (FastAPI)
├── requirements.txt      # Dependencies
├── .env                  # API Keys (Local only)
├── config.json           # App configurations
├── model.keras           # AI Model สำหรับทำนายความเสี่ยง
├── scaler.pkl            # Data scaling
├── grid.geojson          # ขอบเขตรายเขตของ กทม.
├── population_summary.csv # ข้อมูลประชากรพื้นฐาน
├── rag_docs/             # Knowledge base สำหรับ AI Chatbot
│   └── knowledge_base.md
├── static/               # Assets (CSS/JS)
└── templates/            # HTML Templates
Getting Started
1. การติดตั้งและรันในเครื่อง (Local)
คัดลอกไฟล์ .env.example เป็น .env และระบุ API Key:

ข้อมูลโค้ด
ANTHROPIC_API_KEY=your_key_here
รันคำสั่งเพื่อติดตั้งและเริ่มใช้งาน:

Bash
pip install -r requirements.txt
uvicorn app:app --reload
เข้าใช้งานผ่านเบราว์เซอร์ที่: http://localhost:8000

2. การ Deployment
โปรเจกต์นี้รองรับ CI/CD ผ่าน Railway เมื่อทำการ Push code ขึ้น GitHub ระบบจะดำเนินการ Deploy โดยอัตโนมัติ:

Bash
git add .
git commit -m "Update"
git push origin main
หมายเหตุ: ตรวจสอบการตั้งค่า ANTHROPIC_API_KEY ใน Railway Dashboard

Key Features
Live Risk Map: แสดงระดับความเสี่ยงแยกตามเขต พร้อมอันดับ Top 5 เขตเฝ้าระวัง

24h Forecast: แสดงกราฟพยากรณ์อุณหภูมิและความเสี่ยงล่วงหน้า 24 ชั่วโมง

Simulator: ระบบจำลองสถานการณ์โดยปรับค่าอุณหภูมิ ความชื้น และความเร็วลม

Personal Risk: วิเคราะห์ความเสี่ยงเฉพาะบุคคลตามข้อมูลสุขภาพ

AI Assistant: ระบบตอบคำถามเกี่ยวกับการป้องกันฮีทสโตรก (Powered by Claude)

Data Sources
Weather Data: Open-Meteo API

Map Engine: Mapbox GL JS

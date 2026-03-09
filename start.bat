@echo off
echo ==========================================
echo  HeatGuard Chiang Mai — PyTorch Edition
echo ==========================================
echo.

cd /d "%~dp0"

REM ── ใช้ conda environment heat_pytorch ──────────────────────
call C:\Users\Admin\anaconda3\Scripts\activate.bat
call conda activate heat_pytorch

echo [1/2] ติดตั้ง Dependencies เพิ่มเติม (ถ้ายังไม่มี)...
pip install fastapi==0.111.0 uvicorn[standard]==0.29.0 ^
    python-multipart==0.0.9 pydantic==2.7.1 ^
    httpx requests geopandas python-dotenv ^
    "openai==1.51.0" jinja2 -q

echo.
echo ==========================================
echo  เซิร์ฟเวอร์พร้อมแล้ว!
echo  เปิดเบราว์เซอร์: http://localhost:8000
echo ==========================================
echo.

python app.py

pause
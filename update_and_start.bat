@echo off
echo ==========================================
echo  อัปเดต google-genai SDK
echo ==========================================

cd /d "%~dp0"

call venv\Scripts\activate.bat

echo กำลังลบ package เก่า...
pip uninstall google-generativeai -y

echo กำลังติดตั้ง package ใหม่...
pip install google-genai

echo.
echo ==========================================
echo  อัปเดตเสร็จแล้ว! กำลังเริ่ม server...
echo ==========================================
echo.

python app.py

pause

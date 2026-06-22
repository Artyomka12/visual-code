@echo off
echo ====================================
echo   Python Visualizer
echo ====================================
echo.
cd /d "%~dp0backend"
echo Запуск сервера на http://localhost:8080
echo Открой в браузере: http://localhost:8080
echo Для остановки нажми Ctrl+C
echo.
python main.py
pause

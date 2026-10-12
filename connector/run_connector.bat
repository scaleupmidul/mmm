@echo off
title GEP-5 Real MetaTrader 5 Market-Data Connector
color 0A
echo ====================================================================
echo   GEP-5: Real MetaTrader 5 Connector (XAU/USD Gold)
echo ====================================================================
echo.
echo Make sure Exness MetaTrader 5 Desktop Terminal is running on Windows!
echo Target broker symbol: XAUUSDm (Exness Standard) or XAUUSD (Exness Raw/Pro)
echo.

set DEFAULT_URL=https://ais-dev-ypyaix5bdfvaptugued2lk-496547113348.asia-southeast1.run.app
echo Default Web App: %DEFAULT_URL%
set /p WEB_URL="Enter GEP-5 Web URL (or press ENTER for deployed dashboard): "
if "%WEB_URL%"=="" (
    set WEB_URL=%DEFAULT_URL%
)

echo.
echo Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in your system PATH!
    echo Please install 64-bit Python 3.8-3.12 from https://www.python.org/
    echo Remember to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)

echo.
echo Launching connector with target API: %WEB_URL%/api/connector/push
echo.
python gep5_connector.py --symbol XAUUSDm --web-url %WEB_URL% %*
pause

@echo off
title QuickBite Express - Public External Tunnel
color 0B
cls
echo =======================================================================
echo          🍔 QUICKBITE EXPRESS - PUBLIC EXTERNAL HTTPS TUNNEL
echo =======================================================================
echo.
echo Your local food order server is running on port 5000.
echo This script connects it to the global internet so anyone outside your
echo Wi-Fi network (on mobile data, another city, or another device) can access it.
echo.
echo Choose which public tunnel provider you want to use:
echo.
echo   [1] Pinggy (Recommended: Instant HTTPS, Zero-Config, No Password)
echo   [2] Localtunnel (Standard Node-based HTTPS tunnel)
echo   [3] Localhost.run (SSH tunnel with TLS termination)
echo.
set /p choice="Enter choice (1, 2, or 3) [Default: 1]: "

if "%choice%"=="" set choice=1
if "%choice%"=="1" goto PINGGY
if "%choice%"=="2" goto LOCALTUNNEL
if "%choice%"=="3" goto LHR

:PINGGY
echo.
echo Starting Pinggy tunnel on port 5000...
echo (Keep this window OPEN to keep the public link active!)
echo.
ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 0:localhost:5000 a.pinggy.io
goto END

:LOCALTUNNEL
echo.
echo Starting Localtunnel on port 5000...
echo (Keep this window OPEN to keep the public link active!)
echo.
call npx --yes localtunnel --port 5000
goto END

:LHR
echo.
echo Starting Localhost.run tunnel on port 5000...
echo (Keep this window OPEN to keep the public link active!)
echo.
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:5000 nokey@localhost.run
goto END

:END
echo.
echo Tunnel closed.
pause

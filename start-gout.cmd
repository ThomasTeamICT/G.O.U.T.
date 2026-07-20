@echo off
rem Dubbelklik-starter voor G.O.U.T. (Windows): draait de server in een eigen
rem geminimaliseerd venster, zodat kopieren/klikken elders hem nooit stopt.
cd /d %~dp0
start "G.O.U.T." /min cmd /k "npm start"
echo G.O.U.T. start in een eigen venster. Open http://localhost:3000
timeout /t 4 >nul

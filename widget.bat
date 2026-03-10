@echo off
REM SwarmCast Weather Widget — launches as a compact Chrome app window
REM Right-click taskbar icon to close, or Alt+F4
REM Positions bottom-right by default. Drag title bar to move.

set URL=http://127.0.0.1:3777/widget.html
set WIDTH=340
set HEIGHT=490

REM Try Chrome, then Edge
where chrome >nul 2>&1 && (
    start "" chrome --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

where msedge >nul 2>&1 && (
    start "" msedge --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

REM Fallback: find Chrome in standard install locations
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

REM Edge fallback
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%URL%" --window-size=%WIDTH%,%HEIGHT% --window-position=9999,9999 --disable-extensions --user-data-dir="%TEMP%\swarmcast-widget"
    exit /b
)

echo No Chrome or Edge found. Open %URL% manually in a browser.
pause

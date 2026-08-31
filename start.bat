@echo off
REM TMS 배송코스 최적화 - 개발 서버 실행 (Windows)
REM 이 파일을 더블클릭하세요.
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js 가 설치되어 있지 않습니다.
  echo   https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 (
  echo.
  echo   Node.js 18 이상이 필요합니다.
  echo   https://nodejs.org 에서 LTS 버전으로 업데이트하세요.
  echo.
  pause
  exit /b 1
)

node tools\dev-server.mjs

REM 서버가 종료되어도 창이 바로 닫히지 않게 한다 (오류 메시지를 읽을 수 있도록)
echo.
pause

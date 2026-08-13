@echo off
setlocal

cd /d "%~dp0"
title HackerCode

where node.exe >nul 2>&1
if errorlevel 1 (
	echo HackerCode requires Node.js on PATH.
	echo Install the version listed in .nvmrc, then run this file again.
	pause
	exit /b 1
)

call "%~dp0scripts\code.bat" --hackercode-control %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
	echo.
	echo HackerCode exited with code %EXIT_CODE%.
	pause
)

exit /b %EXIT_CODE%

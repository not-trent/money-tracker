@echo off
set "MONEY_TRACKER_HOST=0.0.0.0"
if exist "%~dp0certs\lan-cert.pem" set "MONEY_TRACKER_SSL_CERT=%~dp0certs\lan-cert.pem"
if exist "%~dp0certs\lan-key.pem" set "MONEY_TRACKER_SSL_KEY=%~dp0certs\lan-key.pem"
call "%~dp0start.bat"
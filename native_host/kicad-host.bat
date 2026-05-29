@echo off
REM Chrome Native-Messaging shim — invoked with stdin/stdout connected to Chrome.
REM Resolves to native_host\host.py relative to this .bat's directory.
REM
REM Uses the `py` launcher rather than `python` because Chrome subprocesses
REM run with the system PATH (no venv activation), and on Windows the
REM unqualified `python` often resolves to the Microsoft Store stub
REM (C:\Users\...\WindowsApps\python.exe) which hangs silently. The `py`
REM launcher (C:\Windows\py.exe) ships with the official Python installer
REM and dispatches to the active interpreter reliably.
py "%~dp0host.py"

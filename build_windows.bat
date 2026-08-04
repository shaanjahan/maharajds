@echo off
REM Builds StatisticalAnalysisTerminal.exe in the dist\ folder.
REM Requires Python 3.9+ on PATH. Run from this folder.

python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller
python -m PyInstaller --noconfirm --clean --onefile --windowed ^
    --name StatisticalAnalysisTerminal ^
    --collect-submodules matplotlib ^
    terminal_app.py

echo.
echo Done. The executable is at dist\StatisticalAnalysisTerminal.exe
pause

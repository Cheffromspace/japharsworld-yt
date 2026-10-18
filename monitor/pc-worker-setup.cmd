@echo off
rem One-time setup of the PC worker: ffmpeg for the flash check, then a Task Scheduler entry every 20 minutes.
rem Uses VRChat's own yt-dlp (so heights match what VRChat gets) and the SSH key ~/.ssh/mediamtx_vps.
cd /d "%~dp0"
py -m pip install --target .deps --upgrade imageio-ffmpeg || exit /b 1
for /f "delims=" %%p in ('py -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"') do set PYW=%%p
schtasks /Create /F /SC MINUTE /MO 20 /TN "Everything is OK slot worker" /TR "\"%PYW%\" \"%~dp0pc-worker.pyw\"" || exit /b 1
echo Worker scheduled. Log: %~dp0data\worker.log

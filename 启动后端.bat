@echo off
rem 投资学知识图谱 - 后端启动脚本（双击运行）
rem 依赖：pip install fastapi uvicorn sentence-transformers wandb
cd /d "%~dp0"
uvicorn main:app --host 127.0.0.1 --port 8000
pause

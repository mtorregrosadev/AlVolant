# Installation & Setup Guide

This guide covers how to get the Route-TMB monorepo (Backend BFF + Frontend Expo App) running on your local machine.

## 1. Backend (BFF)

The backend is built with Python (FastAPI) and requires Redis for caching GTFS static/real-time data.

### Option A: Using Docker (Recommended)
This is the easiest way to spin up the BFF and Redis simultaneously.

1. **Setup Environment Variables**:
   ```bash
   cp .env.example .env
   ```
2. **Start the Stack**:
   ```bash
   docker-compose up -d
   ```
   The backend will now be available at `http://localhost:8000`.

### Option B: Local Python Environment
If you prefer running the Python server natively (useful for development):

1. **Start Redis**:
   Ensure you have a local Redis instance running on port 6379.
   ```bash
   docker run -p 6379:6379 -d redis:7-alpine
   ```
2. **Setup Environment Variables**:
   ```bash
   cp .env.example .env
   ```
3. **Install Dependencies**:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -e .
   ```
4. **Run the Server**:
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```

---

## 2. Frontend (Mobile App)

The mobile application is built using React Native via Expo and MapLibre GL. Because MapLibre uses custom native code, you must use development builds rather than standard Expo Go.

1. **Navigate to the App Directory**:
   ```bash
   cd app-conductor
   ```

2. **Install Node Dependencies**:
   ```bash
   npm install
   ```

3. **Run the Application**:
   Ensure you have your respective emulator/simulator open before running these commands.

   **For Android:**
   ```bash
   npm run android
   ```

   **For iOS (Requires macOS):**
   ```bash
   npm run ios
   ```

   *Note: Upon first run, Expo will automatically compile the native MapLibre libraries before launching the app in your simulator.*

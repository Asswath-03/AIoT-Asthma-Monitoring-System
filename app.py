"""
AIoT Asthma Monitoring System - Flask Backend
------------------------------------------------
Reads sensor data continuously from an ESP32 connected over USB (Serial Port),
parses it, stores the latest reading in memory, and exposes it via a REST API
that the dashboard frontend polls every second.

Serial data format sent by ESP32 (one line per second, CSV):
    temperature,humidity,airQuality,status

Example:
    29.8,64,1780,GOOD
    38.1,82,3560,ALERT
"""

import csv
import io
import json
import re
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime

import serial
from flask import Flask, jsonify, send_file, render_template

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
SERIAL_PORT = "COM4"       # Change this if your ESP32 shows up on a different port
BAUD_RATE = 115200         # Must match Serial.begin() in the ESP32 sketch
RECONNECT_DELAY = 2        # Seconds to wait before retrying a lost serial connection
MAX_HISTORY = 200          # Max number of readings kept in memory for CSV export

# ntfy.sh mobile push notifications
# 1. Install the ntfy app on your phone (Google Play / App Store)
# 2. In the app, subscribe to a topic name of your choosing (make it hard to guess,
#    since anyone who knows the topic name can also subscribe to it)
# 3. Put that same topic name below
NTFY_ENABLED = True
NTFY_TOPIC = "Asthma-Alert-System"  # matches the topic subscribed to in the ntfy app
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}"

# Ollama local AI insight generation (runs fully offline — no internet needed)
# 1. Make sure the Ollama app is running (it usually starts automatically)
# 2. Run `ollama list` in a terminal to see which model(s) you have pulled
# 3. Put the exact model name below (e.g. "llama3.2", "phi3", "mistral")
AI_ENABLED = True
OLLAMA_MODEL = "phi3:latest"  # matches `ollama list` output on this machine
OLLAMA_URL = "http://localhost:11434/api/generate"
AI_TIMEOUT = 30  # seconds — local generation can be slow on CPU-only machines

app = Flask(__name__)

# ------------------------------------------------------------------
# Shared state (protected by a lock since it's touched by 2 threads:
# the serial reader thread and the Flask request thread)
# ------------------------------------------------------------------
lock = threading.Lock()

latest_data = {
    "temperature": None,
    "humidity": None,
    "air": None,
    "status": "UNKNOWN",
    "timestamp": None,
    "connected": False,
}

history = []  # list of dicts, used for CSV export

# Tracks the last status seen so a phone notification only fires once per
# transition into ALERT, not on every single reading while it stays ALERT.
previous_status = None


def send_ntfy_notification(reading):
    """
    Sends a push notification to the ntfy.sh topic configured above.
    Runs in the background serial-reader thread; failures are logged but
    never crash the app (e.g. no internet connection at the moment).
    """
    if not NTFY_ENABLED:
        return

    message = (
        f"Temp: {reading['temperature']:.1f}C | "
        f"Humidity: {reading['humidity']:.0f}% | "
        f"Air: {reading['air']:.0f} ppm"
    )

    try:
        req = urllib.request.Request(
            NTFY_URL,
            data=message.encode("utf-8"),
            headers={
                "Title": "Asthma Risk Detected",
                "Priority": "urgent",
                "Tags": "warning",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
        print("[ntfy] Alert notification sent")
    except (urllib.error.URLError, OSError) as e:
        print(f"[ntfy] Failed to send notification: {e}")


# ------------------------------------------------------------------
# AI insight generation (Ollama, runs fully locally/offline)
# ------------------------------------------------------------------
latest_ai_insight = {
    "text": None,
    "loading": False,
    "generated_at": None,
    "error": None,
}


def build_ai_prompt(reading, recent_readings):
    """Builds a short, focused prompt so a small local model stays concise."""
    trend_lines = "\n".join(
        f"- {r['timestamp']}: {r['temperature']:.1f}C, {r['humidity']:.0f}% humidity, {r['air']:.0f} ppm air, {r['status']}"
        for r in recent_readings[-8:]
    )
    return (
        "You are an assistant embedded in an asthma environmental monitoring dashboard. "
        "Given the recent sensor readings below, explain in 2 short sentences (plain language, "
        "no headings, no markdown) what is likely happening and one practical suggestion. "
        "Be concise and calm, this is shown directly on a live dashboard.\n\n"
        f"Recent readings:\n{trend_lines}\n\n"
        f"Current reading: {reading['temperature']:.1f}C, {reading['humidity']:.0f}% humidity, "
        f"{reading['air']:.0f} ppm air quality, status={reading['status']}."
    )


def generate_ai_insight(reading, recent_readings):
    """
    Calls the local Ollama server to generate a short natural-language insight.
    Runs synchronously — callers should invoke this in a background thread
    since local generation can take several seconds.
    """
    if not AI_ENABLED:
        return

    with lock:
        latest_ai_insight["loading"] = True
        latest_ai_insight["error"] = None

    prompt = build_ai_prompt(reading, recent_readings)

    try:
        payload = json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")

        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=AI_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))

        text = result.get("response", "").strip()
        with lock:
            latest_ai_insight["text"] = text
            latest_ai_insight["loading"] = False
            latest_ai_insight["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print("[ai] Insight generated")

    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        error_msg = (
            "Could not reach Ollama. Make sure the Ollama app is running "
            f"and the model '{OLLAMA_MODEL}' is pulled (run: ollama list)."
        )
        with lock:
            latest_ai_insight["loading"] = False
            latest_ai_insight["error"] = error_msg
        print(f"[ai] Failed to generate insight: {e}")


# Matches lines like: "Temp: 30.30 C   Hum: 71.20 %   Air: 2403   GOOD"
LABELED_LINE_PATTERN = re.compile(
    r"Temp:\s*([\d.]+).*?Hum:\s*([\d.]+).*?Air:\s*([\d.]+).*?(GOOD|ALERT)",
    re.IGNORECASE,
)


def parse_line(line: str):
    """
    Parse a single line of sensor data from the ESP32.

    Supports two formats:
      1. Plain CSV:      "29.8,64,1780,GOOD"
      2. Labeled/OLED-style debug output:
         "Temp: 30.30 C   Hum: 71.20 %   Air: 2403   GOOD"

    Returns a dict on success, or None if the line doesn't match either format.
    """
    line = line.strip()
    if not line:
        return None

    # Try labeled format first (what this ESP32 sketch currently prints)
    match = LABELED_LINE_PATTERN.search(line)
    if match:
        try:
            temperature = float(match.group(1))
            humidity = float(match.group(2))
            air = float(match.group(3))
            status = match.group(4).strip().upper()
            return {
                "temperature": temperature,
                "humidity": humidity,
                "air": air,
                "status": status,
            }
        except (ValueError, IndexError):
            return None

    # Fall back to plain CSV format
    try:
        parts = line.split(",")
        if len(parts) != 4:
            return None

        temperature = float(parts[0])
        humidity = float(parts[1])
        air = float(parts[2])
        status = parts[3].strip().upper()

        if status not in ("GOOD", "ALERT"):
            return None

        return {
            "temperature": temperature,
            "humidity": humidity,
            "air": air,
            "status": status,
        }
    except (ValueError, IndexError):
        return None


def serial_reader():
    """
    Background thread: continuously opens (or reopens) the serial port
    and reads incoming lines from the ESP32, updating the shared state.
    Runs forever, auto-reconnecting if the connection drops.
    """
    global latest_data, history

    while True:
        try:
            with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2) as ser:
                print(f"[Serial] Connected to {SERIAL_PORT} at {BAUD_RATE} baud")
                with lock:
                    latest_data["connected"] = True

                # Give the ESP32 a moment after opening the port
                # (many boards reset when the serial connection opens)
                time.sleep(2)
                ser.reset_input_buffer()

                while True:
                    raw_line = ser.readline().decode("utf-8", errors="ignore")
                    if not raw_line:
                        continue  # timeout with no data, keep looping

                    parsed = parse_line(raw_line)
                    if parsed is None:
                        continue  # skip malformed / partial lines

                    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                    global previous_status
                    entering_alert = parsed["status"] == "ALERT" and previous_status != "ALERT"

                    with lock:
                        latest_data.update(parsed)
                        latest_data["timestamp"] = now
                        latest_data["connected"] = True

                        history.append({**parsed, "timestamp": now})
                        if len(history) > MAX_HISTORY:
                            history.pop(0)

                    previous_status = parsed["status"]

                    if entering_alert:
                        send_ntfy_notification(parsed)
                        # Run AI generation in its own thread so a slow local
                        # model doesn't stall serial reading or the reconnect loop.
                        threading.Thread(
                            target=generate_ai_insight,
                            args=(parsed, list(history)),
                            daemon=True,
                        ).start()

        except serial.SerialException as e:
            print(f"[Serial] Connection error on {SERIAL_PORT}: {e}")
            with lock:
                latest_data["connected"] = False
            time.sleep(RECONNECT_DELAY)
        except Exception as e:
            print(f"[Serial] Unexpected error: {e}")
            with lock:
                latest_data["connected"] = False
            time.sleep(RECONNECT_DELAY)


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@app.route("/")
def index():
    """Serve the dashboard's main HTML page."""
    return render_template("index.html")


@app.route("/data")
def get_data():
    """
    Returns the latest sensor reading as JSON:
    {
        "temperature": 29.8,
        "humidity": 64,
        "air": 1780,
        "status": "GOOD",
        "timestamp": "2026-07-23 10:15:32",
        "connected": true
    }
    """
    with lock:
        return jsonify(dict(latest_data))


@app.route("/history")
def get_history():
    """Returns the full in-memory reading history (used for CSV export)."""
    with lock:
        return jsonify(list(history))


@app.route("/ai-insight", methods=["GET"])
def get_ai_insight():
    """
    Returns the current AI insight state so the frontend can poll it:
    {
        "text": "Air quality has been climbing steadily...",
        "loading": false,
        "generated_at": "2026-07-24 12:01:22",
        "error": null
    }
    """
    with lock:
        return jsonify(dict(latest_ai_insight))


@app.route("/ai-insight", methods=["POST"])
def trigger_ai_insight():
    """
    Manually triggers a fresh AI insight generation (used by the
    dashboard's 'Ask AI' button). Runs in a background thread and
    returns immediately; the frontend polls GET /ai-insight for the result.
    """
    if not AI_ENABLED:
        return jsonify({"error": "AI insight is disabled in app.py"}), 400

    with lock:
        current_reading = dict(latest_data)
        recent = list(history)

    if current_reading.get("temperature") is None:
        return jsonify({"error": "No sensor data yet"}), 400

    threading.Thread(
        target=generate_ai_insight,
        args=(current_reading, recent),
        daemon=True,
    ).start()

    return jsonify({"started": True})


@app.route("/download-csv")
def download_csv():
    """Generates and returns a CSV file of all readings collected so far."""
    with lock:
        rows = list(history)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Time", "Temperature", "Humidity", "Air Quality", "Status"])
    for row in rows:
        writer.writerow([
            row.get("timestamp"),
            row.get("temperature"),
            row.get("humidity"),
            row.get("air"),
            row.get("status"),
        ])

    mem = io.BytesIO(buffer.getvalue().encode("utf-8"))
    mem.seek(0)
    filename = f"asthma_readings_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    return send_file(
        mem,
        mimetype="text/csv",
        as_attachment=True,
        download_name=filename,
    )


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------
if __name__ == "__main__":
    reader_thread = threading.Thread(target=serial_reader, daemon=True)
    reader_thread.start()

    print("Starting AIoT Asthma Monitoring Dashboard on http://127.0.0.1:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)

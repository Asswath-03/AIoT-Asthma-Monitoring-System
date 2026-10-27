/* =====================================================
   AIoT Asthma Monitoring Dashboard - Frontend Logic
   Polls Flask /data endpoint every second and updates
   cards, charts, table, alerts and connection status.
===================================================== */

const POLL_INTERVAL_MS = 1000;
const MAX_CHART_POINTS = 30;
const MAX_TABLE_ROWS = 20;

let hasReceivedFirstData = false;

// ---------------- DOM references ----------------
const loadingOverlay = document.getElementById("loadingOverlay");

const tempValueEl = document.getElementById("tempValue");
const humidityValueEl = document.getElementById("humidityValue");
const airValueEl = document.getElementById("airValue");
const statusValueEl = document.getElementById("statusValue");
const statusCardEl = document.getElementById("statusCard");
const statusIconEl = document.getElementById("statusIcon");
const airGaugeFill = document.getElementById("airGaugeFill");

const alertBanner = document.getElementById("alertBanner");

const connectionDot = document.getElementById("connectionDot");
const connectionText = document.getElementById("connectionText");

const lastUpdatedEl = document.getElementById("lastUpdated");
const currentDateEl = document.getElementById("currentDate");
const currentTimeEl = document.getElementById("currentTime");

const readingsTableBody = document.getElementById("readingsTableBody");
const resetChartsBtn = document.getElementById("resetChartsBtn");
const downloadCsvBtn = document.getElementById("downloadCsvBtn");

// ---------------- Alarm tone (generated via Web Audio API, no external file needed) ----------------
let audioCtx = null;
let alarmIntervalId = null;

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
}

function playBeep() {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.value = 880; // A5 - clear, attention-grabbing tone
    gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.35);
}

function startAlarm() {
    if (alarmIntervalId) return; // already running
    playBeep();
    alarmIntervalId = setInterval(playBeep, 900);
}

function stopAlarm() {
    if (alarmIntervalId) {
        clearInterval(alarmIntervalId);
        alarmIntervalId = null;
    }
}

// ---------------- Chart.js setup ----------------
const chartOptionsBase = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    scales: {
        x: {
            ticks: { color: "#8a93a6", maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
            grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
            ticks: { color: "#8a93a6" },
            grid: { color: "rgba(255,255,255,0.06)" },
        },
    },
    plugins: {
        legend: { display: false },
    },
    elements: {
        point: { radius: 0 },
        line: { tension: 0.35, borderWidth: 2 },
    },
};

function makeChart(canvasId, label, color) {
    const ctx = document.getElementById(canvasId).getContext("2d");
    return new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [
                {
                    label: label,
                    data: [],
                    borderColor: color,
                    backgroundColor: color + "22",
                    fill: true,
                },
            ],
        },
        options: chartOptionsBase,
    });
}

const tempChart = makeChart("tempChart", "Temperature", "#ff9f43");
const humidityChart = makeChart("humidityChart", "Humidity", "#3ea6ff");
const airChart = makeChart("airChart", "Air Quality", "#37d6c1");

function pushToChart(chart, label, value) {
    chart.data.labels.push(label);
    chart.data.datasets[0].data.push(value);

    if (chart.data.labels.length > MAX_CHART_POINTS) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
    }
    chart.update("none");
}

function resetCharts() {
    [tempChart, humidityChart, airChart].forEach((chart) => {
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.update();
    });
}

// ---------------- Table handling ----------------
function addTableRow(reading) {
    const row = document.createElement("tr");

    const statusClass = reading.status === "ALERT" ? "status-alert" : "status-good";

    row.innerHTML = `
        <td>${reading.timestamp ?? "--"}</td>
        <td>${reading.temperature?.toFixed(1) ?? "--"} °C</td>
        <td>${reading.humidity?.toFixed(0) ?? "--"} %</td>
        <td>${reading.air?.toFixed(0) ?? "--"} ppm</td>
        <td class="${statusClass}">${reading.status ?? "--"}</td>
    `;

    readingsTableBody.prepend(row);

    while (readingsTableBody.children.length > MAX_TABLE_ROWS) {
        readingsTableBody.removeChild(readingsTableBody.lastChild);
    }
}

// ---------------- Air quality gauge ----------------
// Assumes a practical air quality sensor range of 0-4000 ppm for the arc fill
const GAUGE_MAX = 4000;
const GAUGE_CIRCUMFERENCE = 157; // matches stroke-dasharray in CSS

function updateGauge(airValue) {
    const ratio = Math.min(Math.max(airValue / GAUGE_MAX, 0), 1);
    const offset = GAUGE_CIRCUMFERENCE - ratio * GAUGE_CIRCUMFERENCE;
    airGaugeFill.style.strokeDashoffset = offset;

    // Color shifts from teal -> orange -> red as air quality worsens
    let color = "#37d6c1";
    if (ratio > 0.75) color = "#ff4d5e";
    else if (ratio > 0.45) color = "#ff9f43";
    airGaugeFill.style.stroke = color;
}

// ---------------- Voice assist (Web Speech API - built into the browser, no external service) ----------------
function speak(message) {
    if (!("speechSynthesis" in window)) return; // gracefully skip on unsupported browsers

    // Cancel anything mid-sentence so alerts don't queue up and stack
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
}

// ---------------- Desktop notifications (Web Notification API) ----------------
const enableNotificationsBtn = document.getElementById("enableNotificationsBtn");

function updateNotificationButtonLabel() {
    if (!("Notification" in window)) {
        enableNotificationsBtn.textContent = "🔕 Not supported";
        enableNotificationsBtn.disabled = true;
        return;
    }
    if (Notification.permission === "granted") {
        enableNotificationsBtn.textContent = "🔔 Alerts enabled";
        enableNotificationsBtn.classList.add("enabled");
    } else if (Notification.permission === "denied") {
        enableNotificationsBtn.textContent = "🔕 Blocked in browser settings";
    } else {
        enableNotificationsBtn.textContent = "🔔 Enable alerts";
    }
}

enableNotificationsBtn.addEventListener("click", () => {
    if (!("Notification" in window)) return;

    if (Notification.permission === "denied") {
        alert(
            "Notifications are blocked for this site. To enable them, click the lock/info icon " +
            "in your browser's address bar, find Notifications, and set it to Allow."
        );
        return;
    }

    Notification.requestPermission().then(updateNotificationButtonLabel);
});

function showAlertNotification(reading) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    new Notification("⚠ Asthma Risk Detected", {
        body: `Temp: ${reading.temperature.toFixed(1)}°C · Humidity: ${reading.humidity.toFixed(0)}% · Air: ${reading.air.toFixed(0)} ppm`,
        icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%AB%81%3C/text%3E%3C/svg%3E",
        tag: "asthma-alert", // reuses the same notification instead of stacking duplicates
    });
}

// Tracks the previous status so voice/notifications fire once per transition,
// not on every single poll while the alert condition is still active.
let previousStatus = null;

// ---------------- Status / Alert handling ----------------
function updateStatus(status, reading) {
    const enteringAlert = status === "ALERT" && previousStatus !== "ALERT";
    const enteringGood = status === "GOOD" && previousStatus === "ALERT";

    if (status === "ALERT") {
        statusCardEl.classList.remove("good");
        statusCardEl.classList.add("alert");
        statusIconEl.textContent = "⚠️";
        statusValueEl.textContent = "ALERT";
        alertBanner.classList.remove("hidden");

        startAlarm();

        if (enteringAlert) {
            speak("Warning. Asthma risk detected. Please check the environment.");
            showAlertNotification(reading);
            startAiPolling(); // backend auto-generates an insight on this same transition
        }
    } else if (status === "GOOD") {
        statusCardEl.classList.remove("alert");
        statusCardEl.classList.add("good");
        statusIconEl.textContent = "✅";
        statusValueEl.textContent = "GOOD";
        alertBanner.classList.add("hidden");

        stopAlarm();

        if (enteringGood) {
            speak("Conditions are back to normal.");
        }
    }

    previousStatus = status;
}

// ---------------- Connection status ----------------
function updateConnectionStatus(connected) {
    if (connected) {
        connectionDot.classList.remove("disconnected");
        connectionDot.classList.add("connected");
        connectionText.textContent = "Connected";
    } else {
        connectionDot.classList.remove("connected");
        connectionDot.classList.add("disconnected");
        connectionText.textContent = "Disconnected";
    }
}

// ---------------- Clock ----------------
function updateClock() {
    const now = new Date();
    currentDateEl.textContent = now.toLocaleDateString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
    });
    currentTimeEl.textContent = now.toLocaleTimeString();
}

// ---------------- Main polling loop ----------------
async function fetchData() {
    try {
        const response = await fetch("/data");
        if (!response.ok) throw new Error("Bad response from server");

        const data = await response.json();

        updateConnectionStatus(Boolean(data.connected));

        // If no reading has arrived yet, keep showing the loading overlay
        if (data.temperature === null || data.temperature === undefined) {
            return;
        }

        if (!hasReceivedFirstData) {
            hasReceivedFirstData = true;
            loadingOverlay.classList.add("hidden");
        }

        // Update cards
        tempValueEl.textContent = `${data.temperature.toFixed(1)} °C`;
        humidityValueEl.textContent = `${data.humidity.toFixed(0)} %`;
        airValueEl.textContent = `${data.air.toFixed(0)} ppm`;
        updateStatus(data.status, data);
        updateGauge(data.air);

        // Update charts
        const label = data.timestamp ? data.timestamp.split(" ")[1] : "";
        pushToChart(tempChart, label, data.temperature);
        pushToChart(humidityChart, label, data.humidity);
        pushToChart(airChart, label, data.air);

        // Update table
        addTableRow(data);

        // Update timestamp
        lastUpdatedEl.textContent = data.timestamp ?? "--";
    } catch (err) {
        updateConnectionStatus(false);
        console.error("Error fetching /data:", err);
    }
}

// ---------------- AI Insight (Ollama, generated on the backend) ----------------
const askAiBtn = document.getElementById("askAiBtn");
const aiInsightBody = document.getElementById("aiInsightBody");
let aiPollIntervalId = null;

function renderAiInsight(data) {
    if (data.loading) {
        aiInsightBody.innerHTML = `
            <div class="ai-loading">
                <span class="ai-spinner"></span>
                <span>Generating insight locally with Ollama...</span>
            </div>`;
        return;
    }

    if (data.error) {
        aiInsightBody.innerHTML = `<p class="ai-error">${data.error}</p>`;
        return;
    }

    if (data.text) {
        const stamp = data.generated_at ? `<span class="ai-timestamp">Generated at ${data.generated_at}</span>` : "";
        aiInsightBody.innerHTML = `<div><p class="ai-text">${data.text}</p>${stamp}</div>`;
        return;
    }

    aiInsightBody.innerHTML = `<p class="ai-placeholder">Ask AI, or wait for the next ALERT — an insight will generate automatically.</p>`;
}

async function pollAiInsight() {
    try {
        const res = await fetch("/ai-insight");
        const data = await res.json();
        renderAiInsight(data);

        // Stop polling once generation has finished (success or error)
        if (!data.loading && aiPollIntervalId) {
            clearInterval(aiPollIntervalId);
            aiPollIntervalId = null;
        }
    } catch (err) {
        console.error("Error polling /ai-insight:", err);
    }
}

function startAiPolling() {
    if (aiPollIntervalId) return; // already polling
    pollAiInsight();
    aiPollIntervalId = setInterval(pollAiInsight, 1500);
}

async function triggerAiInsight() {
    try {
        const res = await fetch("/ai-insight", { method: "POST" });
        if (!res.ok) {
            const data = await res.json();
            renderAiInsight({ loading: false, error: data.error || "Could not start AI generation." });
            return;
        }
        startAiPolling();
    } catch (err) {
        renderAiInsight({ loading: false, error: "Could not reach the server to start AI generation." });
    }
}

// ---------------- Button handlers ----------------
resetChartsBtn.addEventListener("click", resetCharts);

downloadCsvBtn.addEventListener("click", () => {
    window.location.href = "/download-csv";
});

askAiBtn.addEventListener("click", triggerAiInsight);

// ---------------- Init ----------------
updateNotificationButtonLabel();
updateClock();
setInterval(updateClock, 1000);

fetchData();
setInterval(fetchData, POLL_INTERVAL_MS);

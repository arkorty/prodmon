const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const screenshot = require("screenshot-desktop");
const fs = require("fs");
const os = require("os");
const { spawn, exec } = require("child_process");

const appName = require("../package.json").name;

const screenshotsDir = path.join(
  os.homedir(),
  ".cache",
  appName,
  "screenshots"
);
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const logicDir = path.join(__dirname, "logic");
const venvDir = path.join(logicDir, "venv");
const pythonPath = path.join(venvDir, "bin", "python");
const pipPath = path.join(venvDir, "bin", "pip");

async function setupPythonEnv() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(venvDir)) {
      console.log("Python virtual environment already exists");
      resolve();
      return;
    }

    console.log("Creating Python virtual environment...");
    const python = process.platform === "win32" ? "python" : "python3";

    exec(`${python} -m venv ${venvDir}`, (error) => {
      if (error) {
        console.error("Error creating virtual environment:", error);
        reject(error);
        return;
      }

      console.log("Installing Python dependencies...");
      exec(
        `${pipPath} install -r ${path.join(logicDir, "requirements.txt")}`,
        (error) => {
          if (error) {
            console.error("Error installing dependencies:", error);
            reject(error);
            return;
          }
          console.log("Python environment setup complete");
          resolve();
        }
      );
    });
  });
}

let mainWindow;
let countdownInterval;
const SCREENSHOT_INTERVAL = 30 * 1000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile("src/index.html");
}

async function takeScreenshot() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotPath = path.join(
      screenshotsDir,
      `screenshot-${timestamp}.png`
    );

    await screenshot({ filename: screenshotPath });

    mainWindow.webContents.send("screenshot-taken", screenshotPath);

    const pythonScript = path.join(logicDir, "src/main.py");
    const prohibitedPath = path.join(logicDir, "src/data", "prohibited.csv");

    const pythonProcess = spawn(pythonPath, [
      pythonScript,
      "--single",
      screenshotPath,
      "--prohibited",
      prohibitedPath,
      "--role",
      "developer",
      "--model",
      "gemini",
    ]);

    let outputData = "";

    pythonProcess.stdout.on("data", (data) => {
      outputData += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      console.error(`Python script error: ${data}`);
      mainWindow.webContents.send("screenshot-error", data.toString());
    });

    pythonProcess.on("close", (code) => {
      if (code === 0) {
        try {
          const jsonResponse = JSON.parse(outputData);
          mainWindow.webContents.send("screenshot-analysis", {
            screenshotPath,
            analysis: jsonResponse,
          });
        } catch (error) {
          console.error("Error parsing Python script output:", error);
          mainWindow.webContents.send(
            "screenshot-error",
            "Invalid JSON response from analysis"
          );
        }
      } else {
        mainWindow.webContents.send(
          "screenshot-error",
          `Python script exited with code ${code}`
        );
      }
    });
  } catch (error) {
    console.error("Screenshot error:", error);
    mainWindow.webContents.send("screenshot-error", error.message);
  }
}

function startCountdown() {
  let timeLeft = SCREENSHOT_INTERVAL / 1000;

  countdownInterval = setInterval(() => {
    timeLeft--;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("countdown-update", timeLeft);
    }

    if (timeLeft <= 0) {
      takeScreenshot();
      timeLeft = SCREENSHOT_INTERVAL / 1000;
    }
  }, 1000);
}

app.whenReady().then(async () => {
  try {
    await setupPythonEnv();

    createWindow();

    startCountdown();
    takeScreenshot();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error("Failed to setup Python environment:", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    clearInterval(countdownInterval);
    app.quit();
  }
});

const express = require("express");
const session = require("express-session");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASS = process.env.PANEL_PASS || "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

const COOKIE_FILE = "/tmp/youtube-cookies.txt";

app.use(express.json({ limit: "2mb" }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

let ffmpegProcess = null;
let restartTimer = null;
let stopRequested = false;

let liveState = {
  running: false,
  starting: false,
  youtubeUrl: "",
  loop: true,
  quality: "720",
  startedAt: null,
  stoppedAt: null,
  lastError: "",
  logs: [],
  fps: 0,
  bitrate: "0 kbps",
  droppedFrames: 0,
};

function addLog(type, message) {
  const item = {
    time: new Date().toISOString(),
    type,
    message: String(message || "").slice(0, 900),
  };

  liveState.logs.unshift(item);
  liveState.logs = liveState.logs.slice(0, 80);
  console.log(`[${type}] ${item.message}`);
}

function isLoggedIn(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

function isValidYoutubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    return [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com",
      "www.youtube.com",
    ].includes(host);
  } catch {
    return false;
  }
}

function setupCookiesFile() {
  const b64 = process.env.YT_COOKIES_B64;

  if (!b64 || !b64.trim()) {
    addLog("warning", "YT_COOKIES_B64 not found. yt-dlp will run without cookies.");
    return null;
  }

  try {
    const decoded = Buffer.from(b64.trim(), "base64").toString("utf8");

    if (!decoded.includes("Netscape HTTP Cookie File") && !decoded.includes(".youtube.com")) {
      addLog("warning", "YT_COOKIES_B64 decoded, but it does not look like a YouTube cookies.txt file.");
    }

    fs.writeFileSync(COOKIE_FILE, decoded, { encoding: "utf8", mode: 0o600 });
    addLog("success", "YouTube cookies loaded from YT_COOKIES_B64.");
    return COOKIE_FILE;
  } catch (err) {
    addLog("error", "Failed to decode YT_COOKIES_B64: " + err.message);
    return null;
  }
}

function getCookiesArgs() {
  if (fs.existsSync(COOKIE_FILE)) {
    return ["--cookies", COOKIE_FILE];
  }

  const file = setupCookiesFile();
  if (file && fs.existsSync(file)) {
    return ["--cookies", file];
  }

  return [];
}

function runCommand(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, { shell: false });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timeout: ${stderr || stdout}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
      }
    });
  });
}

function getFormatByQuality(quality) {
  const q = String(quality || "720");

  if (q === "360") {
    return "best[height<=360][vcodec!=none][acodec!=none]/18/best[vcodec!=none][acodec!=none]";
  }

  if (q === "480") {
    return "best[height<=480][vcodec!=none][acodec!=none]/18/best[vcodec!=none][acodec!=none]";
  }

  if (q === "1080") {
    return "best[height<=1080][vcodec!=none][acodec!=none]/22/best[vcodec!=none][acodec!=none]";
  }

  return "best[height<=720][vcodec!=none][acodec!=none]/22/18/best[vcodec!=none][acodec!=none]";
}

async function resolveYoutubeSource(youtubeUrl, quality) {
  const format = getFormatByQuality(quality);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    ...getCookiesArgs(),
    "-f",
    format,
    "-g",
    youtubeUrl,
  ];

  addLog("info", "Running yt-dlp with cookies support...");

  const out = await runCommand("yt-dlp", args, 90000);

  const lines = out
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("yt-dlp did not return a playable video source.");
  }

  return lines[0];
}

function parseFfmpegProgress(line) {
  const fpsMatch = line.match(/fps=\s*([0-9.]+)/i);
  if (fpsMatch) liveState.fps = Number(fpsMatch[1]) || 0;

  const brMatch = line.match(/bitrate=\s*([0-9.]+\s*kbits\/s)/i);
  if (brMatch) liveState.bitrate = brMatch[1].replace("kbits/s", "kbps");

  const dropMatch = line.match(/drop=\s*([0-9]+)/i);
  if (dropMatch) liveState.droppedFrames = Number(dropMatch[1]) || 0;
}

async function startFfmpegOnce(sourceUrl, streamKey, quality) {
  const height = String(quality || "720");

  const videoBitrate =
    height === "1080"
      ? "4500k"
      : height === "480"
      ? "1500k"
      : height === "360"
      ? "900k"
      : "2500k";

  const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

  const args = [
    "-hide_banner",
    "-loglevel",
    "info",

    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",

    "-re",
    "-i",
    sourceUrl,

    "-vf",
    `scale=-2:${height}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-g",
    "60",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    String(parseInt(videoBitrate) * 2) + "k",

    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",

    "-f",
    "flv",
    rtmpUrl,
  ];

  addLog("info", "FFmpeg started.");

  ffmpegProcess = spawn("ffmpeg", args, { shell: false });

  ffmpegProcess.stderr.on("data", (d) => {
    const text = d.toString();
    parseFfmpegProgress(text);

    const clean = text.trim();
    if (clean) addLog("ffmpeg", clean);
  });

  ffmpegProcess.stdout.on("data", (d) => {
    const clean = d.toString().trim();
    if (clean) addLog("ffmpeg", clean);
  });

  ffmpegProcess.on("error", (err) => {
    liveState.lastError = err.message;
    addLog("error", err.message);
  });

  ffmpegProcess.on("close", (code) => {
    addLog("info", `FFmpeg stopped with code ${code}.`);
    ffmpegProcess = null;

    if (stopRequested) {
      liveState.running = false;
      liveState.starting = false;
      liveState.stoppedAt = new Date().toISOString();
      return;
    }

    if (liveState.loop) {
      addLog("info", "Loop is ON. Restarting video...");

      restartTimer = setTimeout(() => {
        startLiveInternal({
          youtubeUrl: liveState.youtubeUrl,
          streamKey: liveState._streamKey,
          loop: liveState.loop,
          quality: liveState.quality,
          isRestart: true,
        }).catch((err) => {
          liveState.running = false;
          liveState.starting = false;
          liveState.lastError = err.message;
          addLog("error", err.message);
        });
      }, 3000);
    } else {
      liveState.running = false;
      liveState.starting = false;
      liveState.stoppedAt = new Date().toISOString();
    }
  });
}

async function startLiveInternal({ youtubeUrl, streamKey, loop, quality, isRestart = false }) {
  if (!isRestart && (liveState.running || liveState.starting)) {
    throw new Error("A live stream is already running.");
  }

  liveState.starting = true;
  liveState.lastError = "";
  stopRequested = false;

  if (!isRestart) {
    liveState.logs = [];
    liveState.fps = 0;
    liveState.bitrate = "0 kbps";
    liveState.droppedFrames = 0;
    liveState.startedAt = new Date().toISOString();
  }

  liveState.youtubeUrl = youtubeUrl;
  liveState._streamKey = streamKey;
  liveState.loop = !!loop;
  liveState.quality = String(quality || "720");

  setupCookiesFile();

  addLog("info", "Resolving YouTube video link...");
  const sourceUrl = await resolveYoutubeSource(youtubeUrl, quality);

  addLog("success", "Video source resolved. Starting live stream...");

  liveState.running = true;
  liveState.starting = false;

  await startFfmpegOnce(sourceUrl, streamKey, quality);
}

function stopLive() {
  stopRequested = true;
  liveState.loop = false;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (ffmpegProcess) {
    addLog("info", "Stop requested. Closing FFmpeg...");
    ffmpegProcess.kill("SIGTERM");

    setTimeout(() => {
      if (ffmpegProcess) {
        ffmpegProcess.kill("SIGKILL");
      }
    }, 5000);
  } else {
    liveState.running = false;
    liveState.starting = false;
    liveState.stoppedAt = new Date().toISOString();
  }
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username === PANEL_USER && password === PANEL_PASS) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }

  return res.status(401).json({ ok: false, error: "Wrong username or password" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ ok: true, loggedIn: !!(req.session && req.session.loggedIn) });
});

app.post("/api/start", isLoggedIn, async (req, res) => {
  try {
    const { youtubeUrl, streamKey, loop = true, quality = "720" } = req.body || {};

    if (!youtubeUrl || !isValidYoutubeUrl(youtubeUrl)) {
      return res.status(400).json({
        ok: false,
        error: "Only YouTube video links are allowed.",
      });
    }

    if (!streamKey || String(streamKey).trim().length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Valid YouTube stream key required.",
      });
    }

    await startLiveInternal({
      youtubeUrl: String(youtubeUrl).trim(),
      streamKey: String(streamKey).trim(),
      loop: !!loop,
      quality: String(quality || "720"),
    });

    return res.json({ ok: true, message: "Live started" });
  } catch (err) {
    liveState.running = false;
    liveState.starting = false;
    liveState.lastError = err.message;
    addLog("error", err.message);

    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.post("/api/stop", isLoggedIn, (req, res) => {
  stopLive();
  res.json({ ok: true, message: "Stopping live stream..." });
});

app.get("/api/status", isLoggedIn, (req, res) => {
  const safeState = { ...liveState };
  delete safeState._streamKey;

  res.json({ ok: true, state: safeState });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

setupCookiesFile();

app.listen(PORT, () => {
  console.log(`YT Live Link Panel running on port ${PORT}`);
});

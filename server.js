const express = require("express");
const session = require("express-session");
const { spawn } = require("child_process");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASS = process.env.PANEL_PASS || "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-on-railway";

app.use(express.json({ limit: "1mb" }));
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

let liveState = {
  running: false,
  starting: false,
  youtubeUrl: "",
  streamTitle: "",
  loop: true,
  quality: "720",
  startedAt: null,
  stoppedAt: null,
  lastError: "",
  logs: [],
  droppedFrames: 0,
  fps: 0,
  bitrate: "0 kbps",
};

let ffmpegProcess = null;
let stopRequested = false;
let restartTimer = null;

function nowISO() {
  return new Date().toISOString();
}

function addLog(type, message) {
  const item = {
    time: nowISO(),
    type,
    message: String(message || "").slice(0, 600),
  };
  liveState.logs.unshift(item);
  liveState.logs = liveState.logs.slice(0, 80);
}

function isLoggedIn(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

function isValidYoutubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const allowedHosts = [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "music.youtube.com",
    ];
    return allowedHosts.includes(host);
  } catch {
    return false;
  }
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "********";
  return key.slice(0, 4) + "..." + key.slice(-4);
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

function runCommand(command, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { shell: false });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timeout: ${stderr || stdout}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

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

async function resolveYoutubeSource(youtubeUrl, quality) {
  const format = getFormatByQuality(quality);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--force-ipv4",
    "-f",
    format,
    "-g",
    youtubeUrl,
  ];

  const out = await runCommand("yt-dlp", args, 60000);
  const lines = out
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("yt-dlp did not return a playable source.");
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
    height === "1080" ? "4500k" :
    height === "480" ? "1500k" :
    height === "360" ? "900k" :
    "2500k";

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
      liveState.stoppedAt = nowISO();
      return;
    }

    if (liveState.loop) {
      addLog("info", "Loop is ON. Restarting video source...");
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
      liveState.stoppedAt = nowISO();
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
    liveState.startedAt = nowISO();
  }

  liveState.youtubeUrl = youtubeUrl;
  liveState._streamKey = streamKey;
  liveState.loop = !!loop;
  liveState.quality = String(quality || "720");
  liveState.streamTitle = "YouTube Link Live";

  addLog("info", "Resolving YouTube video link...");
  const sourceUrl = await resolveYoutubeSource(youtubeUrl, quality);
  addLog("success", "Video source resolved. Starting live...");

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
    liveState.stoppedAt = nowISO();
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
      return res.status(400).json({ ok: false, error: "Only YouTube video links are allowed." });
    }

    if (!streamKey || String(streamKey).trim().length < 8) {
      return res.status(400).json({ ok: false, error: "Valid YouTube stream key required." });
    }

    await startLiveInternal({
      youtubeUrl: String(youtubeUrl).trim(),
      streamKey: String(streamKey).trim(),
      loop: !!loop,
      quality: String(quality || "720"),
    });

    return res.json({
      ok: true,
      message: "Live started",
      streamKey: maskKey(streamKey),
    });
  } catch (err) {
    liveState.running = false;
    liveState.starting = false;
    liveState.lastError = err.message;
    addLog("error", err.message);
    return res.status(500).json({ ok: false, error: err.message });
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

app.listen(PORT, () => {
  console.log(`YT Live Link Panel running on port ${PORT}`);
});

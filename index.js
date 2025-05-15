import http from "http";
import { spawn } from "child_process";
import { Server as SocketIO } from "socket.io";
import { config } from "dotenv";

config();

const PORT = process.env.PORT || 3010;
const server = http.createServer();
const io = new SocketIO(server);

const rtmpBaseUrl = process.env.RTMP_BASE_URL || "rtmp://localhost/live";

// Maps streamKey -> ffmpeg process
const ffmpegProcesses = new Map();
// Maps streamKey -> Set of socket IDs
const viewerMap = new Map();

// Start FFmpeg for a specific streamKey
const startFFmpeg = (streamKey) => {
  const rtmpUrl = `${rtmpBaseUrl}/${streamKey}`;
  const options = [
    "-i", "-",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-r", "25",
    "-g", "50",
    "-keyint_min", "25",
    "-crf", "25",
    "-pix_fmt", "yuv420p",
    "-sc_threshold", "0",
    "-profile:v", "main",
    "-level", "3.1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "32000",
    "-f", "flv",
    rtmpUrl,
  ];

  const ffmpegProcess = spawn("ffmpeg", options);
  ffmpegProcesses.set(streamKey, ffmpegProcess);

  ffmpegProcess.stdout.on("data", data => {
    console.log(`[${streamKey}] ffmpeg stdout: ${data}`);
  });

  ffmpegProcess.stderr.on("data", data => {
    console.error(`[${streamKey}] ffmpeg stderr: ${data}`);
  });

  ffmpegProcess.on("close", code => {
    console.log(`[${streamKey}] FFmpeg exited with code ${code}`);
    ffmpegProcesses.delete(streamKey);
  });

  console.log(`[${streamKey}] FFmpeg process started`);
};

// Stop FFmpeg for a specific streamKey
const stopFFmpeg = (streamKey) => {
  const process = ffmpegProcesses.get(streamKey);
  if (process) {
    process.stdin.end();
    process.kill("SIGTERM");
    ffmpegProcesses.delete(streamKey);
    console.log(`[${streamKey}] FFmpeg process stopped`);
  }
};

// Socket.IO handlers
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("binarystream", ({ streamKey, chunk }) => {
    if (!streamKey || !chunk) {
      return console.error("Missing streamKey or chunk");
    }

    let ffmpegProcess = ffmpegProcesses.get(streamKey);
    if (!ffmpegProcess) {
      console.log(`[${streamKey}] Starting FFmpeg...`);
      startFFmpeg(streamKey);
      ffmpegProcess = ffmpegProcesses.get(streamKey);
    }

    ffmpegProcess.stdin.write(chunk, (err) => {
      if (err) console.error(`[${streamKey}] Error writing to FFmpeg stdin:`, err);
    });
  });

  socket.on("stop-stream", ({ streamKey }) => {
    if (!streamKey) return;
    stopFFmpeg(streamKey);
    socket.emit("stream-stopped", { streamKey });
  });

  socket.on("viewer-joined", ({ streamKey }) => {
    if (!viewerMap.has(streamKey)) viewerMap.set(streamKey, new Set());
    viewerMap.get(streamKey).add(socket.id);
    emitViewerCount(streamKey);
  });

  socket.on("viewer-left", ({ streamKey }) => {
    viewerMap.get(streamKey)?.delete(socket.id);
    emitViewerCount(streamKey);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    for (const [streamKey, viewers] of viewerMap.entries()) {
      if (viewers.delete(socket.id)) {
        emitViewerCount(streamKey);
      }
    }
  });

  function emitViewerCount(streamKey) {
    const count = viewerMap.get(streamKey)?.size || 0;
    io.emit("viewer-count", { streamKey, count });
  }
});

server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

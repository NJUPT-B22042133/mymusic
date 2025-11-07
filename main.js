const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const mm = require("music-metadata");
const NodeID3 = require("node-id3");
const { autoUpdater } = require("electron-updater");

// 禁用自动下载（可选，默认是 true）
autoUpdater.forceDevUpdateConfig = true;
autoUpdater.autoDownload = true;

// 日志（可选）
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";

let mainWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false, // 允许本地文件访问
    },
    icon: path.join(__dirname, "assets/icons/app.png"),
    titleBarStyle: "hiddenInset",
    show: false,
  });

  mainWindow.loadFile("index.html");

  // 窗口准备完成后显示
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // 开发模式下打开开发者工具
  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
};

// 创建菜单
const createMenu = () => {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "导入音乐文件",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            mainWindow.webContents.send("menu-import-files");
          },
        },
        {
          label: "导入音乐文件夹",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            mainWindow.webContents.send("menu-import-folder");
          },
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: "播放",
      submenu: [
        {
          label: "播放/暂停",
          accelerator: "Space",
          click: () => {
            mainWindow.webContents.send("menu-toggle-play");
          },
        },
        {
          label: "上一曲",
          accelerator: "Left",
          click: () => {
            mainWindow.webContents.send("menu-previous");
          },
        },
        {
          label: "下一曲",
          accelerator: "Right",
          click: () => {
            mainWindow.webContents.send("menu-next");
          },
        },
      ],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "切换全屏",
          accelerator: process.platform === "darwin" ? "Ctrl+Cmd+F" : "F11",
          click: () => {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
          },
        },
        { type: "separator" },
        {
          label: "开发者工具",
          accelerator:
            process.platform === "darwin" ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => {
            mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

app.whenReady().then(() => {
  createWindow();
  createMenu();
  // 检查更新
  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on("update-available", () => {
  console.log("有新版本可用");
});

autoUpdater.on("update-downloaded", (info) => {
  console.log("更新已下载", info);
  // 可以弹窗提示用户重启应用
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC 处理器
ipcMain.handle("select-music-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "音频文件",
        extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"],
      },
    ],
  });
  return result;
});

ipcMain.handle("select-music-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result;
});

ipcMain.handle("read-music-files-from-folder", async (event, folderPath) => {
  const audioExtensions = [
    ".mp3",
    ".wav",
    ".flac",
    ".aac",
    ".m4a",
    ".ogg",
    ".wma",
  ];
  const musicFiles = [];

  const scanFolder = (dir) => {
    try {
      const files = fs.readdirSync(dir);
      files.forEach((file) => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanFolder(fullPath); // 递归扫描子文件夹
        } else if (audioExtensions.includes(path.extname(file).toLowerCase())) {
          musicFiles.push(fullPath);
        }
      });
    } catch (error) {
      console.error("扫描文件夹错误:", error);
    }
  };

  scanFolder(folderPath);
  return musicFiles;
});

ipcMain.handle("get-file-stats", async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      mtime: stats.mtime,
      exists: true,
    };
  } catch (error) {
    return { exists: false };
  }
});

// HTTP请求辅助函数
function makeHttpRequest(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const request = lib.get(url, (response) => {
      if (response.statusCode < 200 || response.statusCode > 299) {
        reject(new Error("HTTP Status Code: " + response.statusCode));
        return;
      }

      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => {
        try {
          const responseBody = Buffer.concat(body).toString();
          resolve(responseBody);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", (error) => reject(error));
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

// 搜索歌曲ID
ipcMain.handle("search-song-id", async (event, songName, artistName = "") => {
  try {
    console.log("搜索歌曲:", songName, artistName);

    // 构建搜索查询
    const searchQuery = artistName ? `${artistName} ${songName}` : songName;
    const encodedQuery = encodeURIComponent(searchQuery);

    // 网易云音乐搜索API
    const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=hlpretag=&hlposttag=&s=${encodedQuery}&type=1&offset=0&total=true&limit=10`;

    console.log("搜索URL:", searchUrl);

    const response = await makeHttpRequest(searchUrl);
    const data = JSON.parse(response);

    if (
      data.code === 200 &&
      data.result &&
      data.result.songs &&
      data.result.songs.length > 0
    ) {
      const firstSong = data.result.songs[0];
      console.log("找到歌曲:", firstSong.name, "ID:", firstSong.id);

      return {
        success: true,
        songId: firstSong.id,
        songName: firstSong.name,
        artistName: firstSong.artists.map((a) => a.name).join(", "),
        albumName: firstSong.album.name,
        duration: firstSong.duration,
      };
    } else {
      console.log("未找到歌曲");
      return {
        success: false,
        error: "未找到匹配的歌曲",
      };
    }
  } catch (error) {
    console.error("搜索歌曲ID失败:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// 获取歌词
ipcMain.handle("fetch-lyrics", async (event, songId) => {
  try {
    console.log("获取歌词, 歌曲ID:", songId);

    const lyricsUrl = `https://music.163.com/api/song/lyric?os=pc&id=${songId}&lv=-1`;
    console.log("歌词URL:", lyricsUrl);

    const response = await makeHttpRequest(lyricsUrl);
    const data = JSON.parse(response);

    if (data.code === 200 && data.lrc && data.lrc.lyric) {
      console.log("成功获取歌词");
      return {
        success: true,
        lyrics: data.lrc.lyric,
        translatedLyrics: data.tlyric ? data.tlyric.lyric : null,
      };
    } else {
      console.log("歌词数据无效");
      return {
        success: false,
        error: "歌词数据无效或不可用",
      };
    }
  } catch (error) {
    console.error("获取歌词失败:", error);
    return {
      success: false,
      error: error.message,
    };
  }
});

// 自动搜索并获取歌词 (组合功能)
ipcMain.handle(
  "auto-search-lyrics",
  async (event, songName, artistName = "") => {
    try {
      console.log("自动搜索歌词:", songName, artistName);

      // 第一步: 搜索歌曲ID
      const searchQuery = songName;
      const encodedQuery = encodeURIComponent(searchQuery);
      const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=hlpretag=&hlposttag=&s=${encodedQuery}&type=1&offset=0&total=true&limit=10`;

      console.log("搜索URL:", searchUrl);
      const searchResponse = await makeHttpRequest(searchUrl);
      const searchData = JSON.parse(searchResponse);

      if (
        searchData.code !== 200 ||
        !searchData.result ||
        !searchData.result.songs ||
        searchData.result.songs.length === 0
      ) {
        return {
          success: false,
          error: "未找到匹配的歌曲",
        };
      }

      const firstSong = searchData.result.songs[0];
      console.log("找到歌曲:", firstSong.name, "ID:", firstSong.id);

      // 第二步: 获取歌词
      const lyricsUrl = `https://music.163.com/api/song/lyric?os=pc&id=${firstSong.id}&lv=-1`;
      console.log("歌词URL:", lyricsUrl);

      const lyricsResponse = await makeHttpRequest(lyricsUrl);
      const lyricsData = JSON.parse(lyricsResponse);

      if (lyricsData.code !== 200 || !lyricsData.lrc || !lyricsData.lrc.lyric) {
        return {
          success: false,
          error: "歌词数据无效或不可用",
        };
      }

      // 返回完整信息
      return {
        success: true,
        songInfo: {
          id: firstSong.id,
          name: firstSong.name,
          artist: firstSong.artists.map((a) => a.name).join(", "),
          album: firstSong.album.name,
          duration: firstSong.duration,
        },
        lyrics: lyricsData.lrc.lyric,
        translatedLyrics: lyricsData.tlyric ? lyricsData.tlyric.lyric : null,
      };
    } catch (error) {
      console.error("自动搜索歌词失败:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
);

// 读取音乐文件元数据
ipcMain.handle("read-music-metadata", async (event, filePath) => {
  try {
    // 使用 music-metadata 库读取元数据
    const metadata = await mm.parseFile(filePath);

    // 提取封面图片
    let albumArt = null;
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const picture = metadata.common.picture[0];
      // 将图片数据转换为 base64
      albumArt = {
        format: picture.format,
        data: `data:${picture.format};base64,${picture.data.toString(
          "base64"
        )}`,
      };
    }

    // 格式化持续时间（秒）
    const duration = metadata.format.duration || 0;

    // 返回解析后的元数据
    return {
      success: true,
      metadata: {
        title: metadata.common.title || null,
        artist: metadata.common.artist || null,
        album: metadata.common.album || null,
        albumartist:
          metadata.common.albumartist || metadata.common.artist || null,
        year: metadata.common.year || null,
        genre:
          metadata.common.genre && metadata.common.genre.length > 0
            ? metadata.common.genre[0]
            : null,
        track: metadata.common.track ? metadata.common.track.no : null,
        trackTotal: metadata.common.track ? metadata.common.track.of : null,
        disc: metadata.common.disk ? metadata.common.disk.no : null,
        discTotal: metadata.common.disk ? metadata.common.disk.of : null,
        duration: Math.round(duration),
        bitrate: metadata.format.bitrate || null,
        sampleRate: metadata.format.sampleRate || null,
        codec: metadata.format.codec || null,
        container: metadata.format.container || null,
        albumArt: albumArt,
        comment: metadata.common.comment ? metadata.common.comment[0] : null,
        composer: metadata.common.composer ? metadata.common.composer[0] : null,
        lyrics: metadata.common.lyrics ? metadata.common.lyrics[0] : null,
      },
    };
  } catch (error) {
    console.error("读取音乐元数据失败:", filePath, error);
    return {
      success: false,
      error: error.message,
    };
  }
});

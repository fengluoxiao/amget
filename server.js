const express = require('express');
const path = require('path');
const playwright = require('playwright'); // 引入 playwright
const { findAppleMusicInfo } = require('./lib/getinfo'); // 导入我们的抓取函数

const app = express();
const port = process.env.PORT || 3000;

let globalBrowser = null;
let globalPage = null;

// 初始化 Playwright 浏览器和页面实例
async function startPlaywrightBrowser() {
    if (globalPage && !globalPage.isClosed()) {
        console.log("Playwright page 已存在且可用。");
        return globalPage;
    }
    if (globalBrowser) {
        console.log("旧的 Playwright browser 存在，正在关闭...");
        try {
            await globalBrowser.close();
        } catch (e) {
            console.warn("关闭旧浏览器实例时出错: ", e.message);
        }
        globalBrowser = null;
        globalPage = null;
    }

    console.log("正在初始化 Playwright 浏览器实例 (server.js)..." );
    try {
        globalBrowser = await playwright.chromium.launch({
            // headless: false, //调试时可以取消注释
        });
        const context = await globalBrowser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            javaScriptEnabled: true,
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
            }
        });
        globalPage = await context.newPage();
        console.log("Playwright 浏览器和页面实例已在 server.js 中成功初始化。");
        return globalPage;
    } catch (error) {
        console.error("在 server.js 中初始化 Playwright 浏览器实例失败:", error);
        globalBrowser = null;
        globalPage = null;
        throw error; //抛出错误，以便服务器启动时能感知到问题
    }
}

// 优雅关闭浏览器
async function closePlaywrightBrowser() {
    if (globalBrowser) {
        console.log("正在关闭服务器控制的 Playwright 浏览器实例...");
        try {
            await globalBrowser.close();
            console.log("服务器控制的 Playwright 浏览器实例已关闭。");
        } catch (e) {
            console.error("关闭服务器控制的 Playwright 浏览器时出错:", e);
        }
        globalBrowser = null;
        globalPage = null;
    }
}

// 提供 public 目录下的静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // 用于解析JSON请求体 (如果将来需要POST请求)

// API 端点，用于从前端接收搜索请求
app.get('/api/search', async (req, res) => {
    const searchTerm = req.query.term;
    const storefront = req.query.storefront || 'cn';
    const searchTypeFromQuery = req.query.type; // Read the 'type' parameter
    const actualSearchType = searchTypeFromQuery || 'song'; // Default to 'song' if not provided
    const albumFilterFromQuery = req.query.albumFilter; // Read albumFilter
    const actualAlbumFilter = albumFilterFromQuery || 'albumPriority'; // Default if not provided

    if (!searchTerm) {
        return res.status(400).json({ error: '搜索词不能为空' });
    }
    // Updated log to include actualAlbumFilter if searchType is album
    let logMessage = `服务器收到搜索请求: ${searchTerm}, 区域: ${storefront}, 类型: ${actualSearchType}`;
    if (actualSearchType === 'album') {
        logMessage += `, 专辑筛选: ${actualAlbumFilter}`;
    }
    console.log(logMessage);

    if (!globalPage || globalPage.isClosed()) {
        console.error("Playwright 页面不可用。可能初始化失败或已关闭。尝试重新初始化...");
        try {
            await startPlaywrightBrowser();
            if (!globalPage || globalPage.isClosed()) {
                return res.status(503).json({ error: '浏览器服务暂时不可用，请稍后再试。' });
            }
        } catch (initError) {
            console.error("尝试重新初始化 Playwright 失败:", initError);
            return res.status(503).json({ error: '浏览器服务初始化失败，请联系管理员。' });
        }
    }

    try {
        // 将 globalPage, actualSearchType, 和 actualAlbumFilter 传递给 findAppleMusicInfo
        const resultsArray = await findAppleMusicInfo(globalPage, searchTerm, storefront, actualSearchType, actualAlbumFilter);
        
        // --- 增加详细日志 ---
        console.log("getinfo.js 返回的原始值 (resultsArray):", resultsArray);
        console.log("typeof resultsArray:", typeof resultsArray);
        if (Array.isArray(resultsArray)) {
            console.log("resultsArray.length:", resultsArray.length);
            if (resultsArray.length > 0) {
                console.log("resultsArray[0]:", resultsArray[0]);
            }
        }
        // --- 日志结束 ---

        if (Array.isArray(resultsArray) && resultsArray.length > 0 && resultsArray[0] && resultsArray[0].error) {
            console.error("getinfo.js 返回错误:", resultsArray[0].error);
            return res.status(resultsArray[0].status || 500).json({ error: resultsArray[0].error });
        }

        if (!Array.isArray(resultsArray) || resultsArray.length === 0) {
            console.log("getinfo.js 未返回任何有效结果 (基于数组检查)。");
            return res.status(404).json({ error: '未能找到相关信息。请尝试其他搜索词。', results: [] });
        }
        
        console.log(`服务器准备发送 ${resultsArray.length} 个成功结果。`);
        return res.json({ results: resultsArray });

    } catch (error) {
        console.error('服务器 API 端点 (/api/search) 发生严重错误:', error);
        res.status(500).json({ error: '服务器内部错误。' });
    }
});

// 对于所有其他GET请求，返回 index.html，以便 Vue Router 可以处理 (如果使用Vue Router)
// 对于这个简单示例，我们直接让 / 指向 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务器并初始化浏览器
async function startServer() {
    try {
        await startPlaywrightBrowser(); // 在服务器监听前启动浏览器
        app.listen(port, () => {
            console.log(`服务器正在监听端口 http://localhost:${port}`);
        });
    } catch (error) {
        console.error("未能启动服务器或 Playwright 浏览器:", error);
        process.exit(1); // 如果浏览器启动失败，则退出服务器
    }
}

startServer();

// 监听退出信号，确保浏览器被关闭
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, async () => {
        console.log(`收到 ${signal} 信号，准备关闭浏览器并退出...`);
        await closePlaywrightBrowser();
        process.exit(0);
    });
});
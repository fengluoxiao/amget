# Apple Music 信息获取与杜比全景声查询工具

本项目是一个用于查询 Apple Music 曲目和专辑信息的工具，特别关注杜比全景声 (Dolby Atmos) 和空间音频 (Spatial Audio) 的可用性。它通过抓取 Apple Music 网页版搜索结果页面并调用内部 AMP API 来获取详细数据。

## 主要功能

*   根据歌曲或专辑名称进行搜索。
*   区分搜索类型：歌曲 (song) 或专辑 (album)。
*   当搜索专辑时，支持两种筛选模式：
    *   `albumPriority`: 优先显示本身支持杜比全景声的专辑（同时专辑内需包含匹配的杜比曲目）。
    *   `songPriority`: 优先显示包含杜比全景声歌曲的专辑（即使专辑本身可能不标记为杜比，返回的曲目列表会筛选为符合条件的杜比歌曲）。
*   提取丰富的元数据，包括：
    *   基本信息：名称、艺人、发行日期、专辑封面。
    *   音频特性：如 `atmos`, `lossless`, `spatialAudio` 等。
    *   歌曲详情：时长、ISRC、作曲家、制作人、作词人。
    *   专辑详情：曲目数、UPC、曲目列表（包含各曲目的杜比支持状态和音频特性）。
*   支持指定 Apple Music 店面区域 (storefront) 进行搜索。

## 目前缺陷

尽管本工具努力提供准确和全面的信息，但目前仍存在一些已知的局限性：

1.  **搜索结果可能不完整**: 由于工具基于 Apple Music 中国大陆地区的公开网页版搜索结果进行数据抓取，相较于通过付费账户访问或使用官方 API，可获取的结果范围和完整性可能会受到限制。
2.  **暂不支持按艺人直接搜索**: 当前的搜索功能主要针对歌曲或专辑名称。直接通过艺人名称进行精确搜索并期望返回该艺人的所有作品列表的功能尚未实现。

## API 使用说明

可以通过本地运行的服务器提供的 API 端点来获取信息。

**基础 URL:** `http://localhost:PORT` (请将 `PORT` 替换为您服务器运行时实际监听的端口号，例如 `3000`)

### 端点: `GET /api/search`

此端点用于执行搜索并获取结果。

**请求方法:** `GET`

**查询参数:**

*   `term` (string, **必需**): 您要搜索的歌曲或专辑的名称。请确保进行 URL 编码，例如空格应替换为 `%20`。
*   `type` (string, 可选, 默认值: `song`): 指定搜索类型。
    *   `song`: 搜索歌曲。
    *   `album`: 搜索专辑。
*   `storefront` (string, 可选, 默认值: `cn`): 指定 Apple Music 的店面区域代码，例如:
    *   `cn`: 中国大陆
    *   `us`: 美国
    *   `gb`: 英国
    *   `jp`: 日本
*   `albumFilter` (string, 可选, 默认值: `albumPriority`): 仅当 `type` 为 `album` 时生效。
    *   `albumPriority`: 优先返回专辑本身支持杜比全景声，并且其包含的曲目中至少有一首与搜索词匹配且支持杜比。
    *   `songPriority`: 返回包含与搜索词匹配且支持杜比全景声的曲目的专辑。专辑的 `tracksDetails` 列表将只包含这些符合条件的杜比歌曲。

**请求示例:**

1.  搜索歌曲 "忘记你我做不到" (中国店面):
    ```
    http://localhost:3000/api/search?term=%E5%BF%98%E8%AE%B0%E4%BD%A0%E6%88%91%E5%81%9A%E4%B8%8D%E5%88%B0&type=song&storefront=cn
    ```

2.  搜索专辑 "Dangerous Woman"，筛选模式为 `songPriority` (美国店面):
    ```
    http://localhost:3000/api/search?term=Dangerous%20Woman&type=album&storefront=us&albumFilter=songPriority
    ```

**响应格式:**

API 会返回一个 JSON 数组，其中包含找到的匹配项。每个匹配项是一个对象，其结构会根据是歌曲还是专辑有所不同，但通常会包含 `id`, `type`, `name`, `artistName`, `artworkUrl`, `supportsDolbyAtmos`, `audioTraits` 等字段。

*   如果发生错误，将返回包含 `error` 和 `status` 字段的 JSON 对象数组，例如：
    ```json
    [
      {
        "error": "未能获取认证 Token，无法继续调用 AMP API。",
        "status": 500
      }
    ]
    ```
*   如果成功但未找到结果，可能返回空数组或特定的无结果消息（具体取决于服务器实现）。
*   成功的歌曲结果示例:
    ```json
    [
      {
        "id": "1591607889",
        "type": "song",
        "name": "positions",
        "artistName": "Ariana Grande",
        "releaseDate": "2020-10-23",
        "artworkUrl": "...",
        "supportsDolbyAtmos": true,
        "audioTraits": ["atmos", "lossless", "lossy-stereo"],
        "albumName": "Positions (Deluxe Edition)",
        "albumId": "1591607888",
        // ... 其他歌曲特有字段
      }
    ]
    ```
*   成功的专辑结果示例 (`songPriority`):
    ```json
    [
      {
        "id": "1591607888",
        "type": "album",
        "name": "Positions (Deluxe Edition)",
        "artistName": "Ariana Grande",
        "releaseDate": "2020-10-30",
        "artworkUrl": "...",
        "supportsDolbyAtmos": true, // 专辑本身是否标记为杜比
        "audioTraits": ["atmos", "lossless"],
        "trackCount": 19, // 专辑原始总曲目数
        "tracksDetails": [ // 经过 songPriority 筛选后的曲目列表
          {
            "id": "1591607889",
            "name": "positions",
            "supportsDolbyAtmos": true,
            "audioTraitsTrack": ["atmos", "lossless", "lossy-stereo"],
            // ... 其他轨道信息
          }
        ],
        "albumFilterApplied": "songPriority"
        // ... 其他专辑特有字段
      }
    ]
    ```

## 致敬与参考

本项目的开发受到以下优秀项目和资源的启发和/或参考了其部分实现：

*   [https://github.com/lisonge/vite-plugin-monkey](https://github.com/lisonge/vite-plugin-monkey)
*   [https://github.com/chocolateboy/gm-compat](https://github.com/chocolateboy/gm-compat)
*   [https://gist.github.com/bunnykek/7f099f55fc558f398cb4cedf6c02c794](https://gist.github.com/bunnykek/7f099f55fc558f398cb4cedf6c02c794)
*   [https://github.com/ToadKing/apple-music-barcode-isrc](https://github.com/ToadKing/apple-music-barcode-isrc)
*   [https://github.com/ROpdebee/mb-userscripts/blob/main/mb_bulk_copy_work_codes.user.js](https://github.com/ROpdebee/mb-userscripts/blob/main/mb_bulk_copy_work_codes.user.js)
*   [https://github.com/voxatmos/ame-atmos](https://github.com/voxatmos/ame-atmos)

## 主题色彩蛋

细心的你可能已经发现，项目中部分元素的配色方案有所不同。
这其实是一个小小的彩蛋，用以致敬我喜爱的作品：

*   <div style="display:inline-block; width:15px; height:15px; background-color:#3388bb; border:1px solid #ccc; margin-right:5px; vertical-align:middle;"></div> 颜色 `#3388bb` (一种蓝/青色) 代表 **It's MyGO!!!!!**
*   <div style="display:inline-block; width:15px; height:15px; background-color:#881144; border:1px solid #ccc; margin-right:5px; vertical-align:middle;"></div> 颜色 `#881144` (一种洋红色) 代表 **Ave Mujica**

希望这个小细节能给你带来一丝乐趣！ 
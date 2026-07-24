// const playwright = require('playwright'); // Playwright 实例将由 server.js 传入

// --- Playwright Singleton 相关代码已移除 ---
// getPlaywrightPage, closeBrowser, 及相关 process.on 监听器已删除

// 从 ame-atmos/src/applemusic/services/auth.ts 学习到的 token 提取逻辑
// 该函数现在接收一个 page 对象作为参数
async function getAuthTokenFromPage(page) { // page 参数已添加
    console.log("尝试从页面中提取认证 Token (getinfo.js)...");
    try {
        // 确保 page 对象有效
        if (!page || page.isClosed()) {
            console.error("错误: 传入的 Playwright page 对象无效或已关闭 (getAuthTokenFromPage)。");
            return null;
        }
        const scriptElement = await page.locator("script[type='module']").first();
        // 增加对scriptElement是否存在的检查
        if ((await scriptElement.count()) === 0) {
            console.error("错误: 未能找到 <script type='module'> 元素。");
            return null;
        }
        const scriptSrc = await scriptElement.getAttribute('src');
        if (!scriptSrc) {
            console.error("错误: <script type='module'> 元素没有 src 属性。");
            return null;
        }

        console.log(`找到潜在的 JS 文件源: ${scriptSrc}`);
        const fullScriptUrl = scriptSrc.startsWith('http') ? scriptSrc : new URL(scriptSrc, page.url()).toString();
        
        const response = await page.request.get(fullScriptUrl);
        if (!response.ok()) {
            console.error(`错误: 下载 JS 文件失败，状态码: ${response.status()}`);
            return null;
        }
        const body = await response.text();

        const matches = body.match(/eyJ0eXAiOiJKV1Qi[A-Za-z0-9_.-]+/g);
        // 优先取 kid 为 WebPlayKid 的开发者令牌（kid 字段 base64 后的特征子串为 dlYlBsYXlLaWQ）
        const match = matches && (matches.find(t => t.includes('dlYlBsYXlLaWQ')) || matches[0]);
        if (!match) {
            console.error("错误: 未能在 JS 文件内容中找到认证 Token。");
            return null;
        }
        console.log("成功提取到认证 Token。");
        return match;
    } catch (error) {
        console.error("提取认证 Token 时发生错误:", error);
        return null;
    }
}

// 主要的搜索和信息提取函数
// 该函数现在接收一个 page 对象作为其第一个参数
async function findAppleMusicInfo(page, searchTerm, storefront = "cn", searchType = "song", albumFilter = "albumPriority", artistOffset = 0) { // page 参数已添加, albumFilter 参数已添加
    console.log(`[getinfo.js] findAppleMusicInfo CALLED - Term: "${searchTerm}", Store: "${storefront}", Type: "${searchType}", AlbumFilter: "${albumFilter}", ArtistOffset: ${artistOffset}`);
    const searchTermEncoded = encodeURIComponent(searchTerm);
    const searchUrl = `https://music.apple.com/${storefront}/search?term=${searchTermEncoded}`;
    console.log(`正在请求 (getinfo.js): ${searchUrl} 使用传入的 page 对象`);

    try {
        // const page = await getPlaywrightPage(); // 旧逻辑：获取单例页面实例。现在 page 从参数传入
        // 确保传入的 page 对象有效
        if (!page || page.isClosed()) {
            console.error("错误: 传入的 Playwright page 对象无效或已关闭 (findAppleMusicInfo)。");
            return [{ error: "浏览器页面服务不可用，请稍后重试。", status: 503 }];
        }
        
        // Navigate to the search page
        // 说明：music.apple.com 是 SPA，页面自身的前端跳转会打断导航（ERR_ABORTED），
        // 且后台请求不断导致 networkidle 可能永不触发。因此改用 domcontentloaded +
        // 可选的 networkidle 等待，失败时重试一次；ERR_ABORTED 时若页面已有内容则视为成功。
        let navError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`导航到页面 (getinfo.js): ${searchUrl} (第 ${attempt} 次尝试)`);
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                navError = null;
                break;
            } catch (e) {
                navError = e;
                console.error(`导航到 ${searchUrl} 失败 (第 ${attempt} 次, getinfo.js):`, e.message);
                if (e.message.includes('ERR_ABORTED')) {
                    const html = await page.content().catch(() => '');
                    if (html && html.length > 10000) {
                        console.log('导航被中断但页面内容已加载，继续处理。');
                        navError = null;
                        break;
                    }
                }
            }
        }
        if (navError) {
            return [{ error: `页面导航失败 (getinfo.js): ${navError.message}. 请检查网络或目标站点状态。`, status: 503 }];
        }

        const authToken = await getAuthTokenFromPage(page); // 传递 page 对象
        if (!authToken) {
            return [{ error: "未能获取认证 Token，无法继续调用 AMP API。", status: 500 }];
        }

        // 艺人搜索：直接通过 AMP API 搜索艺人并筛选其支持杜比全景声的专辑
        if (searchType === "artist") {
            return await findArtistAtmosAlbums(page, authToken, searchTerm, storefront, artistOffset);
        }

        // 歌曲/专辑搜索：通过 AMP 搜索 API 分页获取并筛选杜比全景声结果
        return await searchCatalogPaged(page, authToken, searchTerm, storefront, searchType, albumFilter, artistOffset);

    } catch (error) {
        console.error(`findAppleMusicInfo 顶层错误 (getinfo.js): ${error.message}`, error.stack);
        // 不再处理 browserReady, pageInstance, browserInstance，因为它们不再由此文件管理
        // if (error.message.toLowerCase().includes('playwright') || error.message.toLowerCase().includes('navigation')){
        //     browserReady = false; 
        //     pageInstance = null; 
        //     // browserInstance = null; 
        // }
        return [{ error: `处理时发生内部错误 (getinfo.js): ${error.message}`, status: 500 }];
    } finally {
        //不再在每次调用后关闭浏览器，也不在此处管理浏览器生命周期
        console.log("findAppleMusicInfo 调用结束 (getinfo.js)。");
    }
}

// module.exports = { findAppleMusicInfo, closeBrowser }; // closeBrowser 不再由此文件导出
module.exports = { findAppleMusicInfo };

// 艺人搜索流程：搜索艺人 -> 拉取其专辑 -> 筛选杜比全景声专辑 -> 获取曲目详情
// 分页说明：专辑列表完整拉取后按发行日期倒序排列，每页检查 ARTIST_PAGE_SIZE 张，
// 通过 offset 参数控制检查窗口，返回 pagination 信息供前端"加载更多"使用
const ARTIST_PAGE_SIZE = 10;
async function findArtistAtmosAlbums(page, authToken, searchTerm, storefront, offset = 0) {
    const headers = { 'Authorization': `Bearer ${authToken}`, 'Origin': 'https://music.apple.com' };
    const searchTermLower = searchTerm.toLowerCase();

    // 1. 搜索艺人
    const artistSearchUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/search?term=${encodeURIComponent(searchTerm)}&types=artists&limit=10&l=en-US`;
    console.log(`[getinfo.js] ARTIST SEARCH - 请求: ${artistSearchUrl}`);
    const artistSearchResp = await page.request.get(artistSearchUrl, { headers });
    if (!artistSearchResp.ok()) {
        return { error: `艺人搜索 API 请求失败: ${artistSearchResp.status()}`, status: 502 };
    }
    const artistSearchJson = await artistSearchResp.json();
    const artists = artistSearchJson.results?.artists?.data || [];
    if (artists.length === 0) {
        return { error: '未找到匹配的艺人，请尝试其他搜索词。', status: 404 };
    }

    // 优先选择名称包含搜索词的艺人，否则取第一个结果；最多处理 3 位艺人
    let matchedArtists = artists.filter(a => a.attributes?.name && a.attributes.name.toLowerCase().includes(searchTermLower));
    if (matchedArtists.length === 0) matchedArtists = [artists[0]];
    matchedArtists = matchedArtists.slice(0, 3);
    console.log(`[getinfo.js] ARTIST SEARCH - 匹配到艺人: ${matchedArtists.map(a => `${a.attributes.name}(${a.id})`).join(', ')}`);

    // 2. 拉取每位艺人的专辑（含单曲/EP，Apple Music 中均为 albums 资源）
    const seenAlbumIds = new Set();
    const albumResources = [];
    for (const artist of matchedArtists) {
        const artistAlbumsUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/artists/${artist.id}/albums?limit=100&l=en-US`;
        console.log(`[getinfo.js] ARTIST SEARCH - 拉取艺人专辑: ${artist.attributes.name} (${artist.id})`);
        const albumsResp = await page.request.get(artistAlbumsUrl, { headers });
        if (!albumsResp.ok()) {
            console.error(`[getinfo.js] ARTIST SEARCH - 拉取艺人专辑失败: ${albumsResp.status()} (艺人ID: ${artist.id})`);
            continue;
        }
        const albumsJson = await albumsResp.json();
        for (const album of (albumsJson.data || [])) {
            if (!seenAlbumIds.has(album.id)) {
                seenAlbumIds.add(album.id);
                albumResources.push(album);
            }
        }
    }
    console.log(`[getinfo.js] ARTIST SEARCH - 共获取 ${albumResources.length} 张专辑（去重后）`);
    if (albumResources.length === 0) {
        return { error: '未能获取该艺人的专辑列表。', status: 404 };
    }

    // 按发行日期倒序排列，优先展示最新专辑
    albumResources.sort((a, b) => {
        const da = a.attributes?.releaseDate || '';
        const db = b.attributes?.releaseDate || '';
        return db.localeCompare(da);
    });

    // 3. 列表接口的 audioTraits 不可靠（可能缺失或不完整），因此按分页窗口
    //    逐张获取完整数据进行杜比判定
    const totalAlbums = albumResources.length;
    const pageCandidates = albumResources.slice(offset, offset + ARTIST_PAGE_SIZE);
    const checkedCount = offset + pageCandidates.length;
    const pagination = {
        offset,
        pageSize: ARTIST_PAGE_SIZE,
        checked: checkedCount,
        total: totalAlbums,
        hasMore: checkedCount < totalAlbums
    };
    console.log(`[getinfo.js] ARTIST SEARCH - 分页: 本次检查第 ${offset + 1}-${checkedCount} 张 / 共 ${totalAlbums} 张`);

    // 4. 对本页候选专辑逐张获取完整信息（含曲目），确认杜比支持并构建结果
    const results = [];
    for (const candidate of pageCandidates) {
        let albumResource = candidate;
        // 需要曲目关系时，重新请求带 extend=tracks 的完整专辑数据
        const albumDetailUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${candidate.id}?extend=extendedAssetUrls,tracks&l=en-US`;
        const detailResp = await page.request.get(albumDetailUrl, { headers });
        if (detailResp.ok()) {
            const detailJson = await detailResp.json();
            if (detailJson.data && detailJson.data.length > 0) {
                albumResource = detailJson.data[0];
            }
        } else {
            console.error(`[getinfo.js] ARTIST SEARCH - 详情请求失败 (${candidate.id}): HTTP ${detailResp.status()} ${(await detailResp.text()).slice(0, 200)}`);
        }

        const albumAttributes = albumResource.attributes;
        const albumRelationships = albumResource.relationships;
        if (!albumAttributes) continue;

        const albumIsActuallyAtmos = albumAttributes.audioTraits?.some(t => ['atmos', 'spatialAudio'].includes(t));
        if (!albumIsActuallyAtmos) continue;

        // 跳过重复版本（如 clean/explicit 双版本同名专辑）
        const dupKey = `${albumAttributes.name}|${albumAttributes.releaseDate}|${albumAttributes.trackCount}`;
        if (results.some(r => `${r.name}|${r.releaseDate}|${r.trackCount}` === dupKey)) continue;

        const tracksDetails = [];
        if (albumRelationships?.tracks?.data) {
            for (const track of albumRelationships.tracks.data) {
                if (!track.attributes) continue;
                const trackIsAtmos = track.attributes.audioTraits?.some(t => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(t));
                const trackDetail = {
                    id: track.id,
                    name: track.attributes.name,
                    durationInMillis: track.attributes.durationInMillis,
                    supportsDolbyAtmos: trackIsAtmos || false,
                    audioTraitsTrack: track.attributes.audioTraits || [],
                    releaseDate: track.attributes.releaseDate,
                    artistName: track.attributes.artistName,
                    composerName: track.attributes.composerName,
                    producerName: track.attributes.producerName,
                    songwriterNames: [],
                    isrc: track.attributes.isrc,
                    url: track.attributes.url
                };
                if (track.attributes.songwriterNames && Array.isArray(track.attributes.songwriterNames) && track.attributes.songwriterNames.length > 0) {
                    trackDetail.songwriterNames = track.attributes.songwriterNames.filter(name => name && name.trim() !== '');
                } else if (track.attributes.writerName && typeof track.attributes.writerName === 'string' && track.attributes.writerName.trim() !== '') {
                    trackDetail.songwriterNames = track.attributes.writerName.split(/,\s*|\s*;\s*|\s+&\s+|\s+and\s+/i).map(name => name.trim()).filter(name => name !== '');
                }
                if (!trackDetail.composerName) delete trackDetail.composerName;
                if (!trackDetail.producerName) delete trackDetail.producerName;
                if (trackDetail.songwriterNames.length === 0) delete trackDetail.songwriterNames;
                if (!trackDetail.isrc) delete trackDetail.isrc;
                tracksDetails.push(trackDetail);
            }
        }

        const albumItem = {
            id: albumResource.id,
            type: 'album',
            // 区分 单曲/EP、合集与普通专辑，供前端徽标展示
            albumSubtype: (albumAttributes.isSingle === true || /\s+-\s+(single|ep)$/i.test(albumAttributes.name || ''))
                ? 'single'
                : (albumAttributes.isCompilation === true ? 'compilation' : 'album'),
            name: albumAttributes.name,
            artistName: albumAttributes.artistName,
            releaseDate: albumAttributes.releaseDate,
            artworkUrl: albumAttributes.artwork?.url.replace('{w}', '300').replace('{h}', '300'),
            supportsDolbyAtmos: true,
            audioTraits: albumAttributes.audioTraits || [],
            trackCount: albumAttributes.trackCount,
            upc: albumAttributes.upc,
            url: albumAttributes.url,
            genres: albumAttributes.genreNames || [],
            tracksDetails,
            albumFilterApplied: 'artist'
        };
        if (!albumItem.upc) delete albumItem.upc;
        results.push(albumItem);
        console.log(`[getinfo.js] ARTIST SEARCH - 收录杜比专辑: ${albumItem.name} (${albumItem.id}), 艺人: ${albumItem.artistName}`);
    }

    if (results.length === 0) {
        console.log('[getinfo.js] ARTIST SEARCH - 本页未找到杜比全景声专辑。');
    } else {
        console.log(`[getinfo.js] ARTIST SEARCH - 本页收录 ${results.length} 张杜比全景声专辑。`);
    }
    return { results, pagination };
}

// 歌曲/专辑/合集搜索（分页）：通过 AMP 搜索 API 按 offset 拉取一页，筛选杜比全景声结果
// 注意：搜索接口不提供总数（total 为 null），用 hasMore 表示是否还有下一页
// 空页处理：本页过滤后无结果但原始结果还有下一页时，自动向后扫描（最多 MAX_SCAN_PAGES 页），
// 避免前端出现"空页但还能继续翻页"的情况；返回的 pagination.offset 为实际命中页的偏移
const SEARCH_PAGE_SIZE = 10;
const MAX_SCAN_PAGES = 3; // 单次请求最多向后扫描的原始页数（专辑/合集每页需逐张拉详情，不宜过多）
const COMPILATION_MAX_SCAN_PAGES = 6; // 合集有免详情预筛，扫描成本低，可以扫得更深
async function searchCatalogPaged(page, authToken, searchTerm, storefront, searchType, albumFilter, offset = 0) {
    const headers = { 'Authorization': `Bearer ${authToken}`, 'Origin': 'https://music.apple.com' };
    const isAlbumKind = searchType === 'album' || searchType === 'compilation';
    const types = isAlbumKind ? 'albums' : 'songs';
    const typeLabel = searchType === 'compilation' ? '合集' : (searchType === 'album' ? '专辑' : '歌曲');
    const searchTermLower = searchTerm.toLowerCase();
    const searchUrlFor = (off, limit, resTypes = types) =>
        `https://amp-api.music.apple.com/v1/catalog/${storefront}/search?term=${encodeURIComponent(searchTerm)}&types=${resTypes}&limit=${limit}&offset=${off}&l=en-US`;
    const SONG_SCAN_LIMIT = 25; // 合集搜索歌曲反查的每页条数
    const maxScanPages = searchType === 'compilation' ? COMPILATION_MAX_SCAN_PAGES : MAX_SCAN_PAGES;

    let scanOffset = offset;
    let results = [];
    let hasMore = false;
    let rawCount = 0;

    for (let scanned = 1; scanned <= maxScanPages; scanned++) {
        console.log(`[getinfo.js] ${searchType.toUpperCase()} SEARCH - 请求: ${searchUrlFor(scanOffset, SEARCH_PAGE_SIZE)}`);
        const resp = await page.request.get(searchUrlFor(scanOffset, SEARCH_PAGE_SIZE), { headers });
        if (!resp.ok()) {
            if (scanned === 1) return { error: `搜索 API 请求失败: ${resp.status()}`, status: 502 };
            console.error(`[getinfo.js] ${searchType.toUpperCase()} SEARCH - 后续页请求失败: ${resp.status()}，按没有更多处理`);
            hasMore = false;
            break;
        }
        const json = await resp.json();
        const group = json.results?.[types];
        const items = group?.data || [];
        rawCount = items.length;

        // 合集搜索：除按专辑名匹配外，再通过歌曲反查其所属专辑，
        // 覆盖"搜艺人/歌曲名，找收录了相关作品的合集"的场景（合集名通常不含艺人名）
        let candidates = items;
        let songHasMore = false;
        if (searchType === 'compilation') {
            try {
                const songResp = await page.request.get(searchUrlFor(scanOffset, SONG_SCAN_LIMIT, 'songs'), { headers });
                if (songResp.ok()) {
                    const songJson = await songResp.json();
                    const songGroup = songJson.results?.songs;
                    const songItems = songGroup?.data || [];
                    songHasMore = Boolean(songGroup?.next) && songItems.length === SONG_SCAN_LIMIT;
                    const seenAlbumIds = new Set(items.map(a => a.id));
                    candidates = [...items];
                    for (const song of songItems) {
                        // 歌曲URL形如 /album/{slug}/{albumId}?i={songId}，提取所属专辑ID
                        const m = song.attributes?.url ? song.attributes.url.match(/\/album\/[^/]+\/(\d+)/) : null;
                        if (m && !seenAlbumIds.has(m[1])) {
                            seenAlbumIds.add(m[1]);
                            candidates.push({ id: m[1] }); // 仅有 id，详情由 buildAlbumResults 重新拉取
                        }
                        if (candidates.length >= 15) break; // 限制每页详情请求数量，避免过慢
                    }
                    console.log(`[getinfo.js] COMPILATION SEARCH - 歌曲反查新增候选专辑 ${candidates.length - items.length} 张`);
                }
            } catch (e) {
                console.log(`[getinfo.js] COMPILATION SEARCH - 歌曲反查失败，仅按专辑名匹配: ${e.message}`);
            }
            // 免详情预筛：列表接口的属性里通常带 isCompilation/artistName，
            // 先过滤掉明显不是合集的候选，避免对它们发起逐张详情请求
            const beforePreFilter = candidates.length;
            candidates = candidates.filter(res => {
                const attrs = res.attributes;
                if (!attrs) return true; // 反查候选只有 id，待详情确认
                return attrs.isCompilation === true || attrs.artistName === 'Various Artists';
            });
            if (beforePreFilter !== candidates.length) {
                console.log(`[getinfo.js] COMPILATION SEARCH - 预筛: ${beforePreFilter} -> ${candidates.length} 张候选`);
            }
        }

        // Apple 搜索接口不可靠：即便返回满页，next 也可能指向空页
        let rawHasMore = Boolean(group?.next) && items.length === SEARCH_PAGE_SIZE;
        hasMore = rawHasMore || songHasMore;

        // 构建本页结果
        if (candidates.length > 0) {
            if (isAlbumKind) {
                const filterMode = searchType === 'compilation' ? 'compilation' : albumFilter;
                results = await buildAlbumResults(page, headers, storefront, candidates, searchTermLower, filterMode);
            } else {
                results = buildSongResults(items);
            }
        } else {
            results = [];
        }
        console.log(`[getinfo.js] ${searchType.toUpperCase()} SEARCH - 第 ${scanned} 次扫描 (offset=${scanOffset}): 原始${typeLabel} ${rawCount} 条, 收录 ${results.length} 条`);

        const shouldStop = results.length > 0 || !hasMore || scanned === maxScanPages;
        if (shouldStop) {
            // 即将返回：若 hasMore 依赖满页 next，探测下一页确认不是空页，避免幽灵分页
            if (rawHasMore) {
                try {
                    const probeResp = await page.request.get(searchUrlFor(scanOffset + SEARCH_PAGE_SIZE, 1), { headers });
                    if (probeResp.ok()) {
                        const probeJson = await probeResp.json();
                        rawHasMore = (probeJson.results?.[types]?.data || []).length > 0;
                    }
                } catch (e) {
                    console.log(`[getinfo.js] 探测下一页失败，按有下一页处理: ${e.message}`);
                }
                hasMore = rawHasMore || songHasMore;
            }
            break;
        }
        // 本页过滤后为空，继续向后扫描
        scanOffset += SEARCH_PAGE_SIZE;
    }

    const pagination = {
        offset: scanOffset,
        pageSize: SEARCH_PAGE_SIZE,
        checked: scanOffset + rawCount,
        total: null,
        hasMore
    };
    console.log(`[getinfo.js] ${searchType.toUpperCase()} SEARCH - 返回: 收录 ${results.length} 条, pagination: ${JSON.stringify(pagination)}`);
    if (results.length === 0 && !hasMore && offset === 0) {
        return { error: `未能找到支持杜比全景声的${typeLabel}。请尝试其他搜索词或类型。`, status: 404 };
    }
    return { results, pagination };
}

// 从搜索结果中筛选支持杜比全景声的歌曲并构建结果项
function buildSongResults(songResources) {
    const results = [];
    const seenIds = new Set();
    for (const song of songResources) {
        const attrs = song.attributes;
        if (!attrs || seenIds.has(song.id)) continue;
        seenIds.add(song.id);
        const isAtmos = attrs.audioTraits?.some(t => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(t));
        if (!isAtmos) continue;
        // 歌曲URL形如 /album/{slug}/{albumId}?i={songId}，从中提取专辑ID
        const albumIdMatch = attrs.url ? attrs.url.match(/\/album\/[^/]+\/(\d+)/) : null;
        let songwriters = [];
        if (Array.isArray(attrs.songwriterNames) && attrs.songwriterNames.length > 0) {
            songwriters = attrs.songwriterNames.filter(n => n && n.trim() !== '');
        } else if (typeof attrs.writerName === 'string' && attrs.writerName.trim() !== '') {
            songwriters = attrs.writerName.split(/,\s*|\s*;\s*|\s+&\s+|\s+and\s+/i).map(n => n.trim()).filter(n => n !== '');
        }
        const item = {
            id: song.id,
            type: 'song',
            name: attrs.name,
            artistName: attrs.artistName,
            releaseDate: attrs.releaseDate,
            artworkUrl: attrs.artwork?.url.replace('{w}', '300').replace('{h}', '300'),
            supportsDolbyAtmos: true,
            audioTraits: attrs.audioTraits || [],
            genres: attrs.genreNames || [],
            durationInMillis: attrs.durationInMillis,
            albumName: attrs.albumName,
            albumId: albumIdMatch ? albumIdMatch[1] : undefined,
            composerName: attrs.composerName,
            songwriterNames: songwriters.length > 0 ? songwriters : undefined,
            isrc: attrs.isrc,
            url: attrs.url
        };
        if (!item.albumId) delete item.albumId;
        if (!item.composerName) delete item.composerName;
        if (!item.songwriterNames) delete item.songwriterNames;
        if (!item.isrc) delete item.isrc;
        results.push(item);
    }
    return results;
}

// 构建单曲的曲目详情（专辑内曲目列表用）
function buildTrackDetail(track) {
    const trackIsAtmos = track.attributes.audioTraits?.some(t => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(t));
    const trackDetail = {
        id: track.id,
        name: track.attributes.name,
        durationInMillis: track.attributes.durationInMillis,
        supportsDolbyAtmos: trackIsAtmos || false,
        audioTraitsTrack: track.attributes.audioTraits || [],
        releaseDate: track.attributes.releaseDate,
        artistName: track.attributes.artistName,
        composerName: track.attributes.composerName,
        producerName: track.attributes.producerName,
        songwriterNames: [],
        isrc: track.attributes.isrc,
        url: track.attributes.url
    };
    if (Array.isArray(track.attributes.songwriterNames) && track.attributes.songwriterNames.length > 0) {
        trackDetail.songwriterNames = track.attributes.songwriterNames.filter(n => n && n.trim() !== '');
    } else if (typeof track.attributes.writerName === 'string' && track.attributes.writerName.trim() !== '') {
        trackDetail.songwriterNames = track.attributes.writerName.split(/,\s*|\s*;\s*|\s+&\s+|\s+and\s+/i).map(n => n.trim()).filter(n => n !== '');
    }
    if (!trackDetail.composerName) delete trackDetail.composerName;
    if (!trackDetail.producerName) delete trackDetail.producerName;
    if (trackDetail.songwriterNames.length === 0) delete trackDetail.songwriterNames;
    if (!trackDetail.isrc) delete trackDetail.isrc;
    return trackDetail;
}

// 对搜索结果中的专辑逐张获取完整信息（含曲目），按专辑筛选规则构建结果
async function buildAlbumResults(page, headers, storefront, albumResources, searchTermLower, albumFilter) {
    const results = [];
    const seenIds = new Set();
    for (const candidate of albumResources) {
        if (seenIds.has(candidate.id)) continue;
        seenIds.add(candidate.id);

        let albumResource = candidate;
        const detailUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${candidate.id}?extend=extendedAssetUrls,tracks&l=en-US`;
        const detailResp = await page.request.get(detailUrl, { headers });
        if (detailResp.ok()) {
            const detailJson = await detailResp.json();
            if (detailJson.data && detailJson.data.length > 0) albumResource = detailJson.data[0];
        } else {
            console.error(`[getinfo.js] ALBUM SEARCH - 详情请求失败 (${candidate.id}): HTTP ${detailResp.status()}`);
        }

        const albumAttributes = albumResource.attributes;
        const albumRelationships = albumResource.relationships;
        if (!albumAttributes) continue;

        const albumIsActuallyAtmos = albumAttributes.audioTraits?.some(t => ['atmos', 'spatialAudio'].includes(t));
        // 合集判定：API 的 isCompilation 字段，或艺人为 Various Artists
        const isCompilationRelease = albumAttributes.isCompilation === true || albumAttributes.artistName === 'Various Artists';
        if (albumFilter === 'compilation' && !isCompilationRelease) continue;

        const tracksDetails = [];
        let foundRelevantAtmosTrack = false;
        if (albumRelationships?.tracks?.data) {
            for (const track of albumRelationships.tracks.data) {
                if (!track.attributes) continue;
                const trackIsAtmos = track.attributes.audioTraits?.some(t => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(t));
                const trackNameMatchesSearch = track.attributes.name.toLowerCase().includes(searchTermLower);
                if (albumFilter === 'compilation') {
                    // 合集模式收录全部曲目，不做曲目名匹配
                    tracksDetails.push(buildTrackDetail(track));
                } else if (albumFilter === 'songPriority') {
                    if (trackNameMatchesSearch && trackIsAtmos) {
                        tracksDetails.push(buildTrackDetail(track));
                        foundRelevantAtmosTrack = true;
                    }
                } else {
                    tracksDetails.push(buildTrackDetail(track));
                    if (trackNameMatchesSearch && trackIsAtmos) foundRelevantAtmosTrack = true;
                }
            }
        }

        let shouldCollect = false;
        if (albumFilter === 'compilation') {
            // 合集模式：专辑本身支持杜比即收录（搜索词由搜索 API 按专辑名匹配）
            shouldCollect = albumIsActuallyAtmos;
        } else if (albumFilter === 'songPriority') {
            shouldCollect = foundRelevantAtmosTrack && tracksDetails.length > 0;
        } else {
            shouldCollect = albumIsActuallyAtmos && foundRelevantAtmosTrack;
        }
        if (!shouldCollect) continue;

        const albumItem = {
            id: albumResource.id,
            type: 'album',
            albumSubtype: (albumAttributes.isSingle === true || /\s+-\s+(single|ep)$/i.test(albumAttributes.name || ''))
                ? 'single'
                : (isCompilationRelease ? 'compilation' : 'album'),
            name: albumAttributes.name,
            artistName: albumAttributes.artistName,
            releaseDate: albumAttributes.releaseDate,
            artworkUrl: albumAttributes.artwork?.url.replace('{w}', '300').replace('{h}', '300'),
            supportsDolbyAtmos: albumIsActuallyAtmos,
            audioTraits: albumAttributes.audioTraits || [],
            trackCount: albumAttributes.trackCount,
            upc: albumAttributes.upc,
            url: albumAttributes.url,
            genres: albumAttributes.genreNames || [],
            tracksDetails,
            albumFilterApplied: albumFilter
        };
        if (!albumItem.upc) delete albumItem.upc;
        results.push(albumItem);
        console.log(`[getinfo.js] ALBUM SEARCH - 收录专辑: ${albumItem.name} (${albumItem.id}), 筛选: ${albumFilter}`);
    }
    return results;
}

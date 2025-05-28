const cheerio = require('cheerio');
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

        const match = body.match(/(?<=")eyJhbGciOiJ.+?(?=")/);
        if (!match || !match[0]) {
            console.error("错误: 未能在 JS 文件内容中找到认证 Token。");
            return null;
        }
        console.log("成功提取到认证 Token。");
        return match[0];
    } catch (error) {
        console.error("提取认证 Token 时发生错误:", error);
        return null;
    }
}

// 主要的搜索和信息提取函数
// 该函数现在接收一个 page 对象作为其第一个参数
async function findAppleMusicInfo(page, searchTerm, storefront = "cn", searchType = "song", albumFilter = "albumPriority") { // page 参数已添加, albumFilter 参数已添加
    console.log(`[getinfo.js] findAppleMusicInfo CALLED - Term: "${searchTerm}", Store: "${storefront}", Type: "${searchType}", AlbumFilter: "${albumFilter}"`);
    const searchTermEncoded = encodeURIComponent(searchTerm);
    const searchTermLower = searchTerm.toLowerCase(); // For matching
    const searchUrl = `https://music.apple.com/${storefront}/search?term=${searchTermEncoded}`;
    console.log(`正在请求 (getinfo.js): ${searchUrl} 使用传入的 page 对象`);

    const allFoundResults = [];
    const processedAlbumIdsForApiCall = new Set();

    try {
        // const page = await getPlaywrightPage(); // 旧逻辑：获取单例页面实例。现在 page 从参数传入
        // 确保传入的 page 对象有效
        if (!page || page.isClosed()) {
            console.error("错误: 传入的 Playwright page 对象无效或已关闭 (findAppleMusicInfo)。");
            return [{ error: "浏览器页面服务不可用，请稍后重试。", status: 503 }];
        }
        
        // Navigate to the search page
        try {
            console.log(`导航到页面 (getinfo.js): ${searchUrl}`);
            await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 60000 });
        } catch (navError) {
            console.error(`导航到 ${searchUrl} 失败 (getinfo.js):`, navError.message);
            // 不再尝试重新初始化浏览器，因为这由 server.js 管理
            // browserReady = false; 
            // pageInstance = null; 
            // browserInstance = null;
            return [{ error: `页面导航失败 (getinfo.js): ${navError.message}. 请检查网络或目标站点状态。`, status: 503 }];
        }

        const authToken = await getAuthTokenFromPage(page); // 传递 page 对象
        if (!authToken) {
            return [{ error: "未能获取认证 Token，无法继续调用 AMP API。", status: 500 }];
        }

        const content = await page.content();
        const $ = cheerio.load(content);

        // Function to process a given section (container) for items
        async function processSection(sectionContainer, sectionName) {
            if (!sectionContainer || sectionContainer.length === 0) {
                console.log(`未能定位到 '${sectionName}' 部分，或该部分为空。`);
                return;
            }
            console.log(`开始处理 '${sectionName}' 区域...`);

            const potentialTargetsInSection = [];
            sectionContainer.find('a[href]').each((index, element) => {
            const href = $(element).attr('href');
            if (!href) return;

                const linkTitleElement = $(element).find('.lockup__title, .product-title, .track-name, [data-testid="title"]').first();
                let linkTextContent = linkTitleElement.text().trim() || $(element).text().trim();
                let ariaLabelText = $(element).attr('aria-label') ? $(element).attr('aria-label').trim() : "";
                let textForMatching = (ariaLabelText || linkTextContent).toLowerCase();
                
                if (!textForMatching || textForMatching === "see all" || textForMatching === "查看全部") return;

                const albumIdMatch = href.match(/\/album\/[^/]+\/(\d+)/);
                const songIdMatchInLink = href.match(/\?i=(\d+)/);
                let currentAlbumId = null, currentSongId = null, itemTypeHint = 'unknown';

                if (albumIdMatch && albumIdMatch[1]) {
                    currentAlbumId = albumIdMatch[1];
                    itemTypeHint = 'album';
                    if (songIdMatchInLink && songIdMatchInLink[1]) {
                        currentSongId = songIdMatchInLink[1];
                        itemTypeHint = 'song';
                    }
                    // console.log(`  '${sectionName}' 中待处理项目: 类型=${itemTypeHint}, 文本='${linkTextContent}', 专辑ID=${currentAlbumId}${currentSongId ? ', 歌曲ID=' + currentSongId : ''}`);
                    potentialTargetsInSection.push({ albumId: currentAlbumId, songId: currentSongId, linkText: linkTextContent, itemTypeHint });
                }
            });

            if (potentialTargetsInSection.length === 0) {
                // console.log(`  '${sectionName}' 部分中未找到包含专辑ID的可处理链接。`);
                return;
            }
            // console.log(`  从 '${sectionName}' 区域识别到 ${potentialTargetsInSection.length} 个潜在目标。`);

            for (const target of potentialTargetsInSection) {
                // Skip if no albumId, or if API for this albumId was already called (unless new songId justifies re-eval of tracks)
                if (!target.albumId) continue;
                
                let shouldCallApi = !processedAlbumIdsForApiCall.has(target.albumId);
                let albumDataFromCache = null; // Placeholder for a more advanced cache

                // If we had a cache of API responses, we might check it here
                // if (processedAlbumIdsForApiCall.has(target.albumId) && target.songId) { ... }

                let collectedItem = null;
                let albumResource, albumAttributes, albumRelationships;

                // Always fetch album details if we have an albumId and haven't processed it yet.
                // The decision of what to *collect* (song vs album) happens *after* this.
                if (target.albumId && !processedAlbumIdsForApiCall.has(target.albumId)) {
                    processedAlbumIdsForApiCall.add(target.albumId);
                    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${target.albumId}?extend=extendedAssetUrls,tracks&l=en-US`;
                    console.log(`    处理 '${target.linkText}' (来自 ${sectionName}): 调用 AMP API (专辑ID: ${target.albumId})`);
                    
                    const apiResponse = await page.request.get(apiUrl, { headers: { 'Authorization': `Bearer ${authToken}`, 'Origin': 'https://music.apple.com' } });
                    if (!apiResponse.ok()) { console.error(`      AMP API 请求失败: ${apiResponse.status()} for album ID ${target.albumId}`); continue; }
                    const apiJson = await apiResponse.json();
                    if (!apiJson.data || apiJson.data.length === 0) { console.error(`      API数据无效 for album ID ${target.albumId}`); continue; }
                    
                    albumResource = apiJson.data[0];
                    albumAttributes = albumResource.attributes;
                    albumRelationships = albumResource.relationships;
                } else if (target.albumId && processedAlbumIdsForApiCall.has(target.albumId)) {
                    // This case might need to fetch from a cache if we had one. For now, assume we can't proceed without fresh API call if needed later.
                    // console.log(`    专辑ID ${target.albumId} API调用已处理，跳过重复获取。`);
                    // If we need to re-evaluate based on cached data, that logic would go here.
                    // For now, if it's processed, and we don't have albumResource, we can't make a decision for this target.
                    // This path should ideally be hit if albumResource was already fetched and cached for this albumId.
                    // To simplify, we will rely on the initial fetch. If not fetched, can't proceed for this specific path through `potentialTargetsInSection`.
                    // This means we *must* have `albumResource` to make a decision below for this `target`.
                    // The `continue` below is if `albumResource` wasn't populated (e.g. API call skipped or failed for this ID earlier in a *different* target iteration)
                    // This part of the control flow needs to be robust to whether `albumResource` is populated from a *previous* target that shared this `albumId`
                    // For now, the logic is: if `albumResource` isn't set here, we can't make a choice for *this specific target*.
                    // This will be handled by the `if (!albumResource) continue;` check below.
                }

                // If albumResource is not populated at this point (e.g., API call failed or was skipped and no cache hit), 
                // we cannot make a decision for this item. Skip to the next potential target.
                if (!albumResource || !albumAttributes || !albumRelationships) {
                    // console.log(`    无法处理目标 '${target.linkText}' (专辑ID: ${target.albumId}) 因为缺少API数据`);
                    continue;
                }
                                
                // Logic for "song" search type
                if (searchType === "song") {
                    // Ensure collectedItem is nullified if no suitable song is found in this album iteration for song search
                    let songCollectedThisIteration = null;
                    if (albumRelationships?.tracks?.data) {
                        const tracks = albumRelationships.tracks.data;
                        let trackResourceToConsider = target.songId ? tracks.find(t => t.id === target.songId) : null;
                        if (!trackResourceToConsider) {
                            const linkTextLower = target.linkText.toLowerCase(); 
                            trackResourceToConsider = tracks.find(t => t.attributes && 
                                (t.attributes.name.toLowerCase().includes(linkTextLower) || t.attributes.name.toLowerCase().includes(searchTermLower))
                            );
                        }

                        if (trackResourceToConsider) {
                            const trackAttributes = trackResourceToConsider.attributes;
                            if (trackAttributes.audioTraits?.some(trait => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(trait))) {
                                let songwriters = [];
                                if (trackAttributes.songwriterNames && Array.isArray(trackAttributes.songwriterNames) && trackAttributes.songwriterNames.length > 0) {
                                    songwriters = trackAttributes.songwriterNames.filter(name => name && name.trim() !== '');
                                } else if (trackAttributes.writerName && typeof trackAttributes.writerName === 'string' && trackAttributes.writerName.trim() !== '') {
                                    songwriters = trackAttributes.writerName.split(/,\s*|\s*;\s*|\s+&\s+|\s+and\s+/i).map(name => name.trim()).filter(name => name !== '');
                                }
                                songCollectedThisIteration = {
                                    id: trackResourceToConsider.id, 
                                    type: 'song', 
                                    name: trackAttributes.name, 
                                    artistName: trackAttributes.artistName,
                                    releaseDate: trackAttributes.releaseDate || albumAttributes.releaseDate, 
                                    artworkUrl: albumAttributes.artwork?.url.replace('{w}', '300').replace('{h}', '300'),
                                    supportsDolbyAtmos: true, 
                                    audioTraits: trackAttributes.audioTraits || [], 
                                    genres: trackAttributes.genreNames || [],
                                    durationInMillis: trackAttributes.durationInMillis, 
                                    albumName: albumAttributes.name,
                                    albumId: albumResource.id,
                                    composerName: trackAttributes.composerName, 
                                    producerName: trackAttributes.producerName,
                                    songwriterNames: songwriters.length > 0 ? songwriters : undefined,
                                    isrc: trackAttributes.isrc
                                };
                                if (!songCollectedThisIteration.composerName) delete songCollectedThisIteration.composerName;
                                if (!songCollectedThisIteration.producerName) delete songCollectedThisIteration.producerName;
                                if (!songCollectedThisIteration.songwriterNames) delete songCollectedThisIteration.songwriterNames;
                                if (!songCollectedThisIteration.isrc) delete songCollectedThisIteration.isrc;
                            }
                        }
                    }
                    collectedItem = songCollectedThisIteration; // Assign to collectedItem for unified handling later
                } 
                // Logic for "album" search type (handles albumPriority and songPriority filters)
                else if (searchType === "album") {
                    const albumIsActuallyAtmos = albumAttributes.audioTraits?.some(trait => ['atmos', 'spatialAudio'].includes(trait));
                    const isAnAlbumResourceType = (albumResource.type === 'albums');
                    console.log(`  [getinfo.js] ALBUM SEARCH MODE (${albumFilter}) - Album: "${albumAttributes.name}" (ID: ${albumResource.id}), isActualAtmos: ${albumIsActuallyAtmos}, isAlbumResource: ${isAnAlbumResourceType}`);

                    if (isAnAlbumResourceType) {
                        let tracksToIncludeInDetails = [];
                        let foundAnyRelevantAtmosTrackForAlbumCriteria = false; // Used for both filters to see if album is relevant AT ALL

                        if (albumRelationships?.tracks?.data) {
                            console.log(`    Found ${albumRelationships.tracks.data.length} tracks in album.`);
                            for (const track of albumRelationships.tracks.data) {
                                if (track.attributes) {
                                    const trackName = track.attributes.name;
                                    const trackIsAtmos = track.attributes.audioTraits?.some(t => ['atmos', 'spatialAudio', 'losslessSpatial'].includes(t));
                                    const trackNameMatchesSearch = trackName.toLowerCase().includes(searchTermLower);
                                    
                                    const currentTrackDetail = {
                                        id: track.id,
                                        name: trackName,
                                        durationInMillis: track.attributes.durationInMillis,
                                        supportsDolbyAtmos: trackIsAtmos || false,
                                        audioTraitsTrack: track.attributes.audioTraits || [],
                                        releaseDate: track.attributes.releaseDate,
                                        artistName: track.attributes.artistName,
                                        composerName: track.attributes.composerName,
                                        producerName: track.attributes.producerName,
                                        songwriterNames: [], // Placeholder, fill if available
                                        isrc: track.attributes.isrc
                                    };
                                    // Populate songwriterNames for currentTrackDetail
                                    if (track.attributes.songwriterNames && Array.isArray(track.attributes.songwriterNames) && track.attributes.songwriterNames.length > 0) {
                                        currentTrackDetail.songwriterNames = track.attributes.songwriterNames.filter(name => name && name.trim() !== '');
                                    } else if (track.attributes.writerName && typeof track.attributes.writerName === 'string' && track.attributes.writerName.trim() !== '') {
                                        currentTrackDetail.songwriterNames = track.attributes.writerName.split(/,\s*|\s*;\s*|\s+&\s+|\s+and\s+/i).map(name => name.trim()).filter(name => name !== '');
                                    }
                                    if (!currentTrackDetail.composerName) delete currentTrackDetail.composerName;
                                    if (!currentTrackDetail.producerName) delete currentTrackDetail.producerName;
                                    if (currentTrackDetail.songwriterNames.length === 0) delete currentTrackDetail.songwriterNames;
                                    if (!currentTrackDetail.isrc) delete currentTrackDetail.isrc;

                                    console.log(`      Track: "${trackName}", isAtmos: ${trackIsAtmos}, nameMatchesSearch("${searchTermLower}"): ${trackNameMatchesSearch}`);

                                    if (albumFilter === "songPriority") {
                                        if (trackNameMatchesSearch && trackIsAtmos) {
                                            tracksToIncludeInDetails.push(currentTrackDetail);
                                            foundAnyRelevantAtmosTrackForAlbumCriteria = true; // Mark that this album is relevant
                                            console.log(`        SONG_PRIORITY: MATCH! Adding track "${trackName}" to details.`);
                                        }
                                    } else { // albumPriority (default)
                                        tracksToIncludeInDetails.push(currentTrackDetail); // Always add all track details for albumPriority
                                        if (trackNameMatchesSearch && trackIsAtmos) {
                                            foundAnyRelevantAtmosTrackForAlbumCriteria = true; // Mark that this album is relevant
                                            console.log(`        ALBUM_PRIORITY: Relevant Atmos track found: "${trackName}".`);
                                        }
                                    }
                                }
                            }
                        }
                        console.log(`    Finished checking tracks. foundAnyRelevantAtmosTrackForAlbumCriteria: ${foundAnyRelevantAtmosTrackForAlbumCriteria}`);

                        let shouldCollectThisAlbum = false;
                        if (albumFilter === "songPriority") {
                            if (foundAnyRelevantAtmosTrackForAlbumCriteria && tracksToIncludeInDetails.length > 0) {
                                shouldCollectThisAlbum = true;
                                console.log(`    SONG_PRIORITY: Conditions met to collect album "${albumAttributes.name}".`);
                            }
                        } else { // albumPriority
                            if (albumIsActuallyAtmos && foundAnyRelevantAtmosTrackForAlbumCriteria) {
                                shouldCollectThisAlbum = true;
                                console.log(`    ALBUM_PRIORITY: Conditions met (album is Atmos, relevant track found) to collect album "${albumAttributes.name}".`);
                            }
                        }

                        if (shouldCollectThisAlbum) {
                            collectedItem = {
                                id: albumResource.id,
                                type: 'album',
                                name: albumAttributes.name,
                                artistName: albumAttributes.artistName,
                                releaseDate: albumAttributes.releaseDate,
                                artworkUrl: albumAttributes.artwork?.url.replace('{w}', '300').replace('{h}', '300'),
                                supportsDolbyAtmos: albumIsActuallyAtmos, // Reflects actual album Atmos status
                                audioTraits: albumAttributes.audioTraits || [],
                                trackCount: albumAttributes.trackCount, // Original track count
                                upc: albumAttributes.upc,
                                genres: albumAttributes.genreNames || [],
                                tracksDetails: tracksToIncludeInDetails, // This list is now filtered for 'songPriority'
                                albumFilterApplied: albumFilter // Add this to know which filter was used, for potential frontend use
                            };
                            // Clean up optional fields from album item
                            if (!collectedItem.upc) delete collectedItem.upc;
                        }
                    }
                }
                
                if (collectedItem && !allFoundResults.some(existing => existing.id === collectedItem.id)) {
                    if (searchType === "album") {
                        if (collectedItem.type !== "album") {
                            console.log(`      [getinfo.js] ALBUM SEARCH MODE: Attempted to add non-album item. SKIPPING. Item:`, JSON.stringify(collectedItem, null, 2));
                        } else {
                            console.log(`      [getinfo.js] ALBUM SEARCH MODE: Adding ALBUM item:`, JSON.stringify(collectedItem, null, 2));
                            allFoundResults.push(collectedItem);
                            console.log(`      >> 添加到结果 (来自 ${sectionName}, 搜索类型: ${searchType}, 项目类型: ${collectedItem.type}): ${collectedItem.name} (ID: ${collectedItem.id})`);
                        }
                    } else { // For song search or other types
                        allFoundResults.push(collectedItem);
                        console.log(`      >> 添加到结果 (来自 ${sectionName}, 搜索类型: ${searchType}, 项目类型: ${collectedItem.type}): ${collectedItem.name} (ID: ${collectedItem.id})`);
                    }
                } else if (collectedItem && searchType === "song" && collectedItem.type === "song" && !collectedItem.supportsDolbyAtmos ) { 
                    console.log(`      -- 忽略歌曲 (来自 ${sectionName}, 不支持或未明确杜比): ${collectedItem.name} (ID: ${collectedItem.id})`);
                }
            }
        }

        // 1. Process "Best Results" section
        let bestResultsSectionContainer = null;
        const sectionTitlesSelectors = ['h2.shelf__title', 'h2.section__headline', 'h2', 'h3'];
        for (const selector of sectionTitlesSelectors) {
            $(selector).each((i, el) => {
                const titleText = $(el).text().trim();
                if (titleText.includes("最佳结果") || titleText.toLowerCase().includes("top result")) {
                    let potentialContainer = $(el).next(); 
                    if (!potentialContainer.length || potentialContainer.find('a[href]').length === 0) potentialContainer = $(el).parent().find('.grid, .shelf-grid, .list');
                    if (!potentialContainer.length || potentialContainer.find('a[href]').length === 0) potentialContainer = $(el).closest('.section, .shelf').find('.grid, .shelf-grid, .list, a[href]').first().parent();
                    if (potentialContainer.find('a[href]').length > 0) { bestResultsSectionContainer = potentialContainer; return false; }
                }
            });
            if (bestResultsSectionContainer) break;
        }
        await processSection(bestResultsSectionContainer, "最佳结果");

        // 2. Process "Albums" section
        let albumsSectionContainer = null;
        for (const selector of sectionTitlesSelectors) {
            $(selector).each((i, el) => {
                const titleText = $(el).text().trim();
                if (titleText === "专辑" || titleText.toLowerCase() === "albums") {
                    let potentialContainer = $(el).next();
                    if (!potentialContainer.length || potentialContainer.find('a[href]').length === 0) potentialContainer = $(el).parent().find('.grid, .shelf-grid, .list');
                    if (!potentialContainer.length || potentialContainer.find('a[href]').length === 0) potentialContainer = $(el).closest('.section, .shelf').find('.grid, .shelf-grid, .list, a[href]').first().parent();
                    if (potentialContainer.find('a[href]').length > 0) { albumsSectionContainer = potentialContainer; return false; }
                }
            });
            if (albumsSectionContainer) break;
        }
        await processSection(albumsSectionContainer, "专辑");
        
        // Add other sections if needed, e.g., "Songs" section
        // let songsSectionContainer = null; ... await processSection(songsSectionContainer, "歌曲");

        if (allFoundResults.length === 0) {
            console.log(`处理完所有相关区域后，未找到任何支持杜比全景声的${searchType === "album" ? "专辑" : "歌曲"}。`);
            return [{ error: `未能找到支持杜比全景声的${searchType === "album" ? "专辑 " : "歌曲"}。请尝试其他搜索词或类型。`, status: 404 }];
        }
        console.log(`查询完成，共找到 ${allFoundResults.length} 个支持杜比全景声的${searchType === "album" ? "专辑" : "歌曲"}。`);
        return allFoundResults;

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
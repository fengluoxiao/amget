import playwright, { Browser, Page } from 'playwright';
import * as cheerio from 'cheerio';

interface MusicInfo {
    title: string;
    artist: string;
    albumName?: string;
    releaseDate?: string;
    isExplicit: boolean;
    isDolbyAtmos: boolean;
    genre?: string;
    trackNumber?: number;
    discNumber?: number;
    durationInMillis?: number;
    artworkUrl?: string;
    albumId?: string; // Added to help uniquely identify for API calls
    type?: string; // 'album', 'song', etc.
}

interface SectionData {
    title: string;
    items: MusicInfo[];
    topHit?: MusicInfo; // For "Top Result" which might be an album or song
}


class AppleMusicScraper {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private developerToken: string | null = null;
    private tokenExpiry: number = 0; // Store token expiry timestamp
    private static instance: AppleMusicScraper;
    private isBrowserClosing: boolean = false;
    private initializationPromise: Promise<void> | null = null;

    private constructor() {
        console.log("AppleMusicScraper constructor: Initializing Playwright browser instance (singleton)...");
        // Start initialization, but don't wait here.
        // Callers should await ensurePage() or specific methods.
        // this.initializationPromise = this._initializeBrowser();
    }

    public static getInstance(): AppleMusicScraper {
        if (!AppleMusicScraper.instance) {
            AppleMusicScraper.instance = new AppleMusicScraper();
        }
        return AppleMusicScraper.instance;
    }


    private async _initializeBrowser(): Promise<void> {
        if (this.browser) return; // Already initialized or initializing
        console.log("Playwright: Launching new browser instance...");
        try {
            this.browser = await playwright.chromium.launch({ headless: true });
            if (!this.browser) throw new Error("Browser failed to launch"); // Check if browser launched
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                javaScriptEnabled: true,
            });
            this.page = await context.newPage();
            console.log("Playwright browser and page instance initialized successfully.");
        } catch (error) {
            console.error("Error initializing Playwright browser:", error);
            this.browser = null; // Ensure browser is null if initialization fails
            this.page = null;
            throw error; // Re-throw to signal failure
        }
    }


    public async ensurePage(): Promise<void> {
        if (!this.initializationPromise) {
            this.initializationPromise = this._initializeBrowser().catch(err => {
                this.initializationPromise = null; // Reset on failure to allow retry
                throw err;
            });
        }
        try {
            await this.initializationPromise;
            if (!this.page || !this.browser) {
                 console.error("Page or browser is null after initialization promise.");
                 this.initializationPromise = null; // Reset to allow re-initialization
                 throw new Error("Failed to initialize browser or page properly.");
            }
        } catch (error) {
            console.error("ensurePage: Error during browser initialization:", error);
            this.initializationPromise = null; // Reset on failure
            throw error;
        }
    }


    private async _getDeveloperTokenScriptUrl(storefront: string): Promise<string | null> {
        if (!this.page) {
            console.error("Page not initialized in _getDeveloperTokenScriptUrl.");
            await this.ensurePage(); // Attempt to initialize if not already
            if (!this.page) { // Check again after ensurePage
                 console.error("Page still not initialized after attempt in _getDeveloperTokenScriptUrl.");
                 return null;
            }
        }
        // Use a common storefront like 'us' or 'cn' if the script location is global,
        // or the provided storefront if it varies. For now, using provided storefront.
        const browsePageUrl = `https://music.apple.com/${storefront}/browse`;
        console.log(`Navigating to ${browsePageUrl} to find token script URL...`);
        try {
            await this.page.goto(browsePageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            const browsePageContent = await this.page.content();
            const mainScriptRegex = /<script type="module" src="([^"]+)">/;
            const mainScriptMatch = browsePageContent.match(mainScriptRegex);

            if (mainScriptMatch && mainScriptMatch[1]) {
                const scriptPath = mainScriptMatch[1];
                return new URL(scriptPath, `https://music.apple.com`).toString();
            } else {
                console.error('Could not find main script tag in browse page content to extract token script URL.');
                // console.log("Browse page content snippet:", browsePageContent.substring(0, 1000));
                return null;
            }
        } catch (error) {
            console.error(`Error navigating to or getting content from ${browsePageUrl} for token script URL:`, error);
            return null;
        }
    }

    private async _fetchAndSetTokenFromScript(scriptUrl: string): Promise<void> {
        if (!this.page) {
            console.error("Page not initialized in _fetchAndSetTokenFromScript.");
             // No need to call ensurePage here as this method is called in a context where page should exist.
            return;
        }
        try {
            console.log(`Fetching developer token from script: ${scriptUrl}`);
            const scriptResponse = await this.page.request.get(scriptUrl, { timeout: 20000 });
            if (!scriptResponse.ok()) {
                console.error(`Failed to fetch token script: ${scriptResponse.status()} ${scriptResponse.statusText()}`);
                return;
            }
            const scriptContent = await scriptResponse.text();
            const tokenRegex = /eyJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/;
            const tokenMatch = scriptContent.match(tokenRegex);

            if (tokenMatch && tokenMatch[0]) {
                this.developerToken = tokenMatch[0];
                this.tokenExpiry = Date.now() + (12 * 60 * 60 * 1000); // 12 hours expiry
                console.log('Developer token fetched and set successfully.');
            } else {
                console.error('Could not extract developer token from script content.');
                // console.error("Token script content snippet (first 500 chars):", scriptContent.substring(0, 500));
            }
        } catch (error) {
            console.error('Error fetching or parsing developer token script:', error);
        }
    }


    private parseMusicInfo(htmlContent: string, storefront: string): { sections: SectionData[], processedAlbumIdsForApiCall: Set<string> } {
        console.log("Parsing HTML content with Cheerio...");
        const $ = cheerio.load(htmlContent);
        const sections: SectionData[] = [];
        const processedAlbumIdsForApiCall = new Set<string>();

        // Helper to extract album ID and type from a URL
        const extractAlbumIdAndType = (href: string | undefined): { albumId: string | null, type: string | null } => {
            if (!href) return { albumId: null, type: null };
            const match = href.match(/\/(album|song|music-video|artist)\/([a-zA-Z0-9-]+(?:\/\d+)?|\d+)/);
            if (match && match[2]) {
                // For albums, id can be 'album-name/idNumber' or just 'idNumber'
                // For songs, it's usually 'song-name/idNumber?i=trackId'
                // We are interested in the album's ID for API call or the entity ID.
                let idPart = match[2];
                if (match[1] === 'album') {
                    const parts = idPart.split('/');
                    idPart = parts[parts.length -1]; // Get the last part, which should be the numeric ID
                } else if (match[1] === 'song') {
                    // For songs, the main ID in the path is often the album or compilation ID.
                    // The actual track ID is in query param `i`.
                    // For simplicity in this stage, we take the ID from path. API will give details.
                    const parts = idPart.split('/');
                     idPart = parts[parts.length -1]; // typically album id for a song.
                }
                 // For artists, music-videos, use the found ID directly.
                return { albumId: idPart.split('?')[0], type: match[1] };
            }
            return { albumId: null, type: null };
        };
        
        $('div[role="group"], div.shelf[aria-labelledby]').each((i, groupEl) => {
            const sectionTitleElement = $(groupEl).find('h2.shelf__title, h2.section-header__title, div[role="heading"] > p, h2[data-testid="shelf-title"], h2[data-testid="section-heading"]');
            let sectionTitle = sectionTitleElement.first().text().trim();
            if (!sectionTitle) {
                 // Try another common pattern for section titles
                sectionTitle = $(groupEl).find('.product-header__title').text().trim();
            }
            if (!sectionTitle) {
                // Fallback for some dynamic shelf titles
                const labelledby = $(groupEl).attr('aria-labelledby');
                if (labelledby) {
                    sectionTitle = $(`#${labelledby}`).text().trim();
                }
            }


            if (!sectionTitle) {
                console.warn("Found a section without a clear title, skipping for now.");
                return; // Skip sections without a clear title
            }
            
            console.log(`Processing section: "${sectionTitle}"`);
            const sectionData: SectionData = { title: sectionTitle, items: [] };

            // Handling "Top Result" specifically
            if (sectionTitle.toLowerCase().includes("top result") || sectionTitle.toLowerCase().includes("最佳结果")) {
                const topResultLink = $(groupEl).find('a[href*="/album/"], a[href*="/song/"]').first();
                const href = topResultLink.attr('href');
                if (href) {
                    const { albumId, type } = extractAlbumIdAndType(href);
                    if (albumId && type) {
                        const title = topResultLink.find('.product-title, .top-result-title, .multi-line-ellipsis').text().trim() || "Unknown Title";
                        const artist = topResultLink.find('.product-subtitle, .top-result-subtitle, .text-truncate').text().trim() || "Unknown Artist";
                        sectionData.topHit = {
                            title,
                            artist,
                            albumId,
                            type,
                            isExplicit: false, // Placeholder, AMP API will confirm
                            isDolbyAtmos: false, // Placeholder
                        };
                        console.log(`Found Top Hit: ${title} - ${artist} (AlbumID: ${albumId}, Type: ${type})`);
                    }
                }
            }

            // Generic item processing for shelves (songs, albums)
             $(groupEl).find('div[data-testid="track-lockup"], div.songs-list-row--album, div.grid-item, li.library-music-item').each((j, itemEl) => {
                const linkElement = $(itemEl).find('a[href*="/album/"], a[href*="/song/"], a.grid-item__ MeskiLink-sc-119fp5d-0, a.songs-list-row__link-wrapper');
                let href = linkElement.attr('href');

                if (!href) { // Try another way to find a link if the primary one fails
                    const contextMenuTrigger = $(itemEl).find('button[data-testid="context-menu-trigger"]').first();
                    const describedbyId = contextMenuTrigger.attr('aria-describedby');
                    if (describedbyId) {
                        const describedbyContent = $(`#${describedbyId}`).text(); // e.g. "More actions for Song Title by Artist Name"
                        // This is tricky, as it doesn't directly give a URL. We might need another strategy or skip these.
                        // For now, if no direct link, we may not be able to process.
                    }
                }
                 if (!href && $(itemEl).is('a[href]')) { // If the itemEl itself is an <a> tag
                    href = $(itemEl).attr('href');
                }


                if (href) {
                    const { albumId, type } = extractAlbumIdAndType(href);
                    if (albumId && type) {
                        let title = $(itemEl).find('.songs-list-row__song-name, .product-name, .track-name, .grid-item__title, .line-clamp-2').first().text().trim();
                        let artist = $(itemEl).find('.songs-list-row__by-line, .product-creator, .track-artist, .grid-item__subtitle, .line-clamp-1').first().text().trim();
                         // Fallback for titles and artists if specific selectors fail
                        if (!title) {
                            title = $(itemEl).find('[data-testid="title"]').text().trim() || $(itemEl).find('p[data-encore-id="type"]').eq(0).text().trim();
                        }
                        if (!artist) {
                             artist = $(itemEl).find('[data-testid="creator"]').text().trim() || $(itemEl).find('p[data-encore-id="type"]').eq(1).text().trim();
                        }


                        if (!title && linkElement.length > 0) { // Try getting title from link's content if other methods fail
                            title = linkElement.find('.product-title, .multi-line-ellipsis, .line-clamp-2').text().trim();
                            if (!title) title = linkElement.text().trim().split('\n')[0]; // Very basic fallback from link text
                        }
                        if (!artist && linkElement.length > 0) {
                            artist = linkElement.find('.product-subtitle, .text-truncate, .line-clamp-1').text().trim();
                        }
                        
                        if (title) { // Only add if we have a title
                            sectionData.items.push({
                                title,
                                artist: artist || "Unknown Artist",
                                albumId,
                                type,
                                isExplicit: false, // Placeholder
                                isDolbyAtmos: false, // Placeholder
                            });
                             console.log(`Found Item: ${title} - ${artist || "Unknown Artist"} (AlbumID: ${albumId}, Type: ${type}) in section "${sectionTitle}"`);
                        }
                    }
                }
            });
            if (sectionData.topHit || sectionData.items.length > 0) {
                 sections.push(sectionData);
            }
        });
        console.log(`Cheerio parsing complete. Found ${sections.length} sections.`);
        return { sections, processedAlbumIdsForApiCall };
    }

    private async callAMPAPI(albumId: string, storefront: string, type: string): Promise<MusicInfo[] | null> {
        if (!this.developerToken) {
            console.error("Developer token is not available for AMP API call.");
            return null;
        }
        if (!this.page) {
            console.error("Page is not initialized for AMP API call.");
            return null;
        }

        // Determine the correct API endpoint based on type
        let apiUrlPath;
        switch (type) {
            case 'album':
                apiUrlPath = `albums/${albumId}`;
                break;
            case 'song':
                 // For a song, we usually need its parent album's ID for full context, 
                 // or use a song-specific endpoint if available and preferred.
                 // The current `albumId` extracted for songs might actually be the album's ID.
                 // Assuming the ID is for an album containing the song, or a compilation.
                apiUrlPath = `albums/${albumId}`; // Fetching album to get track details
                break;
            // Add cases for 'artist', 'playlist', 'music-video' if needed
            default:
                console.warn(`Unsupported type "${type}" for AMP API call with ID ${albumId}. Fetching as album.`);
                apiUrlPath = `albums/${albumId}`; // Default to album for now
        }
        
        // const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?extend=extendedAssetUrls,tracks`;
        const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/${apiUrlPath}?extend=extendedAssetUrls,tracks&l=en-US`;
        console.log(`Calling AMP API: ${apiUrl}`);

        try {
            const response = await this.page.request.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${this.developerToken}`,
                    'Origin': 'https://music.apple.com',
                },
                timeout: 15000,
            });

            if (!response.ok()) {
                console.error(`AMP API request failed for ${albumId}: ${response.status()} ${response.statusText()}`);
                // console.error("Response body:", await response.text());
                return null;
            }

            const jsonResponse = await response.json();
            // console.log("AMP API Response for", albumId, ":", JSON.stringify(jsonResponse, null, 2));
            const results: MusicInfo[] = [];

            if (jsonResponse.data && jsonResponse.data.length > 0) {
                const mainItem = jsonResponse.data[0]; // Assuming first item is the primary one (e.g., the album itself)
                const attributes = mainItem.attributes;
                const relationships = mainItem.relationships;

                if (type === 'album' || (type === 'song' && relationships && relationships.tracks)) {
                    // If it's an album or a song whose parent album was fetched
                    const tracksData = relationships.tracks.data;
                    for (const track of tracksData) {
                        const trackAttributes = track.attributes;
                        if (!trackAttributes) continue;

                        results.push({
                            title: trackAttributes.name,
                            artist: trackAttributes.artistName,
                            albumName: attributes.name, // Album name from parent
                            releaseDate: trackAttributes.releaseDate || attributes.releaseDate,
                            isExplicit: trackAttributes.contentRating === "explicit",
                            isDolbyAtmos: trackAttributes.audioTraits?.includes("atmos") || trackAttributes.extendedAssetUrls?.atmos?.includes(".m4a") || false,
                            genre: trackAttributes.genreNames?.[0] || attributes.genreNames?.[0],
                            trackNumber: trackAttributes.trackNumber,
                            discNumber: trackAttributes.discNumber,
                            durationInMillis: trackAttributes.durationInMillis,
                            artworkUrl: trackAttributes.artwork?.url?.replace('{w}', '300').replace('{h}', '300') || attributes.artwork?.url?.replace('{w}', '300').replace('{h}', '300'),
                            albumId: mainItem.id, // The ID of the album this track belongs to
                            type: 'song' // Explicitly mark as song
                        });
                    }
                } else if (attributes) { // Single item like a song not part of a fetched album's tracks relationship
                    results.push({
                        title: attributes.name,
                        artist: attributes.artistName,
                        albumName: attributes.albumName, // Might be present for songs
                        releaseDate: attributes.releaseDate,
                        isExplicit: attributes.contentRating === "explicit",
                        isDolbyAtmos: attributes.audioTraits?.includes("atmos") || attributes.extendedAssetUrls?.atmos?.includes(".m4a") || false,
                        genre: attributes.genreNames?.[0],
                        trackNumber: attributes.trackNumber,
                        discNumber: attributes.discNumber,
                        durationInMillis: attributes.durationInMillis,
                        artworkUrl: attributes.artwork?.url?.replace('{w}', '300').replace('{h}', '300'),
                        albumId: mainItem.id,
                        type: mainItem.type || type // song, music-video etc.
                    });
                }
            }
            console.log(`AMP API call for ${albumId} (type ${type}) processed, found ${results.length} tracks/items.`);
            return results;
        } catch (error) {
            console.error(`Error during AMP API call for ${albumId}:`, error);
            return null;
        }
    }

    public async findAppleMusicInfo(searchTerm: string, storefront: string = 'cn'): Promise<MusicInfo[]> {
        console.log(`Starting findAppleMusicInfo for searchTerm: "${searchTerm}", storefront: "${storefront}"`);
        await this.ensurePage(); // Ensures this.page exists and is ready

        let tokenScriptUrlToFetch: string | null = null;

        // Step 1: Determine if token needs fetching and get its script URL if so.
        if (!this.developerToken || Date.now() >= this.tokenExpiry) {
            console.log('Developer token is invalid or expired. Discovering new token script URL...');
            tokenScriptUrlToFetch = await this._getDeveloperTokenScriptUrl(storefront);
            if (tokenScriptUrlToFetch) {
                console.log(`Token script URL discovered: ${tokenScriptUrlToFetch}`);
            } else {
                console.error('Failed to discover token script URL. API calls may fail or use stale token.');
            }
        } else {
            console.log('Using existing valid developer token.');
        }

        // Step 2: Navigate to the main search results page.
        const searchUrl = `https://music.apple.com/${storefront}/search?term=${encodeURIComponent(searchTerm)}`;
        console.log(`Navigating to search page: ${searchUrl}`);
        if (!this.page) { // Should be guaranteed by ensurePage, but defensive check
            console.error("Page is not available for navigation to search URL.");
            throw new Error("Page not initialized for search operation.");
        }
        await this.page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

        // Step 3: Perform parallel tasks:
        const tasks: Promise<any>[] = [];

        // Task A: Fetch main page content and parse it.
        const mainContentAndParseTask = async () => {
            console.log('Fetching and parsing main page content...');
            if (!this.page) throw new Error("Page became null before fetching content."); // Should not happen
            const htmlContent = await this.page.content();
            return this.parseMusicInfo(htmlContent, storefront);
        };
        tasks.push(mainContentAndParseTask());

        // Task B: If token needed refreshing and script URL was found, fetch the token.
        if (tokenScriptUrlToFetch) {
            tasks.push(this._fetchAndSetTokenFromScript(tokenScriptUrlToFetch));
        }

        console.log(`Awaiting ${tasks.length} parallel tasks...`);
        const taskResults = await Promise.all(tasks);
        console.log("Parallel tasks completed.");

        const { sections, processedAlbumIdsForApiCall } = taskResults[0] as { sections: SectionData[]; processedAlbumIdsForApiCall: Set<string>; };
        // Task B (_fetchAndSetTokenFromScript) updates instance properties and doesn't return a value needed here.

        // Step 4: Ensure token is now available if it was supposed to be fetched.
        if (tokenScriptUrlToFetch && (!this.developerToken || Date.now() >= this.tokenExpiry)) {
            console.warn("Developer token was intended to be fetched/refreshed, but it's still invalid or missing. API calls might fail.");
        }
        if (!this.developerToken) {
            console.error("Developer token is NOT available. Subsequent AMP API calls will fail.");
            // Optionally, return early or throw, but for now, let it attempt API calls to see specific errors.
            // return [];
        }

        // Step 5: Process sections and call AMP APIs
        console.log('Processing sections and calling AMP APIs...');
        const allMusicInfo: MusicInfo[] = [];
        const apiPromises: Promise<void>[] = [];

        for (const section of sections) {
            const processMusicItem = async (item: MusicInfo | undefined) => {
                if (item && item.albumId && item.type && !processedAlbumIdsForApiCall.has(item.albumId + '_' + item.type)) { // Add type to key for uniqueness
                    processedAlbumIdsForApiCall.add(item.albumId + '_' + item.type);
                    try {
                        const musicInfos = await this.callAMPAPI(item.albumId, storefront, item.type);
                        if (musicInfos) {
                            allMusicInfo.push(...musicInfos);
                        }
                    } catch (err) {
                         console.error(`Error in AMP API call promise for ${item.albumId} (${item.type}):`, err);
                    }
                }
            };

            if (section.topHit) {
                apiPromises.push(processMusicItem(section.topHit));
            }
            for (const item of section.items) {
                apiPromises.push(processMusicItem(item));
            }
        }
        
        console.log(`Awaiting ${apiPromises.length} AMP API call promises...`);
        await Promise.all(apiPromises);
        console.log(`All AMP API calls completed. Total MusicInfo objects found: ${allMusicInfo.length}`);
        return allMusicInfo;
    }


    public async closeBrowser(): Promise<void> {
        this.isBrowserClosing = true; // Signal that closure is intended
        if (this.browser) {
            console.log("Closing Playwright browser instance...");
            try {
                await this.browser.close();
                console.log("Playwright browser closed successfully.");
            } catch (error) {
                console.error("Error closing Playwright browser:", error);
            } finally {
                this.browser = null;
                this.page = null;
                this.initializationPromise = null; // Reset initialization promise
                this.isBrowserClosing = false; // Reset signal
            }
        } else {
            console.log("No active Playwright browser instance to close.");
        }
    }
}

// Ensure Cheerio is properly imported if not already global in this context
// import * as cheerio from 'cheerio'; // Assuming ES module syntax if run directly
// For Next.JS API routes, it's typically fine if cheerio is a dependency.

export default AppleMusicScraper;

// Example usage (for testing, not part of the API route itself)
/*
async function testScraper() {
    const scraper = AppleMusicScraper.getInstance();
    try {
        console.log("Test 1: Searching for 'Taylor Swift Lover'");
        const results1 = await scraper.findAppleMusicInfo("Taylor Swift Lover", "us");
        console.log("Results for 'Taylor Swift Lover':", JSON.stringify(results1, null, 2).substring(0, 1000) + "...");
        console.log(`Found ${results1.length} items.`);

        console.log("\\nTest 2: Searching for 'Imagine Dragons Origins'");
        const results2 = await scraper.findAppleMusicInfo("Imagine Dragons Origins", "gb");
        console.log("Results for 'Imagine Dragons Origins':", JSON.stringify(results2, null, 2).substring(0, 1000) + "...");
        console.log(`Found ${results2.length} items.`);

    } catch (error) {
        console.error("Error during scraper test:", error);
    } finally {
        await scraper.closeBrowser();
    }
}

if (require.main === module) {
    testScraper();
}
*/ 